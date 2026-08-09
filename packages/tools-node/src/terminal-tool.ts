import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { TerminalInput } from './inputs.js';
import { toolResult } from './tool-result.js';
import { resolveWorkspacePath } from './workspace-paths.js';

const DEFAULT_MAX_BYTES = 1_000_000;
const FORCE_KILL_GRACE_MS = 1_000;

type StopReason = 'cancelled' | 'timeout';

export class TerminalTool implements Tool {
  readonly definition = {
    name: 'terminal',
    description: 'Run one executable with an argument array. This tool always requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' }, default: [] },
        cwd: { type: 'string', default: '.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 120000 }
      },
      required: ['command'],
      additionalProperties: false
    }
  };

  constructor(private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = TerminalInput.parse(input);

    if (!context.approved) {
      return toolResult(false, 'Terminal execution requires approval.', { code: 'permission_denied' });
    }

    const resolved = await resolveWorkspacePath(context.workingDirectory, parsed.cwd);
    if (!resolved.inside) {
      return toolResult(false, 'Terminal cwd is outside the working directory.', { code: 'permission_denied' });
    }

    return this.run(parsed.command, parsed.args, resolved.target, parsed.timeoutMs, context);
  }

  private run(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    context: ToolContext
  ): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, args, {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let output = '';
      let capturedBytes = 0;
      let truncated = false;
      let settled = false;
      let stopReason: StopReason | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const append = (label: string, chunk: Buffer): void => {
        if (capturedBytes >= this.maxBytes) {
          truncated = true;
          return;
        }

        const remaining = this.maxBytes - capturedBytes;
        const slice = chunk.subarray(0, remaining);
        capturedBytes += slice.byteLength;
        truncated ||= slice.byteLength < chunk.byteLength;
        const text = slice.toString('utf8');
        output += label ? `[${label}] ${text}` : text;
        context.onProgress(text);
      };

      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        context.signal.removeEventListener('abort', onAbort);
      };

      const requestStop = (reason: StopReason): void => {
        if (settled || stopReason) return;
        stopReason = reason;
        this.kill(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => this.kill(child, 'SIGKILL'), FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      };

      const onAbort = (): void => requestStop('cancelled');
      const timeoutTimer = setTimeout(() => requestStop('timeout'), timeoutMs);
      timeoutTimer.unref();
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) onAbort();

      child.stdout?.on('data', (chunk: Buffer) => append('', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(toolResult(false, error.message, { code: 'spawn_failed' }));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (stopReason) {
          resolve(toolResult(false, `${output}\n[${stopReason}]`, { truncated, code: stopReason }));
          return;
        }

        const ok = code === 0;
        const truncationNotice = truncated ? '\n[output truncated]' : '';
        const exitNotice = `\n[exit ${code ?? signal ?? 'unknown'}]`;
        resolve(toolResult(ok, `${output}${truncationNotice}${exitNotice}`, ok
          ? { truncated }
          : { truncated, code: 'nonzero_exit' }));
      });
    });
  }

  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }
}

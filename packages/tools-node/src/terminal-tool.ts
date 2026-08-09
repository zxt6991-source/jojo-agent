import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import { TerminalInput } from './inputs.js';
import { toolResult } from './tool-result.js';
import { resolveWorkspacePath } from './workspace-paths.js';

const DEFAULT_MAX_BYTES = 1_000_000;
const FORCE_KILL_GRACE_MS = 1_000;
const SENSITIVE_ENV_NAME = /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/i;
const SAFE_ENV_EXCEPTIONS = new Set(['SSH_AUTH_SOCK']);
const BLOCKED_RUNTIME_ENV = new Set(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']);

type StopReason = 'cancelled' | 'timeout';

export function createTerminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || BLOCKED_RUNTIME_ENV.has(name)) continue;
    if (SENSITIVE_ENV_NAME.test(name) && !SAFE_ENV_EXCEPTIONS.has(name)) continue;
    environment[name] = value;
  }
  return environment;
}

export function redactSensitiveEnvironmentAssignments(text: string): string {
  return text.split('\n').map((line) => {
    const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(=.*)$/.exec(line);
    if (!match || !SENSITIVE_ENV_NAME.test(match[2]!) || SAFE_ENV_EXCEPTIONS.has(match[2]!)) return line;
    return `${match[1]}${match[2]}=[REDACTED]`;
  }).join('\n');
}

export class TerminalTool implements Tool {
  readonly definition = {
    name: 'terminal',
    description: 'Run one executable with an argument array. command must be only the executable name or path, for example command="pnpm", args=["test"]. Never put arguments in command. This tool always requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name or path only. Put all command-line arguments in args.' },
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
        env: createTerminalEnvironment(),
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
        const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? `Executable not found: ${command}. command must contain only the executable name or path; put every argument in args.`
          : error.message;
        resolve(toolResult(false, detail, { code: 'spawn_failed' }));
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (stopReason) {
          resolve(toolResult(false, `${redactSensitiveEnvironmentAssignments(output)}\n[${stopReason}]`, { truncated, code: stopReason }));
          return;
        }

        const ok = code === 0;
        const truncationNotice = truncated ? '\n[output truncated]' : '';
        const exitNotice = `\n[exit ${code ?? signal ?? 'unknown'}]`;
        const safeOutput = redactSensitiveEnvironmentAssignments(output);
        resolve(toolResult(ok, `${safeOutput}${truncationNotice}${exitNotice}`, ok
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

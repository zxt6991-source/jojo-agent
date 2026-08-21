import { spawn } from 'node:child_process';
import type { HookEventName, HookPayloadMap } from '@desktop-agent/contracts';
import { HookExecutionError } from './errors.js';
import { resolveConfiguredEnvironment, sanitizedHookEnvironment } from './environment.js';

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

export type ShellHookRequest<E extends HookEventName = HookEventName> = {
  command: string;
  payload: HookPayloadMap[E];
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

export type ShellHookResult = { stdout: string; stderr: string; exitCode: number | null };

function boundedTail(chunks: Buffer[], limit: number): string {
  const combined = Buffer.concat(chunks);
  return combined.subarray(Math.max(0, combined.length - limit)).toString('utf8');
}

export class ShellHookRunner {
  async run<E extends HookEventName>(request: ShellHookRequest<E>): Promise<ShellHookResult> {
    const timeoutMs = Math.min(30_000, Math.max(1, request.timeoutMs));
    return new Promise<ShellHookResult>((resolve, reject) => {
      let settled = false;
      let stdoutSize = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(request.command, {
        cwd: request.cwd,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...sanitizedHookEnvironment(),
          ...resolveConfiguredEnvironment(request.env),
          JOJO_HOOK_ACTIVE: '1',
          JOJO_HOOK_EVENT: request.payload.event
        }
      });

      const killGroup = () => {
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch { child.kill('SIGKILL'); }
      };
      const finishError = (error: HookExecutionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        killGroup();
        reject(error);
      };
      const onAbort = () => finishError(new HookExecutionError('hook_cancelled', 'Hook execution was cancelled.'));
      const timer = setTimeout(
        () => finishError(new HookExecutionError('hook_timeout', `Hook exceeded ${timeoutMs}ms timeout.`)),
        timeoutMs
      );
      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.once('error', (error) => finishError(new HookExecutionError('hook_spawn_failed', error.message)));
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutSize += chunk.length;
        if (stdoutSize > MAX_STDOUT_BYTES) {
          finishError(new HookExecutionError('hook_output_too_large', 'Hook stdout exceeded 64 KiB.'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('close', (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: boundedTail(stderr, MAX_STDERR_BYTES), exitCode });
      });
      child.stdin.once('error', () => undefined);
      child.stdin.end(JSON.stringify(request.payload));
      if (request.signal?.aborted) onAbort();
    });
  }
}

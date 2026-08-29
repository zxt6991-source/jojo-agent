import type { SecretBroker, SecretLease, Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
import {
  createProcessSandbox, createSandboxEnvironment, defaultSecretRedactorFactory, redactSecrets,
  type ProcessSandbox, type SandboxProcess, type SecretRedactorFactory, type StreamingSecretRedactor
} from '@desktop-agent/process-sandbox';
import { TerminalInput } from './inputs.js';
import { DefaultTerminalSecurityPolicy, type TerminalSecurityPolicy } from './terminal-security-policy.js';
import { toolResult } from './tool-result.js';

const DEFAULT_MAX_BYTES = 1_000_000;
const FORCE_KILL_GRACE_MS = 1_000;
type StopReason = 'cancelled' | 'timeout';

export function createTerminalEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return createSandboxEnvironment({ workingDirectory: process.cwd(), source });
}

export function redactSensitiveEnvironmentAssignments(text: string): string { return redactSecrets(text); }

export type TerminalToolOptions = {
  maxBytes?: number;
  sandbox?: ProcessSandbox;
  policy?: TerminalSecurityPolicy;
  redactors?: SecretRedactorFactory;
  secretBroker?: SecretBroker;
};

export class TerminalTool implements Tool {
  readonly replay = 'never' as const;
  readonly risk = 'external_side_effect' as const;
  readonly definition = {
    name: 'terminal',
    description: 'Run one non-interactive executable with an argument array inside the configured process sandbox. command must be only the executable name or path. stdin is unavailable, host credentials are not inherited, and HOME and temporary storage are isolated. network defaults to none; set network=host only when the task requires unrestricted outbound access. To use a named credential required by a Skill or CLI, list only its environment variable name in secretEnv; the Desktop Secret Broker injects the value after approval, so never read shell startup files or place secret values in arguments. This tool always requires user approval.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name or path only. Put all command-line arguments in args.' },
        args: { type: 'array', items: { type: 'string' }, default: [] },
        cwd: { type: 'string', default: '.' },
        network: { type: 'string', enum: ['none', 'host'], default: 'none', description: 'Use host only when unrestricted outbound network access is required.' },
        secretEnv: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, maxItems: 20, default: [], description: 'Names of secrets to inject after approval. Never include secret values.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 120000 }
      },
      required: ['command'],
      additionalProperties: false
    }
  };

  private readonly maxBytes: number;
  private readonly sandbox: ProcessSandbox;
  private readonly policy: TerminalSecurityPolicy;
  private readonly redactors: SecretRedactorFactory;
  private readonly secretBroker: SecretBroker | undefined;

  constructor(options: number | TerminalToolOptions = {}) {
    const normalized = typeof options === 'number' ? { maxBytes: options } : options;
    this.maxBytes = normalized.maxBytes ?? DEFAULT_MAX_BYTES;
    this.sandbox = normalized.sandbox ?? createProcessSandbox('fallback');
    this.policy = normalized.policy ?? new DefaultTerminalSecurityPolicy(this.sandbox, this.maxBytes);
    this.redactors = normalized.redactors ?? defaultSecretRedactorFactory;
    this.secretBroker = normalized.secretBroker;
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = TerminalInput.parse(input);
    if (!context.approved) return toolResult(false, 'Terminal execution requires approval.', { code: 'permission_denied' });
    try {
      const plan = await this.policy.plan(parsed, {
        workingDirectory: context.workingDirectory,
        ...(context.executionScope ? { executionScope: context.executionScope } : {})
      });
      const leases = await this.resolveSecrets(parsed.secretEnv, context);
      try {
        const knownSecrets = leases.map((lease) => lease.value);
        const sandboxed = await this.sandbox.spawn({
          ...plan.sandbox,
          env: {
            ...plan.sandbox.env,
            ...Object.fromEntries(parsed.secretEnv.map((name, index) => [name, leases[index]!.value]))
          }
        });
        return await this.collect(
          sandboxed,
          plan.sandbox.resources.timeoutMs,
          plan.sandbox.resources.maxOutputBytes,
          context,
          knownSecrets
        );
      } finally {
        leases.forEach((lease) => lease.dispose());
      }
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { code?: string };
      const code = value.code === 'ENOENT' ? 'sandbox_spawn_failed' : value.code ?? 'sandbox_spawn_failed';
      const detail = value.code === 'ENOENT'
        ? `Executable not found: ${parsed.command}. command must contain only the executable name or path; put every argument in args.`
        : error instanceof Error ? error.message : String(error);
      return toolResult(false, detail, { code });
    }
  }

  private async resolveSecrets(names: string[], context: ToolContext): Promise<SecretLease[]> {
    if (names.length === 0) return [];
    if (!this.secretBroker) throw Object.assign(
      new Error(`Terminal secrets are unavailable: ${names.join(', ')}. Configure them in Desktop or remove secretEnv.`),
      { code: 'terminal_secret_unavailable' }
    );
    const leases: SecretLease[] = [];
    try {
      for (const name of names) {
        leases.push(await this.secretBroker.resolve(
          { provider: 'desktop', key: name },
          { purpose: `Terminal ${name}`, sessionId: context.sessionId }
        ));
      }
      return leases;
    } catch (error) {
      leases.forEach((lease) => lease.dispose());
      throw error;
    }
  }

  private async collect(
    sandboxed: SandboxProcess,
    timeoutMs: number,
    maxBytes: number,
    context: ToolContext,
    knownSecrets: readonly string[] = []
  ): Promise<ToolResult> {
    let output = '';
    let capturedBytes = 0;
    let truncated = false;
    let stopReason: StopReason | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const stdoutRedactor = this.redactors.create(knownSecrets);
    const stderrRedactor = this.redactors.create(knownSecrets);
    const emit = (label: string, text: string): void => {
      if (!text) return;
      output += label ? `[${label}] ${text}` : text;
      context.onProgress(text);
    };
    const append = (label: string, redactor: StreamingSecretRedactor, chunk: Buffer): void => {
      if (capturedBytes >= maxBytes) { truncated = true; return; }
      const remaining = maxBytes - capturedBytes;
      const slice = chunk.subarray(0, remaining);
      capturedBytes += slice.byteLength;
      truncated ||= slice.byteLength < chunk.byteLength;
      emit(label, redactor.push(slice));
    };
    const requestStop = (reason: StopReason): void => {
      if (stopReason) return;
      stopReason = reason;
      void sandboxed.terminate();
      forceKillTimer = setTimeout(() => void sandboxed.kill(), FORCE_KILL_GRACE_MS);
      forceKillTimer.unref();
    };
    const onAbort = (): void => requestStop('cancelled');
    const timeoutTimer = setTimeout(() => requestStop('timeout'), timeoutMs);
    timeoutTimer.unref();
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    sandboxed.stdout.on('data', (chunk: Buffer) => append('', stdoutRedactor, chunk));
    sandboxed.stderr.on('data', (chunk: Buffer) => append('stderr', stderrRedactor, chunk));
    try {
      const result = await sandboxed.wait();
      emit('', stdoutRedactor.flush());
      emit('stderr', stderrRedactor.flush());
      if (stopReason) return toolResult(false, `${output}\n[${stopReason}]`, { truncated, code: stopReason });
      const ok = result.exitCode === 0;
      const truncationNotice = truncated ? '\n[output truncated]' : '';
      const exitNotice = `\n[exit ${result.exitCode ?? result.signal ?? 'unknown'}]`;
      return toolResult(ok, `${output}${truncationNotice}${exitNotice}`, ok ? { truncated } : { truncated, code: 'nonzero_exit' });
    } finally {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      context.signal.removeEventListener('abort', onAbort);
    }
  }
}

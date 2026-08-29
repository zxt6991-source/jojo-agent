import type { ExecutionScope } from '@desktop-agent/contracts';
import path from 'node:path';
import { createSandboxEnvironment, redactSecrets, type ProcessSandbox, type SandboxSpec, type SandboxStrength } from '@desktop-agent/process-sandbox';
import type { z } from 'zod';
import { TerminalInput } from './inputs.js';
import { classifyTerminalCommand } from './terminal-risk.js';
import { resolveWorkspacePath } from './workspace-paths.js';

export type TerminalCapability =
  | 'workspace:read' | 'workspace:write' | 'network:outbound' | 'process:spawn'
  | 'credential:secret' | 'credential:ssh-agent' | 'host:filesystem' | 'host:network';
export type TerminalRisk = 'medium' | 'high' | 'critical';
export type ParsedTerminalInput = z.infer<typeof TerminalInput>;

export type TerminalSecurityPlan = {
  risk: TerminalRisk;
  capabilities: TerminalCapability[];
  reasons: string[];
  sandbox: SandboxSpec;
  approval: {
    executable: string;
    argumentsPreview: string[];
    cwd: string;
    sandboxStrength: SandboxStrength;
    network: 'none' | 'host';
    secretEnv: string[];
    capabilities: TerminalCapability[];
    risk: TerminalRisk;
    reasons: string[];
  };
};

export interface TerminalSecurityPolicy {
  plan(input: ParsedTerminalInput, context: { workingDirectory: string; executionScope?: ExecutionScope }): Promise<TerminalSecurityPlan>;
}

export class DefaultTerminalSecurityPolicy implements TerminalSecurityPolicy {
  constructor(private readonly processSandbox: ProcessSandbox, private readonly maxOutputBytes = 1_000_000) {}

  async plan(input: ParsedTerminalInput, context: { workingDirectory: string; executionScope?: ExecutionScope }): Promise<TerminalSecurityPlan> {
    const resolved = await resolveWorkspacePath(context.workingDirectory, input.cwd);
    if (!resolved.inside) throw Object.assign(new Error('Terminal cwd is outside the working directory.'), { code: 'terminal_host_escape_denied' });
    const workspace = await resolveWorkspacePath(context.workingDirectory, '.');
    const classification = classifyTerminalCommand(input.command);
    const probe = await this.processSandbox.probe();
    if (!probe.available) throw Object.assign(new Error(probe.reason ?? 'Required process sandbox is unavailable.'), { code: 'sandbox_unavailable' });
    const reasons = [...classification.reasons];
    const softFallback = probe.strength === 'soft' || probe.strength === 'none';
    const capabilities = [...classification.capabilities];
    let risk = classification.risk;
    if (input.network === 'host') {
      capabilities.push('network:outbound');
      if (risk === 'medium') risk = 'high';
      reasons.push('The user-requested profile grants unrestricted outbound host network access to this process.');
    } else {
      reasons.push('Outbound network access is disabled for this process.');
    }
    if (input.secretEnv.length > 0) {
      capabilities.push('credential:secret');
      if (risk === 'medium') risk = 'high';
      reasons.push(`The process requests ${input.secretEnv.length} named secret environment variable(s).`);
    }
    if (softFallback) {
      capabilities.push('host:filesystem', 'host:network');
      if (risk === 'medium') risk = 'high';
      reasons.push('Strong sandbox unavailable: this command will execute with host-user filesystem and network privileges.');
    }
    const sandbox: SandboxSpec = {
      id: `terminal-${crypto.randomUUID()}`,
      cwd: resolved.target,
      command: input.command,
      args: [...input.args],
      env: createSandboxEnvironment({ workingDirectory: resolved.target }),
      mounts: [{ path: workspace.target, mode: 'rw' }],
      network: { mode: input.network },
      fakeHome: true,
      tmpfs: true,
      resources: { timeoutMs: input.timeoutMs, maxOutputBytes: this.maxOutputBytes }
    };
    return {
      risk,
      capabilities,
      reasons,
      sandbox,
      approval: {
        executable: input.command.slice(0, 1_000),
        argumentsPreview: approvalArguments(input.args),
        cwd: path.relative(workspace.target, resolved.target) || '.',
        sandboxStrength: probe.strength,
        network: input.network,
        secretEnv: [...input.secretEnv].sort(),
        capabilities: [...capabilities],
        risk,
        reasons
      }
    };
  }
}

function approvalArguments(args: string[]): string[] {
  let redactNext = false;
  return args.slice(0, 20).map((argument) => {
    const sensitiveFlag = /^--?(?:api-?key|authorization|token|secret|password|passwd|credential|private-?key|access-?key)(?:=|$)/iu.test(argument);
    const safe = redactNext
      ? '[REDACTED]'
      : sensitiveFlag && argument.includes('=')
        ? `${argument.slice(0, argument.indexOf('=') + 1)}[REDACTED]`
        : redactSecrets(argument).slice(0, 500);
    redactNext = sensitiveFlag && !argument.includes('=');
    return safe;
  });
}

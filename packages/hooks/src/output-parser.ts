import type { HookInjectionResult, PreToolUseHookResult } from '@desktop-agent/contracts';
import { HookInjectionResultSchema, PreToolUseHookResultSchema } from '@desktop-agent/contracts';
import { HookExecutionError } from './errors.js';
import type { ShellHookResult } from './shell-runner.js';

export function parseInjectionOutput(result: ShellHookResult): HookInjectionResult {
  if (result.exitCode !== 0) throw new HookExecutionError('hook_exit_nonzero', `Hook exited with code ${result.exitCode}.`);
  const text = result.stdout.trim();
  if (!text) return { additionalContext: '' };
  try {
    const json = JSON.parse(text) as unknown;
    const parsed = HookInjectionResultSchema.safeParse(json);
    if (!parsed.success) throw new HookExecutionError('hook_invalid_output', 'Hook returned invalid context JSON.');
    return parsed.data;
  } catch (error) {
    if (error instanceof HookExecutionError) throw error;
    return { additionalContext: text };
  }
}

export function parsePreToolOutput(result: ShellHookResult): PreToolUseHookResult {
  const text = result.stdout.trim();
  if (result.exitCode === 2) {
    if (text) {
      try {
        const parsed = PreToolUseHookResultSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.decision === 'block') return parsed.data;
      } catch { /* exit code remains authoritative */ }
    }
    return { decision: 'block', reason: result.stderr.trim() || 'Blocked by PreToolUse hook.' };
  }
  if (result.exitCode !== 0) throw new HookExecutionError('hook_exit_nonzero', `Hook exited with code ${result.exitCode}.`);
  if (!text) return { decision: 'neutral' };
  try {
    const parsed = PreToolUseHookResultSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new HookExecutionError('hook_invalid_output', 'Hook returned invalid PreToolUse JSON.');
    return parsed.data;
  } catch (error) {
    if (error instanceof HookExecutionError) throw error;
    return { decision: 'neutral' };
  }
}

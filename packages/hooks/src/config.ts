import type { HookEventName, HookFileConfig, HookSource } from '@desktop-agent/contracts';
import { HookFileConfigSchema } from '@desktop-agent/contracts';
import { parse } from 'yaml';
import { compileHookMatcher } from './matcher.js';

export const EMPTY_HOOK_CONFIG = 'version: 1\n\nhooks: {}\n';

export function parseHookDuration(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/u.exec(value.trim());
  if (!match) throw new Error(`hook_invalid_timeout: ${value}`);
  const amount = Number(match[1]);
  const milliseconds = match[2] === 's' ? amount * 1_000 : amount;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 30_000) {
    throw new Error(`hook_invalid_timeout: ${value}`);
  }
  return Math.ceil(milliseconds);
}

export function parseHookConfig(content: string, source: HookSource): HookFileConfig {
  let raw: unknown;
  try { raw = parse(content); }
  catch (error) { throw new Error(`hook_config_invalid: ${error instanceof Error ? error.message : String(error)}`); }
  const parsed = HookFileConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`hook_config_invalid: ${parsed.error.message}`);

  const ids = new Set<string>();
  for (const [event, specs] of Object.entries(parsed.data.hooks) as [HookEventName, NonNullable<HookFileConfig['hooks'][HookEventName]>][]) {
    for (const spec of specs) {
      if (ids.has(spec.id)) throw new Error(`hook_duplicate_id: ${spec.id}`);
      ids.add(spec.id);
      parseHookDuration(spec.timeout);
      if (spec.matcher !== undefined) {
        if (event !== 'PreToolUse' && event !== 'PostToolUse') throw new Error(`hook_matcher_not_supported: ${event}.${spec.id}`);
        try { compileHookMatcher(spec.matcher); }
        catch { throw new Error(`hook_invalid_matcher: ${event}.${spec.id}`); }
      }
      if (spec.async && event !== 'Stop' && event !== 'SubagentStop') {
        throw new Error(`hook_async_not_supported: ${event}.${spec.id}`);
      }
      if (spec.canApprove && (event !== 'PreToolUse' || source !== 'user')) {
        throw new Error(`hook_approval_not_allowed: ${event}.${spec.id}`);
      }
    }
  }
  return parsed.data;
}

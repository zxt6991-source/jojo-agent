import type { HookEventName, HookPayloadMap } from '@desktop-agent/contracts';

export function compileHookMatcher(source: string | undefined): RegExp | undefined {
  if (source === undefined) return undefined;
  return new RegExp(source, 'u');
}

export function hookMatches<E extends HookEventName>(
  matcher: RegExp | undefined,
  event: E,
  payload: HookPayloadMap[E]
): boolean {
  if (!matcher) return true;
  if (event !== 'PreToolUse' && event !== 'PostToolUse') return false;
  return matcher.test((payload as HookPayloadMap['PreToolUse'] | HookPayloadMap['PostToolUse']).toolName);
}

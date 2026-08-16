import type { AgentEvent, UsageTotals } from '@desktop-agent/contracts';

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
}

export function accrueUsage(total: UsageTotals, event: Extract<AgentEvent, { type: 'usage' }>): void {
  total.inputTokens += event.inputTokens ?? 0;
  total.outputTokens += event.outputTokens ?? 0;
  total.cacheReadInputTokens += event.cacheReadInputTokens ?? 0;
  total.cacheWriteInputTokens += event.cacheWriteInputTokens ?? 0;
}

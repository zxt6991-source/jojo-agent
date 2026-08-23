export type AgentStopReason =
  | 'completed'
  | 'aborted'
  | 'max_iterations'
  | 'absolute_iteration_limit'
  | 'no_progress'
  | 'loop_detected'
  | 'time_budget'
  | 'token_budget'
  | 'cost_budget'
  | 'context_budget'
  | 'tool_call_budget'
  | 'provider_error'
  | 'tool_error';

export type ProgressSignal =
  | 'new_information'
  | 'state_changed'
  | 'artifact_changed'
  | 'task_advanced'
  | 'recovery_succeeded'
  | 'none';

export type AgentLoopBudgetOptions = {
  initialIterations?: number;
  runMaxIterations?: number;
  dynamic?: boolean;
  extensionStep?: number;
  maxWallTimeMs?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  maxToolCalls?: number;
};

export type AgentLoopSafetyPolicy = {
  absoluteMaxIterations: number;
  maxCyclePeriod: number;
  requiredCycleRepeats: number;
  maxIdenticalToolCalls: number;
  maxCompactionsPerTurn: number;
  recentIterationWindow: number;
  maxPollsPerInput: number;
  maxPollDurationMs: number;
  minPollIntervalMs: number;
};

export const DEFAULT_AGENT_LOOP_SAFETY: AgentLoopSafetyPolicy = Object.freeze({
  absoluteMaxIterations: 128,
  maxCyclePeriod: 3,
  requiredCycleRepeats: 3,
  maxIdenticalToolCalls: 2,
  maxCompactionsPerTurn: 3,
  recentIterationWindow: 16,
  maxPollsPerInput: 20,
  maxPollDurationMs: 120_000,
  minPollIntervalMs: 0
});

export const DEFAULT_AGENT_LOOP_RESOURCE_BUDGET: Readonly<AgentLoopBudgetOptions> = Object.freeze({
  maxWallTimeMs: 10 * 60 * 1_000,
  maxToolCalls: 256
});

export type LoopUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  costUsd: number;
};

export type PollingCallState = {
  count: number;
  firstAt: number;
  lastAt: number;
};

export function emptyLoopUsage(): LoopUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };
}

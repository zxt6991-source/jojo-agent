const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MIN_INITIAL_ITERATIONS = 8;
const MAX_INITIAL_ITERATIONS = 16;
const MIN_HARD_ITERATIONS = 32;
const MAX_HARD_ITERATIONS = 64;

export type IterationBudgetPolicy = {
  dynamic: boolean;
  currentLimit: number;
  hardLimit: number;
  extensionStep: number;
};

export function createIterationBudgetPolicy(options: {
  maxIterations?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}): IterationBudgetPolicy {
  if (options.maxIterations !== undefined) {
    return {
      dynamic: false,
      currentLimit: options.maxIterations,
      hardLimit: options.maxIterations,
      extensionStep: 0
    };
  }

  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const usableInputTokens = Math.max(0, contextWindowTokens - maxOutputTokens);
  const currentLimit = Math.max(
    MIN_INITIAL_ITERATIONS,
    Math.min(MAX_INITIAL_ITERATIONS, Math.floor(usableInputTokens / 8_192))
  );
  const hardLimit = Math.max(
    MIN_HARD_ITERATIONS,
    Math.min(MAX_HARD_ITERATIONS, currentLimit * 4)
  );

  return {
    dynamic: true,
    currentLimit,
    hardLimit,
    extensionStep: Math.max(4, Math.floor(currentLimit / 2))
  };
}

export function extendIterationBudget(policy: IterationBudgetPolicy): IterationBudgetPolicy {
  if (!policy.dynamic || policy.currentLimit >= policy.hardLimit) return policy;
  return {
    ...policy,
    currentLimit: Math.min(policy.hardLimit, policy.currentLimit + policy.extensionStep)
  };
}

export function iterationBudgetInstruction(policy: IterationBudgetPolicy, iteration: number): string {
  const remaining = Math.max(0, policy.currentLimit - iteration);
  const boundary = policy.dynamic && policy.currentLimit < policy.hardLimit
    ? ' The budget can extend while tool results continue to make progress.'
    : '';
  return `Agent Loop budget: ${remaining} tool-capable model iteration${remaining === 1 ? '' : 's'} remain before a mandatory tool-free final response.${boundary} Batch independent tool calls. Avoid preflight checks unless required by an actual failure. With 3 or fewer remaining, prioritize completing the user-visible artifact over further investigation.`;
}

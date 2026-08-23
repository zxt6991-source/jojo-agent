import {
  DEFAULT_AGENT_LOOP_SAFETY,
  type AgentLoopBudgetOptions,
  type AgentLoopSafetyPolicy
} from './loop/types.js';

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MIN_INITIAL_ITERATIONS = 8;
const MAX_INITIAL_ITERATIONS = 16;
const MIN_RUN_ITERATIONS = 32;
const MAX_RUN_ITERATIONS = 64;

export const ABSOLUTE_MAX_ITERATIONS = DEFAULT_AGENT_LOOP_SAFETY.absoluteMaxIterations;

export type IterationBudgetPolicy = {
  dynamic: boolean;
  currentLimit: number;
  runLimit: number;
  absoluteLimit: number;
  /** Backward-compatible alias for runLimit. */
  hardLimit: number;
  extensionStep: number;
  limitReason: 'max_iterations' | 'absolute_iteration_limit';
};

type IterationBudgetInput = {
  /** Legacy fixed task budget. It is always capped by the runtime safety fuse. */
  maxIterations?: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  loopBudget?: AgentLoopBudgetOptions;
  loopSafety?: AgentLoopSafetyPolicy;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function createIterationBudgetPolicy(options: IterationBudgetInput): IterationBudgetPolicy {
  const safety = options.loopSafety ?? DEFAULT_AGENT_LOOP_SAFETY;
  const absoluteLimit = positiveInteger(safety.absoluteMaxIterations, ABSOLUTE_MAX_ITERATIONS);
  const requestedLegacyLimit = options.maxIterations;
  const budget = options.loopBudget;

  if (requestedLegacyLimit !== undefined && !budget) {
    const requested = positiveInteger(requestedLegacyLimit, 1);
    const runLimit = Math.min(requested, absoluteLimit);
    return {
      dynamic: false,
      currentLimit: runLimit,
      runLimit,
      absoluteLimit,
      hardLimit: runLimit,
      extensionStep: 0,
      limitReason: requested > absoluteLimit ? 'absolute_iteration_limit' : 'max_iterations'
    };
  }

  const contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const usableInputTokens = Math.max(0, contextWindowTokens - maxOutputTokens);
  const derivedInitial = Math.max(
    MIN_INITIAL_ITERATIONS,
    Math.min(MAX_INITIAL_ITERATIONS, Math.floor(usableInputTokens / 8_192))
  );
  const requestedRunLimit = positiveInteger(
    budget?.runMaxIterations,
    Math.max(MIN_RUN_ITERATIONS, Math.min(MAX_RUN_ITERATIONS, derivedInitial * 4))
  );
  const runLimit = Math.min(requestedRunLimit, absoluteLimit);
  const requestedInitial = positiveInteger(budget?.initialIterations, derivedInitial);
  const currentLimit = Math.min(requestedInitial, runLimit);
  const dynamic = budget?.dynamic ?? true;

  return {
    dynamic,
    currentLimit,
    runLimit,
    absoluteLimit,
    hardLimit: runLimit,
    extensionStep: dynamic
      ? positiveInteger(budget?.extensionStep, Math.max(4, Math.floor(currentLimit / 2)))
      : 0,
    limitReason: requestedRunLimit > absoluteLimit ? 'absolute_iteration_limit' : 'max_iterations'
  };
}

export function extendIterationBudget(policy: IterationBudgetPolicy): IterationBudgetPolicy {
  if (!policy.dynamic || policy.currentLimit >= policy.runLimit) return policy;
  return {
    ...policy,
    currentLimit: Math.min(policy.runLimit, policy.currentLimit + policy.extensionStep)
  };
}

export function iterationBudgetInstruction(policy: IterationBudgetPolicy, iteration: number): string {
  const remaining = Math.max(0, policy.currentLimit - iteration);
  const boundary = policy.dynamic && policy.currentLimit < policy.runLimit
    ? ` The budget can extend with meaningful progress, up to ${policy.runLimit} normal iterations.`
    : '';
  return `Agent Loop budget: ${remaining} tool-capable model iteration${remaining === 1 ? '' : 's'} remain before a mandatory tool-free final response.${boundary} The runtime safety fuse is ${policy.absoluteLimit} iterations. Batch independent tool calls. Avoid preflight checks unless required by an actual failure. With 3 or fewer remaining, prioritize completing the user-visible artifact over further investigation.`;
}

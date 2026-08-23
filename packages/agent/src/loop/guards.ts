import type { AgentStopReason, LoopUsage } from './types.js';

export type LoopFinalizationReason = Exclude<
  AgentStopReason,
  'completed' | 'aborted' | 'provider_error' | 'tool_error'
>;

export type LoopGuardDecision =
  | { action: 'continue' }
  | { action: 'extend'; newLimit: number; reason: string }
  | { action: 'finalize'; reason: LoopFinalizationReason; instruction?: string }
  | { action: 'stop'; reason: AgentStopReason };

export type LoopGuardContext = {
  iteration: number;
  currentLimit: number;
  runLimit: number;
  absoluteLimit: number;
  limitReason: 'max_iterations' | 'absolute_iteration_limit';
  dynamic: boolean;
  extensionStep: number;
  elapsedMs: number;
  madeProgress: boolean;
  recoveryStepsRemaining: number | null;
  cycleDetected: boolean;
  usage: LoopUsage;
  toolCalls: number;
  compactions: number;
  budget: {
    maxWallTimeMs?: number;
    maxTotalTokens?: number;
    maxCostUsd?: number;
    maxToolCalls?: number;
  };
  maxCompactionsPerTurn: number;
};

export interface LoopGuard {
  readonly name: string;
  check(context: LoopGuardContext): LoopGuardDecision | Promise<LoopGuardDecision>;
}

const CONTINUE: LoopGuardDecision = { action: 'continue' };

export const absoluteIterationGuard: LoopGuard = {
  name: 'absolute-iteration',
  check: (context) => context.iteration >= context.absoluteLimit
    ? { action: 'finalize', reason: 'absolute_iteration_limit' }
    : CONTINUE
};

export const resourceBudgetGuard: LoopGuard = {
  name: 'resource-budget',
  check(context) {
    if (context.budget.maxWallTimeMs !== undefined && context.elapsedMs >= context.budget.maxWallTimeMs) {
      return { action: 'finalize', reason: 'time_budget' };
    }
    if (context.budget.maxTotalTokens !== undefined && context.usage.totalTokens >= context.budget.maxTotalTokens) {
      return { action: 'finalize', reason: 'token_budget' };
    }
    if (context.budget.maxCostUsd !== undefined && context.usage.costUsd >= context.budget.maxCostUsd) {
      return { action: 'finalize', reason: 'cost_budget' };
    }
    if (context.budget.maxToolCalls !== undefined && context.toolCalls >= context.budget.maxToolCalls) {
      return { action: 'finalize', reason: 'tool_call_budget' };
    }
    if (context.compactions > context.maxCompactionsPerTurn) {
      return { action: 'finalize', reason: 'context_budget' };
    }
    return CONTINUE;
  }
};

export const noProgressGuard: LoopGuard = {
  name: 'no-progress',
  check: (context) => context.recoveryStepsRemaining === 0
    ? { action: 'finalize', reason: 'no_progress' }
    : CONTINUE
};

export const cycleGuard: LoopGuard = {
  name: 'cycle',
  check: (context) => context.cycleDetected
    ? { action: 'finalize', reason: 'loop_detected' }
    : CONTINUE
};

export const iterationBudgetGuard: LoopGuard = {
  name: 'iteration-budget',
  check(context) {
    if (context.iteration < context.currentLimit) return CONTINUE;
    if (context.dynamic && context.madeProgress && context.currentLimit < context.runLimit) {
      return {
        action: 'extend',
        newLimit: Math.min(context.runLimit, context.currentLimit + context.extensionStep),
        reason: 'meaningful progress'
      };
    }
    return { action: 'finalize', reason: context.limitReason };
  }
};

export const DEFAULT_LOOP_GUARDS: readonly LoopGuard[] = Object.freeze([
  absoluteIterationGuard,
  resourceBudgetGuard,
  noProgressGuard,
  cycleGuard,
  iterationBudgetGuard
]);

export async function evaluateLoopGuards(
  context: LoopGuardContext,
  guards: readonly LoopGuard[] = DEFAULT_LOOP_GUARDS
): Promise<LoopGuardDecision> {
  for (const guard of guards) {
    const decision = await guard.check(context);
    if (decision.action !== 'continue') return decision;
  }
  return CONTINUE;
}

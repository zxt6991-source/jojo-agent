import type {
  UsageTotals,
  WorkflowBudget,
  WorkflowStep,
  WorkflowStepBudget
} from '@desktop-agent/contracts';

export type TokenBudget = Pick<WorkflowStepBudget, 'maxInputTokens' | 'maxOutputTokens' | 'maxTotalTokens'>;

export function estimatedWorkflowCostUsd(usage: UsageTotals, budget: WorkflowBudget): number | undefined {
  if (budget.inputUsdPerMillion === undefined || budget.outputUsdPerMillion === undefined) return undefined;
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens;
  const outputTokens = usage.outputTokens + usage.cacheWriteInputTokens;
  return (inputTokens * budget.inputUsdPerMillion + outputTokens * budget.outputUsdPerMillion) / 1_000_000;
}

function tokenBudgetMessage(budget: TokenBudget, usage: UsageTotals, scope: 'Workflow' | 'Step'): string | undefined {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (budget.maxInputTokens !== undefined && usage.inputTokens >= budget.maxInputTokens) {
    return `${scope} budget exceeded: input tokens ${usage.inputTokens} >= ${budget.maxInputTokens}.`;
  }
  if (budget.maxOutputTokens !== undefined && usage.outputTokens >= budget.maxOutputTokens) {
    return `${scope} budget exceeded: output tokens ${usage.outputTokens} >= ${budget.maxOutputTokens}.`;
  }
  if (budget.maxTotalTokens !== undefined && totalTokens >= budget.maxTotalTokens) {
    return `${scope} budget exceeded: total tokens ${totalTokens} >= ${budget.maxTotalTokens}.`;
  }
  return undefined;
}

export function workflowBudgetExceeded(budget: WorkflowBudget | undefined, usage: UsageTotals): string | undefined {
  if (!budget) return undefined;
  const tokens = tokenBudgetMessage(budget, usage, 'Workflow');
  if (tokens) return tokens;
  if (budget.maxCostUsd === undefined) return undefined;
  const cost = estimatedWorkflowCostUsd(usage, budget);
  if (cost === undefined || cost < budget.maxCostUsd) return undefined;
  return `Workflow budget exceeded: estimated cost ${cost.toFixed(4)} >= ${budget.maxCostUsd} USD.`;
}

export function stepBudgetExceeded(budget: WorkflowStepBudget | undefined, usage: UsageTotals): string | undefined {
  if (!budget) return undefined;
  return tokenBudgetMessage(budget, usage, 'Step');
}

export function stepConsumesBudget(step: WorkflowStep): boolean {
  if (step.type === 'agent' || step.type === 'workflow') return true;
  return step.type === 'foreach' && step.template.type === 'agent';
}

export function agentStepBudget(step: WorkflowStep): WorkflowStepBudget | undefined {
  if (step.type === 'agent') return step.budget;
  if (step.type === 'foreach' && step.template.type === 'agent') return step.template.budget;
  return undefined;
}

export function budgetExceededMessage(input: {
  workflowBudget?: WorkflowBudget | undefined;
  stepBudget?: WorkflowStepBudget | undefined;
  workflowUsage: UsageTotals;
  stepUsage: UsageTotals;
}): string | undefined {
  return workflowBudgetExceeded(input.workflowBudget, input.workflowUsage)
    ?? stepBudgetExceeded(input.stepBudget, input.stepUsage);
}

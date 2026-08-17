import type { WorkflowArgs, WorkflowCallStep, WorkflowRunSnapshot, WorkflowStepSnapshot } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import { resolveWorkflowReference } from './data/references.js';

export const MAX_WORKFLOW_DEPTH = 3;

export function asWorkflowChildSnapshot(value: unknown): WorkflowRunSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return value as WorkflowRunSnapshot;
}

export function isWorkflowArgValueFrom(value: unknown): value is { valueFrom: string } {
  return Boolean(value && typeof value === 'object' && 'valueFrom' in value && typeof (value as { valueFrom: unknown }).valueFrom === 'string');
}

export function resolveNestedWorkflowArgs(
  step: WorkflowCallStep,
  dependencies: WorkflowStepSnapshot[],
  args: WorkflowArgs
): WorkflowArgs {
  const resolved: WorkflowArgs = {};
  for (const [name, value] of Object.entries(step.args ?? {})) {
    if (isWorkflowArgValueFrom(value)) {
      const got = resolveWorkflowReference(value.valueFrom, dependencies, args);
      if (typeof got !== 'string' && typeof got !== 'number' && typeof got !== 'boolean') {
        throw new OrchestrationError(
          'workflow_invalid_args',
          `Nested workflow arg ${name} must resolve to a string, number, or boolean.`
        );
      }
      resolved[name] = got;
      continue;
    }
    resolved[name] = value;
  }
  return resolved;
}

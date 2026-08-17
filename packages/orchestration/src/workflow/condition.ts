import type { WorkflowArgs, WorkflowConditionWhen, WorkflowStepSnapshot } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import { resolveWorkflowReference } from './data/references.js';

export function evaluateWorkflowCondition(
  when: WorkflowConditionWhen,
  dependencies: WorkflowStepSnapshot[],
  args: WorkflowArgs
): boolean {
  if (when.op === 'exists') {
    try {
      const value = resolveWorkflowReference(when.left.valueFrom, dependencies, args);
      return value !== undefined && value !== null;
    } catch (error) {
      if (error instanceof OrchestrationError && error.code === 'workflow_reference_not_found') return false;
      throw error;
    }
  }
  const left = resolveWorkflowReference(when.left.valueFrom, dependencies, args);
  const equal = valuesEqual(left, when.right);
  return when.op === 'equals' ? equal : !equal;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) return true;
  return false;
}

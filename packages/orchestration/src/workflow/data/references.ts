import type {
  WorkflowArgs,
  WorkflowStepInputs,
  WorkflowStepSnapshot
} from '@desktop-agent/contracts';
import { OrchestrationError } from '../../errors.js';

export const MAX_RESOLVED_WORKFLOW_INPUT_BYTES = 64 * 1024;

function missing(reference: string): never {
  throw new OrchestrationError('workflow_reference_not_found', `Workflow input reference was not found: ${reference}`);
}

function property(value: unknown, segment: string, reference: string): unknown {
  if (Array.isArray(value) && /^\d+$/u.test(segment)) {
    const index = Number(segment);
    return index < value.length ? value[index] : missing(reference);
  }
  if (!value || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) return missing(reference);
  return (value as Record<string, unknown>)[segment];
}

export function resolveWorkflowReference(
  reference: string,
  dependencies: WorkflowStepSnapshot[],
  args: WorkflowArgs
): unknown {
  const argument = /^\$workflow\.args\.([A-Za-z][A-Za-z0-9_-]{0,63})$/u.exec(reference);
  if (argument) {
    const name = argument[1]!;
    return Object.prototype.hasOwnProperty.call(args, name) ? args[name] : missing(reference);
  }
  const stepReference = /^\$steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.(output|structuredResult)(?:\.(.+))?$/u.exec(reference);
  if (!stepReference) throw new OrchestrationError('workflow_reference_invalid', `Invalid workflow input reference: ${reference}`);
  const dependency = dependencies.find((item) => item.id === stepReference[1]);
  if (!dependency) return missing(reference);
  let value: unknown = stepReference[2] === 'output' ? dependency.output : dependency.structuredResult;
  if (value === undefined) return missing(reference);
  const path = stepReference[3];
  if (path) {
    if (stepReference[2] === 'output') {
      throw new OrchestrationError('workflow_reference_invalid', `Raw workflow output does not support nested paths: ${reference}`);
    }
    for (const segment of path.split('.')) value = property(value, segment, reference);
  }
  return value;
}

export function resolveWorkflowStepInputs(
  step: { inputs?: WorkflowStepInputs | undefined },
  dependencies: WorkflowStepSnapshot[],
  args: WorkflowArgs
): Record<string, unknown> | undefined {
  if (!step.inputs) return undefined;
  const resolved = Object.fromEntries(Object.entries(step.inputs).map(([name, input]) => [
    name,
    resolveWorkflowReference(input.valueFrom, dependencies, args)
  ]));
  const bytes = Buffer.byteLength(JSON.stringify(resolved));
  if (bytes > MAX_RESOLVED_WORKFLOW_INPUT_BYTES) {
    throw new OrchestrationError(
      'workflow_reference_invalid',
      `Resolved workflow inputs exceed ${MAX_RESOLVED_WORKFLOW_INPUT_BYTES} bytes.`
    );
  }
  return resolved;
}

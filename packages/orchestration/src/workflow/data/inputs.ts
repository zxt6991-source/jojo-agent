import { OrchestrationError } from '../../errors.js';
import { MAX_RESOLVED_WORKFLOW_INPUT_BYTES } from './references.js';

export function mergeWorkflowToolInput(
  staticInput: Record<string, unknown> | undefined,
  resolved: Record<string, unknown> | undefined
): Record<string, unknown> {
  const merged = { ...(staticInput ?? {}), ...(resolved ?? {}) };
  const bytes = Buffer.byteLength(JSON.stringify(merged));
  if (bytes > MAX_RESOLVED_WORKFLOW_INPUT_BYTES) {
    throw new OrchestrationError(
      'workflow_reference_invalid',
      `Resolved workflow tool input exceeds ${MAX_RESOLVED_WORKFLOW_INPUT_BYTES} bytes.`
    );
  }
  return merged;
}

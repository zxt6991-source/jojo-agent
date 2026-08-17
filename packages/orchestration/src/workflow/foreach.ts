import type { WorkflowAgentStep, WorkflowForeachStep, WorkflowStepSnapshot, WorkflowToolStep } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import { emptyUsage } from '../usage.js';

export type WorkflowInstanceSnapshot = NonNullable<WorkflowStepSnapshot['instances']>[number];

export const MAX_FOREACH_ITEMS = 20;
export const MAX_FOREACH_ITEM_BYTES = 8 * 1024;

export function interpolateForeachPlaceholders(text: string, item: unknown, index: number): string {
  const rendered = text
    .replace(/\{\{index\}\}/gu, String(index))
    .replace(/\{\{item\}\}/gu, formatForeachItem(item));
  if (/\{\{/u.test(rendered)) {
    throw new OrchestrationError(
      'workflow_invalid_args',
      'Foreach tasks may only interpolate {{item}} and {{index}} after workflow inputs are applied.'
    );
  }
  return rendered;
}

export function interpolateForeachValue(value: unknown, item: unknown, index: number): unknown {
  if (typeof value === 'string') return interpolateForeachPlaceholders(value, item, index);
  if (Array.isArray(value)) return value.map((entry) => interpolateForeachValue(entry, item, index));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      interpolateForeachValue(entry, item, index)
    ]));
  }
  return value;
}

export function resolveForeachItems(value: unknown, itemLimit: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new OrchestrationError('foreach_items_invalid', 'Foreach items must resolve to an array.');
  }
  if (value.length > itemLimit) {
    throw new OrchestrationError(
      'foreach_item_limit',
      `Foreach produced ${value.length} items, which exceeds itemLimit ${itemLimit}.`
    );
  }
  return value.map((item, index) => {
    let serialized: string;
    try { serialized = JSON.stringify(item) ?? 'null'; }
    catch {
      throw new OrchestrationError('foreach_items_invalid', `Foreach item ${index} is not JSON-serializable.`);
    }
    if (Buffer.byteLength(serialized) > MAX_FOREACH_ITEM_BYTES) {
      throw new OrchestrationError(
        'foreach_items_invalid',
        `Foreach item ${index} exceeds ${MAX_FOREACH_ITEM_BYTES} bytes.`
      );
    }
    return item;
  });
}

export function buildForeachVirtualStep(parent: WorkflowForeachStep, index: number, item: unknown): WorkflowAgentStep | WorkflowToolStep {
  const id = `${parent.id}__${index}`;
  const template = parent.template;
  if (template.type === 'agent') {
    return {
      ...template,
      id,
      dependsOn: [],
      continueOnError: false,
      task: interpolateForeachPlaceholders(template.task, item, index)
    };
  }
  return {
    ...template,
    id,
    dependsOn: [],
    continueOnError: false,
    input: interpolateForeachValue(template.input, item, index) as typeof template.input
  };
}

export function createForeachInstanceSnapshot(
  parent: WorkflowForeachStep,
  index: number,
  item: unknown,
  createdAt: string,
  previous?: WorkflowInstanceSnapshot
): WorkflowInstanceSnapshot {
  if (previous?.state === 'completed') return {
    ...previous,
    item: structuredClone(previous.item),
    usage: { ...previous.usage },
    ...(previous.structuredResult !== undefined ? { structuredResult: structuredClone(previous.structuredResult) } : {})
  };
  return {
    id: `${parent.id}__${index}`,
    type: parent.template.type,
    parentId: parent.id,
    index,
    item: structuredClone(item),
    ...(parent.template.type === 'agent' ? {
      profile: parent.template.profile,
      ...(parent.template.resources ? { resourceGroup: parent.template.resources.group } : {})
    } : { tool: parent.template.tool }),
    state: 'pending',
    attempt: previous && previous.state !== 'pending' ? previous.attempt + 1 : previous?.attempt ?? 1,
    createdAt: previous?.createdAt ?? createdAt,
    incomplete: false,
    usage: previous ? { ...previous.usage } : emptyUsage()
  };
}

export function foreachStructuredResult(instances: WorkflowStepSnapshot[]): unknown[] {
  return instances.map((instance) => instance.structuredResult !== undefined ? instance.structuredResult : instance.output ?? null);
}

function formatForeachItem(item: unknown): string {
  if (typeof item === 'string') return item;
  try { return JSON.stringify(item) ?? 'null'; }
  catch { return String(item); }
}

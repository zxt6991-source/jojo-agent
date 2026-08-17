import type { WorkflowArgs, WorkflowDefinition, WorkflowInputDefinitions } from '@desktop-agent/contracts';
import { WorkflowArgsSchema } from '@desktop-agent/contracts';
import { OrchestrationError } from '../../errors.js';

const PLACEHOLDER = /\{\{inputs\.([A-Za-z][A-Za-z0-9_-]{0,63})\}\}/gu;

function argumentType(value: string | number | boolean): 'string' | 'number' | 'boolean' {
  return typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string';
}

function formatArgument(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

export function resolveWorkflowArgs(
  definitions: WorkflowInputDefinitions | undefined,
  provided: unknown
): WorkflowArgs {
  const parsed = WorkflowArgsSchema.safeParse(provided ?? {});
  if (!parsed.success) {
    throw new OrchestrationError('workflow_invalid_args', parsed.error.message, parsed.error.issues);
  }
  if (!definitions || Object.keys(definitions).length === 0) return parsed.data;

  const resolved: WorkflowArgs = {};
  for (const [name, spec] of Object.entries(definitions)) {
    if (Object.prototype.hasOwnProperty.call(parsed.data, name)) {
      const value = parsed.data[name]!;
      if (argumentType(value) !== spec.type) {
        throw new OrchestrationError(
          'workflow_invalid_args',
          `Workflow arg ${name} must be a ${spec.type}.`
        );
      }
      resolved[name] = value;
      continue;
    }
    if (spec.default !== undefined) {
      resolved[name] = spec.default;
      continue;
    }
    if (spec.required) {
      throw new OrchestrationError('workflow_invalid_args', `Missing required workflow arg: ${name}`);
    }
  }
  for (const name of Object.keys(parsed.data)) {
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
      throw new OrchestrationError('workflow_invalid_args', `Unknown workflow arg: ${name}`);
    }
  }
  return resolved;
}

export function interpolateWorkflowPlaceholders(text: string, args: WorkflowArgs): string {
  const interpolated = text.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(args, name)) {
      throw new OrchestrationError('workflow_reference_not_found', `Workflow input reference was not found: ${match}`);
    }
    return formatArgument(args[name]!);
  });
  const remaining = interpolated.replace(/\{\{(?:item|index)\}\}/gu, '');
  if (/\{\{/u.test(remaining)) {
    throw new OrchestrationError(
      'workflow_invalid_args',
      'Workflow tasks may only interpolate {{inputs.<name>}}, {{item}}, and {{index}} placeholders.'
    );
  }
  return interpolated;
}

export function materializeWorkflowDefinition(definition: WorkflowDefinition, args: WorkflowArgs): WorkflowDefinition {
  return {
    ...definition,
    steps: definition.steps.map((step) => {
      if (step.type === 'agent') return { ...step, task: interpolateWorkflowPlaceholders(step.task, args) };
      if (step.type === 'foreach' && step.template.type === 'agent') {
        return {
          ...step,
          template: { ...step.template, task: interpolateWorkflowPlaceholders(step.template.task, args) }
        };
      }
      return step;
    })
  };
}

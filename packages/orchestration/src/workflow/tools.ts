import type { Tool, ToolResult, WorkflowMemoryBinding, WorkflowRunSnapshot } from '@desktop-agent/contracts';
import { z } from 'zod';
import { orchestrationErrorCode } from '../errors.js';
import { WorkflowManager } from './manager.js';

const StartInput = z.object({
  definition: z.unknown().optional(),
  name: z.string().trim().min(1).max(64).optional(),
  args: z.unknown().optional()
}).superRefine((value, context) => {
  if ((value.definition !== undefined) === (value.name !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Provide exactly one of definition or name.' });
  }
});
const WaitInput = z.object({
  id: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000)
});
const IdInput = z.object({ id: z.string().min(1) });

export type WorkflowToolOptions = {
  providerId: string;
  model: string;
  resolveMemoryBinding?: (input: {
    sessionId: string;
    workingDirectory: string;
  }) => Promise<WorkflowMemoryBinding | undefined>;
};

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return { callId: '', ok, content: typeof content === 'string' ? content : JSON.stringify(content), ...(code ? { code } : {}) };
}

function visibleSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  if (!snapshot.incomplete || !snapshot.result) return snapshot;
  return { ...snapshot, result: `[INCOMPLETE]\n${snapshot.result}` };
}

export function createWorkflowTools(manager: WorkflowManager, options: WorkflowToolOptions): Tool[] {
const sharedStepProperties = {
  id: { type: 'string' },
  dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 16 },
  timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000 },
  continueOnError: { type: 'boolean' },
  inputs: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: { valueFrom: { type: 'string' } },
      required: ['valueFrom'],
      additionalProperties: false
    }
  },
  retry: {
    type: 'object',
    properties: {
      maxAttempts: { type: 'integer', minimum: 1, maximum: 5 },
      backoffMs: { type: 'integer', minimum: 0, maximum: 30000 },
      retryOn: {
        type: 'array', minItems: 1, maxItems: 4, uniqueItems: true,
        items: {
          type: 'string',
          enum: ['step_timeout', 'provider_timeout', 'provider_error', 'output_schema_validation_failed']
        }
      }
    },
    required: ['maxAttempts'],
    additionalProperties: false
  },
  outputSchema: { type: 'object', description: 'JSON Schema that the step output must match.' }
};

const agentStepSchema = {
  type: 'object',
  properties: {
    ...sharedStepProperties,
    type: { type: 'string', enum: ['agent'] },
    profile: { type: 'string', description: 'Registered agent profile name.' },
    model: { type: 'string', description: 'Configured model id or inherit.' },
    maxIterations: { type: 'integer', minimum: 1, maximum: 20 },
    readOnly: { type: 'boolean', description: 'May only tighten the selected profile policy.' },
    tools: {
      type: 'object',
      properties: {
        allow: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        deny: { type: 'array', items: { type: 'string' }, maxItems: 32 }
      },
      additionalProperties: false
    },
    isolation: {
      type: 'object',
      description: 'Writable agents require worktree isolation and never auto-merge.',
      properties: { type: { type: 'string', enum: ['none', 'worktree'] } },
      required: ['type'],
      additionalProperties: false
    },
    resources: {
      type: 'object',
      description: 'Named concurrency group. Agents in the same group share maxConcurrency; different groups and worktrees may run in parallel.',
      properties: {
        group: { type: 'string', description: 'Resource group name, for example main-worktree-writer.' },
        maxConcurrency: { type: 'integer', minimum: 1, maximum: 4, description: 'Default 1.' }
      },
      required: ['group'],
      additionalProperties: false
    },
    budget: {
      type: 'object',
      description: 'Step token budget checked before starting an attempt. Exhausted budget blocks with workflow_budget_exceeded.',
      properties: {
        maxInputTokens: { type: 'integer', minimum: 1, maximum: 10000000 },
        maxOutputTokens: { type: 'integer', minimum: 1, maximum: 10000000 },
        maxTotalTokens: { type: 'integer', minimum: 1, maximum: 20000000 }
      },
      additionalProperties: false
    },
    task: { type: 'string' }
  },
  required: ['id', 'type', 'task'],
  additionalProperties: false
};

const toolStepSchema = {
  type: 'object',
  properties: {
    ...sharedStepProperties,
    type: { type: 'string', enum: ['tool'] },
    tool: {
      type: 'string',
      enum: ['read_file', 'list_files', 'grep', 'glob', 'web_search', 'web_fetch'],
      description: 'Allowlisted read-only tool. Arbitrary shell and write tools are not permitted.'
    },
    input: {
      type: 'object',
      description: 'Static JSON input for the allowlisted tool. Typed step inputs overlay these values.'
    }
  },
  required: ['id', 'type', 'tool'],
  additionalProperties: false
};

const foreachAgentTemplateSchema = {
  type: 'object',
  properties: {
    timeoutMs: sharedStepProperties.timeoutMs,
    inputs: sharedStepProperties.inputs,
    retry: sharedStepProperties.retry,
    outputSchema: sharedStepProperties.outputSchema,
    type: { type: 'string', enum: ['agent'] },
    profile: { type: 'string', description: 'Registered agent profile name.' },
    model: { type: 'string', description: 'Configured model id or inherit.' },
    maxIterations: { type: 'integer', minimum: 1, maximum: 20 },
    readOnly: { type: 'boolean', description: 'May only tighten the selected profile policy.' },
    tools: agentStepSchema.properties.tools,
    isolation: agentStepSchema.properties.isolation,
    resources: agentStepSchema.properties.resources,
    budget: agentStepSchema.properties.budget,
    task: { type: 'string' }
  },
  required: ['type', 'task'],
  additionalProperties: false
};

const foreachToolTemplateSchema = {
  type: 'object',
  properties: {
    timeoutMs: sharedStepProperties.timeoutMs,
    inputs: sharedStepProperties.inputs,
    retry: sharedStepProperties.retry,
    outputSchema: sharedStepProperties.outputSchema,
    type: { type: 'string', enum: ['tool'] },
    tool: toolStepSchema.properties.tool,
    input: toolStepSchema.properties.input
  },
  required: ['type', 'tool'],
  additionalProperties: false
};

const foreachStepSchema = {
  type: 'object',
  properties: {
    ...sharedStepProperties,
    type: { type: 'string', enum: ['foreach'] },
    items: {
      type: 'object',
      description: 'Must reference a direct dependency array, typically $steps.<id>.structuredResult.<field>.',
      properties: { valueFrom: { type: 'string' } },
      required: ['valueFrom'],
      additionalProperties: false
    },
    itemLimit: { type: 'integer', minimum: 1, maximum: 20, description: 'Fail the step when the resolved array is longer. Default 8.' },
    concurrency: { type: 'integer', minimum: 1, maximum: 4, description: 'In-foreach parallelism, also capped by workflow maxConcurrency. Default 2.' },
    template: {
      description: 'Agent or allowlisted tool template. Nested foreach is not permitted.',
      oneOf: [foreachAgentTemplateSchema, foreachToolTemplateSchema]
    }
  },
  required: ['id', 'type', 'items', 'template'],
  additionalProperties: false
};

const controlStepProperties = {
  id: sharedStepProperties.id,
  dependsOn: sharedStepProperties.dependsOn,
  timeoutMs: sharedStepProperties.timeoutMs,
  continueOnError: sharedStepProperties.continueOnError
};

const conditionStepSchema = {
  type: 'object',
  properties: {
    ...controlStepProperties,
    type: { type: 'string', enum: ['condition'] },
    when: {
      type: 'object',
      description: 'Declarative predicate. Only equals, notEquals, and exists are allowed; no eval.',
      properties: {
        op: { type: 'string', enum: ['equals', 'notEquals', 'exists'] },
        left: {
          type: 'object',
          properties: { valueFrom: { type: 'string' } },
          required: ['valueFrom'],
          additionalProperties: false
        },
        right: { type: ['string', 'number', 'boolean'], description: 'Literal operand for equals/notEquals.' }
      },
      required: ['op', 'left'],
      additionalProperties: false
    },
    then: { type: 'array', items: { type: 'string' }, maxItems: 16 },
    else: { type: 'array', items: { type: 'string' }, maxItems: 16 }
  },
  required: ['id', 'type', 'when'],
  additionalProperties: false
};

const workflowCallStepSchema = {
  type: 'object',
  properties: {
    ...controlStepProperties,
    type: { type: 'string', enum: ['workflow'] },
    name: { type: 'string', description: 'Saved workflow name (project > user > builtin). Nested depth is capped at 3.' },
    args: {
      type: 'object',
      maxProperties: 32,
      additionalProperties: {
        oneOf: [
          { type: ['string', 'number', 'boolean'] },
          {
            type: 'object',
            properties: { valueFrom: { type: 'string' } },
            required: ['valueFrom'],
            additionalProperties: false
          }
        ]
      }
    }
  },
  required: ['id', 'type', 'name'],
  additionalProperties: false
};

const definitionSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', enum: [1] },
    name: { type: 'string' },
    description: { type: 'string' },
    inputs: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['string', 'number', 'boolean'] },
          required: { type: 'boolean' },
          default: { type: ['string', 'number', 'boolean'] },
          description: { type: 'string' }
        },
        required: ['type'],
        additionalProperties: false
      }
    },
    maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 },
    timeoutMs: { type: 'integer', minimum: 5000, maximum: 1800000 },
    budget: {
      type: 'object',
      description: 'Workflow token and optional USD budget checked before starting the next consuming step.',
      properties: {
        maxInputTokens: { type: 'integer', minimum: 1, maximum: 10000000 },
        maxOutputTokens: { type: 'integer', minimum: 1, maximum: 10000000 },
        maxTotalTokens: { type: 'integer', minimum: 1, maximum: 20000000 },
        maxCostUsd: { type: 'number', exclusiveMinimum: 0, maximum: 10000 },
        inputUsdPerMillion: { type: 'number', minimum: 0, maximum: 1000 },
        outputUsdPerMillion: { type: 'number', minimum: 0, maximum: 1000 }
      },
      additionalProperties: false
    },
    outputStepId: { type: 'string' },
    steps: {
      type: 'array', minItems: 1, maxItems: 32,
      items: { oneOf: [agentStepSchema, toolStepSchema, foreachStepSchema, conditionStepSchema, workflowCallStepSchema] }
    }
  },
  required: ['schemaVersion', 'name', 'steps'],
  additionalProperties: false
};
  return [
    {
      replay: 'never',
      definition: {
        name: 'workflow_start',
        description: 'Start a validated declarative DAG of agent, allowlisted read-only tool, foreach, condition, and nested saved-workflow steps. Pass either an inline definition or a saved workflow name (project > user > builtin), plus optional bounded args. Returns immediately with a workflow id.',
        inputSchema: {
          type: 'object',
          properties: {
            definition: { oneOf: [definitionSchema, { type: 'string', maxLength: 120000 }] },
            name: { type: 'string', description: 'Saved workflow name. Mutually exclusive with definition.' },
            args: {
              type: 'object',
              maxProperties: 32,
              additionalProperties: { type: ['string', 'number', 'boolean'] }
            }
          },
          additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = StartInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const memory = await options.resolveMemoryBinding?.({
            sessionId: context.sessionId,
            workingDirectory: context.workingDirectory
          });
          const workflow = manager.start({
            sessionId: context.sessionId,
            workingDirectory: context.workingDirectory,
            providerId: options.providerId,
            model: options.model,
            ...(memory ? { memory } : {}),
            ...(parsed.data.args !== undefined ? { args: parsed.data.args } : {}),
            ...(parsed.data.definition !== undefined ? { definition: parsed.data.definition } : {}),
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {})
          });
          return result(true, { id: workflow.id, state: workflow.state, name: workflow.name });
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'workflow_start_failed'));
        }
      }
    },
    {
      replay: 'safe',
      repeatPolicy: 'polling',
      definition: {
        name: 'workflow_wait',
        description: 'Wait for a workflow to finish, or return its current snapshot when the wait timeout expires.',
        inputSchema: {
          type: 'object', properties: { id: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 } },
          required: ['id'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = WaitInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const workflow = await manager.wait(parsed.data.id, context.signal, parsed.data.timeoutMs);
          return result(true, visibleSnapshot(workflow));
        } catch (error) {
          if (context.signal.aborted) throw error;
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'workflow_wait_failed'));
        }
      }
    },
    {
      replay: 'safe',
      repeatPolicy: 'polling',
      definition: {
        name: 'workflow_status',
        description: 'Get the latest workflow and step states, outputs, errors, and usage.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        const workflow = manager.get(parsed.data.id);
        return workflow ? result(true, visibleSnapshot(workflow)) : result(false, `Workflow not found: ${parsed.data.id}`, 'workflow_not_found');
      }
    },
    {
      replay: 'never',
      definition: {
        name: 'workflow_cancel',
        description: 'Cancel a running workflow and propagate cancellation to every queued or running step.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          return result(true, visibleSnapshot(manager.cancel(parsed.data.id)));
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'workflow_cancel_failed'));
        }
      }
    },
    {
      replay: 'never',
      definition: {
        name: 'workflow_resume',
        description: 'Resume an interrupted or failed persisted workflow without rerunning completed steps.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          return result(true, visibleSnapshot(manager.resume(parsed.data.id)));
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'workflow_resume_failed'));
        }
      }
    },
    {
      replay: 'safe',
      definition: {
        name: 'workflow_list',
        description: 'List saved workflows available for this working directory (project overrides user overrides builtin). Includes name, source, description, and declared inputs.',
        inputSchema: { type: 'object', additionalProperties: false }
      },
      execute: async (_input, context) => result(true, manager.listSaved(context.workingDirectory))
    }
  ];
}

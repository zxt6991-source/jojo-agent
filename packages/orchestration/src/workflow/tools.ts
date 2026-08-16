import type { Tool, ToolResult, WorkflowRunSnapshot } from '@desktop-agent/contracts';
import { z } from 'zod';
import { orchestrationErrorCode } from '../errors.js';
import { WorkflowManager } from './manager.js';

const StartInput = z.object({ definition: z.unknown(), args: z.unknown().optional() });
const WaitInput = z.object({
  id: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000)
});
const IdInput = z.object({ id: z.string().min(1) });

export type WorkflowToolOptions = { providerId: string; model: string };

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return { callId: '', ok, content: typeof content === 'string' ? content : JSON.stringify(content), ...(code ? { code } : {}) };
}

function visibleSnapshot(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  if (!snapshot.incomplete || !snapshot.result) return snapshot;
  return { ...snapshot, result: `[INCOMPLETE]\n${snapshot.result}` };
}

export function createWorkflowTools(manager: WorkflowManager, options: WorkflowToolOptions): Tool[] {
  const definitionSchema = {
    type: 'object',
    properties: {
      schemaVersion: { type: 'integer', enum: [1] },
      name: { type: 'string' },
      description: { type: 'string' },
      maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 },
      timeoutMs: { type: 'integer', minimum: 5000, maximum: 1800000 },
      outputStepId: { type: 'string' },
      steps: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' }, type: { type: 'string', enum: ['agent'] },
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
            task: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' }, maxItems: 16 },
            timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000 },
            continueOnError: { type: 'boolean' },
            outputSchema: { type: 'object', description: 'JSON Schema that the step output must match.' }
          },
          required: ['id', 'type', 'task'], additionalProperties: false
        }
      }
    },
    required: ['schemaVersion', 'name', 'steps'],
    additionalProperties: false
  };
  return [
    {
      definition: {
        name: 'workflow_start',
        description: 'Start a validated declarative agent DAG from a JSON object or serialized JSON/YAML, with optional bounded runtime args. Returns immediately with a workflow id.',
        inputSchema: {
          type: 'object',
          properties: {
            definition: { oneOf: [definitionSchema, { type: 'string', maxLength: 120000 }] },
            args: {
              type: 'object',
              maxProperties: 32,
              additionalProperties: { type: ['string', 'number', 'boolean'] }
            }
          },
          required: ['definition'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = StartInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const workflow = manager.start({
            sessionId: context.sessionId,
            workingDirectory: context.workingDirectory,
            providerId: options.providerId,
            model: options.model,
            ...(parsed.data.args !== undefined ? { args: parsed.data.args } : {}),
            definition: parsed.data.definition
          });
          return result(true, { id: workflow.id, state: workflow.state, name: workflow.name });
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'workflow_start_failed'));
        }
      }
    },
    {
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
    }
  ];
}

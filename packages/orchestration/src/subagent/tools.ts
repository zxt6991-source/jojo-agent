import type { SubAgentSnapshot, Tool, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import { orchestrationErrorCode } from '../errors.js';
import { SubAgentManager } from './manager.js';

const ToolPolicyInput = z.object({
  allow: z.array(z.string().min(1).max(64)).max(32).optional(),
  deny: z.array(z.string().min(1).max(64)).max(32).optional()
});
const StartInput = z.object({
  task: z.string().trim().min(1).max(40_000),
  label: z.string().trim().min(1).max(120).optional(),
  profile: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/u).default('explore'),
  model: z.string().trim().min(1).max(200).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  tools: ToolPolicyInput.optional(),
  readOnly: z.boolean().optional(),
  isolation: z.object({ type: z.enum(['none', 'worktree']) }).optional(),
  resources: z.object({
    group: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    maxConcurrency: z.number().int().min(1).max(4).default(1)
  }).strict().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
});
const WaitInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000)
});
const IdInput = z.object({ id: z.string().min(1) });
const SendInput = z.object({ id: z.string().min(1), message: z.string().trim().min(1).max(40_000) });

export type SubAgentToolOptions = { providerId: string; model: string };

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return { callId: '', ok, content: typeof content === 'string' ? content : JSON.stringify(content), ...(code ? { code } : {}) };
}

function visibleSnapshot(snapshot: SubAgentSnapshot): SubAgentSnapshot {
  if (!snapshot.incomplete || !snapshot.result) return snapshot;
  return { ...snapshot, result: `[INCOMPLETE]\n${snapshot.result}` };
}

export function createSubAgentTools(manager: SubAgentManager, options: SubAgentToolOptions): Tool[] {
  return [
    {
      definition: {
        name: 'sub_agent_start',
        description: 'Start a background leaf agent using a registered profile and an optional stricter tool policy. The task must be self-contained.',
        inputSchema: {
          type: 'object', properties: {
            task: { type: 'string' }, label: { type: 'string' }, profile: { type: 'string' }, model: { type: 'string' },
            maxIterations: { type: 'integer', minimum: 1, maximum: 20 },
            timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000 }, readOnly: { type: 'boolean' },
            isolation: {
              type: 'object',
              description: 'Writable agents require worktree isolation. Read-only agents default to none.',
              properties: { type: { type: 'string', enum: ['none', 'worktree'] } },
              required: ['type'], additionalProperties: false
            },
            resources: {
              type: 'object',
              description: 'Named concurrency group shared with workflow agent steps. Same group is limited by maxConcurrency.',
              properties: {
                group: { type: 'string' },
                maxConcurrency: { type: 'integer', minimum: 1, maximum: 4 }
              },
              required: ['group'], additionalProperties: false
            },
            outputSchema: { type: 'object', description: 'JSON Schema that the final agent output must match.' },
            tools: {
              type: 'object', properties: {
                allow: { type: 'array', items: { type: 'string' }, maxItems: 32 },
                deny: { type: 'array', items: { type: 'string' }, maxItems: 32 }
              }, additionalProperties: false
            }
          }, required: ['task'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = StartInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const snapshot = manager.start({
            sessionId: context.sessionId,
            workingDirectory: context.workingDirectory,
            task: parsed.data.task,
            ...(parsed.data.label ? { label: parsed.data.label } : {}),
            profile: parsed.data.profile,
            providerId: options.providerId,
            model: parsed.data.model ?? options.model,
            ...(parsed.data.maxIterations !== undefined ? { maxIterations: parsed.data.maxIterations } : {}),
            ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
            ...(parsed.data.tools ? { tools: {
              ...(parsed.data.tools.allow ? { allow: parsed.data.tools.allow } : {}),
              ...(parsed.data.tools.deny ? { deny: parsed.data.tools.deny } : {})
            } } : {}),
            ...(parsed.data.readOnly !== undefined ? { readOnly: parsed.data.readOnly } : {}),
            ...(parsed.data.isolation ? { isolation: parsed.data.isolation } : {}),
            ...(parsed.data.resources ? { resources: parsed.data.resources } : {}),
            ...(parsed.data.outputSchema ? { outputSchema: parsed.data.outputSchema } : {}),
            depth: 0
          });
          return result(true, { id: snapshot.id, state: snapshot.state, label: snapshot.label });
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'subagent_start_failed'));
        }
      }
    },
    {
      definition: {
        name: 'sub_agent_wait',
        description: 'Wait for several background sub-agents together, or return their current states when the wait timeout expires.',
        inputSchema: {
          type: 'object', properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }
          }, required: ['ids'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = WaitInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const agents = await manager.wait(parsed.data.ids, context.signal, parsed.data.timeoutMs);
          return result(true, {
            completed: agents.every((agent) => ['idle', 'completed', 'failed', 'cancelled', 'timed_out', 'closed'].includes(agent.state)),
            agents: agents.map(visibleSnapshot)
          });
        } catch (error) {
          if (context.signal.aborted) throw error;
          return result(false, error instanceof Error ? error.message : String(error), 'subagent_wait_failed');
        }
      }
    },
    {
      definition: {
        name: 'sub_agent_status',
        description: 'Get the current state and final result of one background sub-agent.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        const snapshot = manager.get(parsed.data.id);
        return snapshot ? result(true, visibleSnapshot(snapshot)) : result(false, `Sub-agent not found: ${parsed.data.id}`, 'subagent_not_found');
      }
    },
    {
      definition: {
        name: 'sub_agent_cancel',
        description: 'Cancel a queued or running background sub-agent. This operation is idempotent.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        const snapshot = manager.cancel(parsed.data.id);
        return snapshot ? result(true, visibleSnapshot(snapshot)) : result(false, `Sub-agent not found: ${parsed.data.id}`, 'subagent_not_found');
      }
    },
    {
      definition: {
        name: 'sub_agent_send',
        description: 'Send a follow-up message to an idle continuable sub-agent while preserving its context.',
        inputSchema: {
          type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' } },
          required: ['id', 'message'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = SendInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try { return result(true, visibleSnapshot(manager.send(parsed.data.id, parsed.data.message))); }
        catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'subagent_continue_failed'));
        }
      }
    },
    {
      definition: {
        name: 'sub_agent_close',
        description: 'Permanently close an idle sub-agent and release its continuation context.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }
      },
      execute: async (input) => {
        const parsed = IdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try { return result(true, visibleSnapshot(await manager.close(parsed.data.id))); }
        catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'subagent_close_failed'));
        }
      }
    }
  ];
}

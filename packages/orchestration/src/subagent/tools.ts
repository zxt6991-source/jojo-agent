import type { SubAgentSnapshot, Tool, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import { SubAgentManager } from './manager.js';

const StartInput = z.object({
  task: z.string().trim().min(1).max(40_000),
  label: z.string().trim().min(1).max(120).optional(),
  profile: z.literal('explore').default('explore'),
  timeoutMs: z.number().int().min(5_000).max(300_000).default(120_000)
});
const WaitInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000)
});
const IdInput = z.object({ id: z.string().min(1) });

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
        description: 'Start a read-only background sub-agent. The task must be self-contained. Returns immediately with an id.',
        inputSchema: {
          type: 'object', properties: {
            task: { type: 'string' }, label: { type: 'string' }, profile: { type: 'string', enum: ['explore'] },
            timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000 }
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
            model: options.model,
            timeoutMs: parsed.data.timeoutMs,
            depth: 0
          });
          return result(true, { id: snapshot.id, state: snapshot.state, label: snapshot.label });
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), 'subagent_start_failed');
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
            completed: agents.every((agent) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(agent.state)),
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
    }
  ];
}

import type { Tool, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import { orchestrationErrorCode } from '../errors.js';
import { TeamManager } from './manager.js';

const TeamIdInput = z.object({ teamId: z.string().min(1).max(128) }).strict();
const DelegateInput = TeamIdInput.extend({
  memberId: z.string().min(1).max(128),
  task: z.string().trim().min(1).max(40_000),
  timeoutMs: z.number().int().min(5_000).max(300_000).optional(),
  maxIterations: z.number().int().min(1).max(20).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional()
}).strict();
const WaitInput = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(8),
  timeoutMs: z.number().int().min(100).max(120_000).default(60_000)
}).strict();
const SendInput = TeamIdInput.extend({
  memberId: z.string().min(1).max(128),
  message: z.string().trim().min(1).max(40_000),
  kind: z.enum(['note', 'question']).default('note'),
  subject: z.string().max(500).optional()
}).strict();
const InboxInput = TeamIdInput.extend({
  memberId: z.string().min(1).max(128).optional(),
  includeRead: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  markRead: z.boolean().default(false)
}).strict();

export type TeamToolOptions = { providerId: string; model: string };

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return {
    callId: '',
    ok,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    ...(code ? { code } : {})
  };
}

function failure(error: unknown, fallback: string): ToolResult {
  return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, fallback));
}

export function createTeamTools(manager: TeamManager, options: TeamToolOptions): Tool[] {
  return [
    {
      replay: 'safe',
      definition: {
        name: 'team_list',
        description: 'List persistent agent teams bound to the current workspace.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      execute: async (_input, context) => result(true, {
        teams: (await manager.list(context.workingDirectory)).map((team) => ({
          id: team.id,
          name: team.name,
          members: team.members.map((member) => ({ id: member.id, name: member.name, state: member.state }))
        }))
      })
    },
    {
      replay: 'safe',
      repeatPolicy: 'polling',
      definition: {
        name: 'team_status',
        description: 'Get member states, active and queued tasks, recent results, and unread message count for a team.',
        inputSchema: {
          type: 'object', properties: { teamId: { type: 'string' } }, required: ['teamId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = TeamIdInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try { return result(true, await manager.status(parsed.data.teamId)); }
        catch (error) { return failure(error, 'team_status_failed'); }
      }
    },
    {
      replay: 'never',
      definition: {
        name: 'team_delegate',
        description: 'Delegate a task asynchronously to one persistent team member. Tasks for the same member are serialized.',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string' }, memberId: { type: 'string' }, task: { type: 'string' },
            timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000 },
            maxIterations: { type: 'integer', minimum: 1, maximum: 20 },
            outputSchema: { type: 'object' }
          },
          required: ['teamId', 'memberId', 'task'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = DelegateInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const task = await manager.delegate({
            teamId: parsed.data.teamId,
            memberId: parsed.data.memberId,
            task: parsed.data.task,
            parent: { sessionId: context.sessionId },
            providerId: options.providerId,
            model: options.model,
            ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
            ...(parsed.data.maxIterations !== undefined ? { maxIterations: parsed.data.maxIterations } : {}),
            ...(parsed.data.outputSchema ? { outputSchema: parsed.data.outputSchema } : {})
          });
          return result(true, { taskId: task.id, state: task.state });
        } catch (error) { return failure(error, 'team_delegate_failed'); }
      }
    },
    {
      replay: 'safe',
      repeatPolicy: 'polling',
      definition: {
        name: 'team_wait',
        description: 'Wait for several delegated team tasks, or return their current states when the timeout expires.',
        inputSchema: {
          type: 'object',
          properties: {
            taskIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }
          },
          required: ['taskIds'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = WaitInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const tasks = await manager.wait(parsed.data.taskIds, context.signal, parsed.data.timeoutMs);
          return result(true, {
            completed: tasks.every((task) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.state)),
            tasks
          });
        } catch (error) {
          if (context.signal.aborted) throw error;
          return failure(error, 'team_wait_failed');
        }
      }
    },
    {
      replay: 'never',
      definition: {
        name: 'team_send',
        description: 'Write a durable note or question to a team member inbox without waking that member.',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string' }, memberId: { type: 'string' }, message: { type: 'string' },
            kind: { type: 'string', enum: ['note', 'question'] }, subject: { type: 'string' }
          },
          required: ['teamId', 'memberId', 'message'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = SendInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const message = await manager.sendMessage({
            teamId: parsed.data.teamId,
            memberId: parsed.data.memberId,
            message: parsed.data.message,
            kind: parsed.data.kind,
            ...(parsed.data.subject ? { subject: parsed.data.subject } : {})
          });
          return result(true, message);
        } catch (error) { return failure(error, 'team_send_failed'); }
      }
    },
    {
      replay: 'safe',
      definition: {
        name: 'team_inbox',
        description: 'Read durable team inbox messages. Reading does not execute or wake a member.',
        inputSchema: {
          type: 'object',
          properties: {
            teamId: { type: 'string' }, memberId: { type: 'string' }, includeRead: { type: 'boolean' },
            limit: { type: 'integer', minimum: 1, maximum: 100 }, markRead: { type: 'boolean' }
          },
          required: ['teamId'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = InboxInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const messages = await manager.listInbox({
            teamId: parsed.data.teamId,
            ...(parsed.data.memberId ? { memberId: parsed.data.memberId } : {}),
            includeRead: parsed.data.includeRead,
            limit: parsed.data.limit
          });
          if (parsed.data.markRead) await Promise.all(messages.map((message) => manager.markMessageRead(message.id)));
          return result(true, { messages });
        } catch (error) { return failure(error, 'team_inbox_failed'); }
      }
    }
  ];
}

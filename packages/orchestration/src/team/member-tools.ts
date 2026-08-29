import type { Tool, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import { orchestrationErrorCode } from '../errors.js';
import { TeamManager } from './manager.js';

const SendInput = z.object({
  memberId: z.string().min(1).max(128),
  message: z.string().trim().min(1).max(40_000),
  kind: z.enum(['note', 'question']).default('note'),
  subject: z.string().max(500).optional()
}).strict();
const InboxInput = z.object({
  includeRead: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  markRead: z.boolean().default(false)
}).strict();

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return { callId: '', ok, content: typeof content === 'string' ? content : JSON.stringify(content), ...(code ? { code } : {}) };
}

export function createTeamMemberTools(
  manager: TeamManager,
  identity: { teamId: string; memberId: string; taskId?: string }
): Tool[] {
  return [
    {
      replay: 'never',
      definition: {
        name: 'team_send',
        description: 'Send a durable note or question to a peer in your team. This does not wake the recipient.',
        inputSchema: {
          type: 'object', properties: {
            memberId: { type: 'string' }, message: { type: 'string' },
            kind: { type: 'string', enum: ['note', 'question'] }, subject: { type: 'string' }
          }, required: ['memberId', 'message'], additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = SendInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          return result(true, await manager.sendMessage({
            teamId: identity.teamId,
            memberId: parsed.data.memberId,
            message: parsed.data.message,
            kind: parsed.data.kind,
            ...(parsed.data.subject ? { subject: parsed.data.subject } : {}),
            ...(identity.taskId ? { taskId: identity.taskId } : {}),
            sender: { kind: 'team_member', id: identity.memberId }
          }));
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'team_send_failed'));
        }
      }
    },
    {
      replay: 'safe',
      definition: {
        name: 'team_inbox',
        description: 'Read your own durable team inbox. Reading messages does not wake any member.',
        inputSchema: {
          type: 'object', properties: {
            includeRead: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
            markRead: { type: 'boolean' }
          }, additionalProperties: false
        }
      },
      execute: async (input) => {
        const parsed = InboxInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          const messages = await manager.listInbox({
            teamId: identity.teamId,
            memberId: identity.memberId,
            includeRead: parsed.data.includeRead,
            limit: parsed.data.limit
          });
          if (parsed.data.markRead) await Promise.all(messages.map((message) => manager.markMessageRead(message.id)));
          return result(true, { messages });
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), orchestrationErrorCode(error, 'team_inbox_failed'));
        }
      }
    }
  ];
}

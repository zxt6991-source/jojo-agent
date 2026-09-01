import type { Tool, ToolResult } from '@desktop-agent/contracts';
import { z } from 'zod';
import type { ChannelService } from '../service.js';

const SendInput = z.object({
  target: z.union([
    z.object({ bindingId: z.string().min(1).max(256) }).strict(),
    z.object({ instanceId: z.string().min(1).max(256), conversationId: z.string().min(1).max(512), threadId: z.string().max(512).optional() }).strict(),
    z.literal('current')
  ]),
  text: z.string().min(1).max(100_000),
  replyTo: z.string().max(512).optional()
}).strict();

function result(ok: boolean, content: unknown, code?: string): ToolResult {
  return { callId: '', ok, content: typeof content === 'string' ? content : JSON.stringify(content), ...(code ? { code } : {}) };
}

function code(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/^([a-z0-9_]+):/u)?.[1] ?? 'channel_failed';
}

export function createChannelTools(service: ChannelService): Tool[] {
  return [
    {
      replay: 'safe', repeatPolicy: 'idempotent-observation', risk: 'read', effects: ['channel.read'],
      definition: {
        name: 'channel_list_targets',
        description: 'List enabled Jojo Channel targets, including bound Feishu/Lark and Telegram conversations. Use this before channel_send when the user asks to send through a configured Jojo Channel.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      execute: async () => {
        const instances = new Map((await service.listInstances()).map((instance) => [instance.id, instance]));
        return result(true, {
          targets: (await service.listBindings()).filter((binding) => binding.policy.enabled).map((binding) => {
            const instance = instances.get(binding.instanceId);
            return {
              bindingId: binding.id,
              instanceId: binding.instanceId,
              channelKind: instance?.kind ?? null,
              instanceName: instance?.name ?? null,
              conversationId: binding.conversation.id,
              conversationType: binding.conversation.type,
              threadId: binding.conversation.threadId ?? null,
              sessionId: binding.routing.sessionId ?? null
            };
          })
        });
      }
    },
    {
      replay: 'never', repeatPolicy: 'bounded', risk: 'external_side_effect', effects: ['channel.send'],
      definition: {
        name: 'channel_send',
        description: 'Send a proactive message through a configured Jojo Channel binding, including Feishu/Lark or Telegram. Prefer this over lark-im/lark-cli when the user asks to send to an already bound Jojo Channel. This is an external side effect.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              oneOf: [
                { type: 'string', enum: ['current'] },
                { type: 'object', properties: { bindingId: { type: 'string' } }, required: ['bindingId'], additionalProperties: false },
                { type: 'object', properties: { instanceId: { type: 'string' }, conversationId: { type: 'string' }, threadId: { type: 'string' } }, required: ['instanceId', 'conversationId'], additionalProperties: false }
              ]
            },
            text: { type: 'string' }, replyTo: { type: 'string' }
          },
          required: ['target', 'text'], additionalProperties: false
        }
      },
      execute: async (input, context) => {
        const parsed = SendInput.safeParse(input);
        if (!parsed.success) return result(false, parsed.error.message, 'invalid_input');
        try {
          let bindingId: string | undefined;
          let target: { instanceId: string; conversationId: string; threadId?: string } | undefined;
          if (parsed.data.target === 'current') {
            const current = (await service.listBindings()).find((binding) => binding.routing.sessionId === context.sessionId && binding.policy.enabled);
            if (!current) throw new Error('channel_current_target_not_found');
            bindingId = current.id;
          } else if ('bindingId' in parsed.data.target) bindingId = parsed.data.target.bindingId;
          else target = {
            instanceId: parsed.data.target.instanceId,
            conversationId: parsed.data.target.conversationId,
            ...(parsed.data.target.threadId ? { threadId: parsed.data.target.threadId } : {})
          };
          const receipt = await service.deliver({
            ...(bindingId ? { bindingId } : {}), ...(target ? { target } : {}),
            content: [{ type: 'markdown', text: parsed.data.text }],
            ...(parsed.data.replyTo ? { replyTo: parsed.data.replyTo } : {}),
            mode: 'proactive'
          });
          return result(true, receipt);
        } catch (error) {
          return result(false, error instanceof Error ? error.message : String(error), code(error));
        }
      }
    }
  ];
}

import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelInboundEvent, ChannelInstance } from '@desktop-agent/channel-core';
import { TelegramChannelAdapter, createTelegramAdapterFactory } from '../src/index.js';

const now = '2026-08-30T00:00:00.000Z';

function instance(config: Record<string, unknown> = {}): ChannelInstance {
  return {
    id: 'telegram-personal', kind: 'telegram', name: 'Telegram Personal', enabled: true,
    config, secretRefs: { botToken: 'secret://channels/telegram/personal/token' },
    revision: 1, fingerprint: 'fp', createdAt: now, updatedAt: now
  };
}

function json(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, result }), {
    status, headers: { 'content-type': 'application/json' }
  });
}

function pending(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('test_timeout');
}

describe('TelegramChannelAdapter', () => {
  it('normalizes polling messages and button callbacks without exposing native payloads', async () => {
    let polls = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/getMe')) return json({ id: 99, is_bot: true, first_name: 'Jojo', username: 'jojo_bot' });
      if (url.endsWith('/getUpdates')) {
        polls += 1;
        if (polls === 1) return json([
          {
            update_id: 10,
            message: {
              message_id: 20, message_thread_id: 7, date: 1_787_992_800,
              chat: { id: -100, type: 'supergroup' },
              from: { id: 42, first_name: 'Jojo User' },
              text: '@jojo_bot hello', entities: [{ type: 'mention', offset: 0, length: 9 }]
            }
          },
          {
            update_id: 11,
            callback_query: {
              id: 'callback', data: 'act_secure', from: { id: 42, first_name: 'Jojo User' },
              message: { message_id: 21, date: 1_787_992_800, chat: { id: -100, type: 'supergroup' } }
            }
          }
        ]);
        return pending(init?.signal);
      }
      if (url.endsWith('/answerCallbackQuery')) return json(true);
      throw new Error(`unexpected request: ${url}`);
    };
    const adapter = new TelegramChannelAdapter({
      instance: instance(), botToken: '123:secret', fetch: fetchMock, now: () => new Date(now)
    });
    const events: ChannelInboundEvent[] = [];
    const controller = new AbortController();
    await adapter.start({ signal: controller.signal, emit: (event) => { events.push(event); } });
    await waitFor(() => events.length === 2);

    expect(events[0]).toMatchObject({
      kind: 'message', channel: { kind: 'telegram', instanceId: 'telegram-personal' },
      conversation: { id: '-100', type: 'group', threadId: '7' },
      sender: { id: '42' }, message: { id: '20', text: '@jojo_bot hello', mentions: [{ id: 'jojo_bot' }] },
      dedupeKey: 'update:10', security: { verified: true, verificationMethod: 'polling_api' }
    });
    expect(events[1]).toMatchObject({ kind: 'interaction', interaction: { actionToken: 'act_secure' }, dedupeKey: 'update:11' });
    expect(events[0]).not.toHaveProperty('raw');
    controller.abort();
    await adapter.stop();
    await adapter.stop();
  });

  it('renders safe Telegram HTML, buttons, replies, typing and edit operations', async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const method = String(input).split('/').pop()!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      return json(method === 'sendChatAction' ? true : { message_id: method === 'sendMessage' ? 30 : 31, chat: { id: 42, type: 'private' }, date: 0 });
    };
    const adapter = new TelegramChannelAdapter({ instance: instance(), botToken: '123:secret', fetch: fetchMock, now: () => new Date(now) });
    await expect(adapter.send({
      id: 'request', target: { instanceId: 'telegram-personal', conversationId: '42', threadId: '9' },
      replyTo: '12', content: [
        { type: 'markdown', text: '**Hello** <unsafe>' },
        { type: 'actions', buttons: [{ label: 'Allow', actionToken: 'act_allow', style: 'primary' }] }
      ], mode: 'reply'
    })).resolves.toMatchObject({ nativeMessageId: '30' });
    await adapter.setTyping?.({ target: { instanceId: 'telegram-personal', conversationId: '42' }, active: true });
    await adapter.edit?.({
      id: 'edit', nativeMessageId: '30', target: { instanceId: 'telegram-personal', conversationId: '42' },
      content: [{ type: 'text', text: 'Finished' }]
    });

    expect(requests[0]).toMatchObject({
      method: 'sendMessage', body: {
        chat_id: '42', message_thread_id: 9, text: '<b>Hello</b> &lt;unsafe&gt;', parse_mode: 'HTML',
        reply_parameters: { message_id: 12 },
        reply_markup: { inline_keyboard: [[{ text: 'Allow', callback_data: 'act_allow' }]] }
      }
    });
    expect(requests.map((request) => request.method)).toEqual(['sendMessage', 'sendChatAction', 'editMessageText']);
  });

  it('downloads inbound attachments into an isolated cache with a sanitized filename', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'telegram-channel-'));
    let polls = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/getMe')) return json({ id: 99, is_bot: true, first_name: 'Jojo' });
      if (url.endsWith('/getUpdates')) {
        polls += 1;
        if (polls === 1) return json([{
          update_id: 1,
          message: {
            message_id: 2, date: 0, chat: { id: 42, type: 'private' }, from: { id: 7, first_name: 'User' },
            document: { file_id: 'file-id', file_size: 4, file_name: '../../secret.txt', mime_type: 'text/plain' }
          }
        }]);
        return pending(init?.signal);
      }
      if (url.endsWith('/getFile')) return json({ file_id: 'file-id', file_path: 'documents/server-name.txt' });
      if (url.includes('/file/bot')) return new Response(Uint8Array.from([1, 2, 3, 4]));
      throw new Error(`unexpected request: ${url}`);
    };
    const adapter = new TelegramChannelAdapter({
      instance: instance({ cacheDirectory: directory }), botToken: '123:secret', fetch: fetchMock, now: () => new Date(now)
    });
    const events: ChannelInboundEvent[] = [];
    const controller = new AbortController();
    await adapter.start({ signal: controller.signal, emit: (event) => { events.push(event); } });
    await waitFor(() => events.length === 1);
    const block = events[0]?.message?.content?.[0];
    expect(block).toMatchObject({ type: 'file', name: 'secret.txt', source: { kind: 'local_file' } });
    if (!block || block.type !== 'file' || block.source.kind !== 'local_file') throw new Error('missing file');
    expect(block.source.path.startsWith(directory)).toBe(true);
    expect([...await readFile(block.source.path)]).toEqual([1, 2, 3, 4]);
    controller.abort();
    await adapter.stop();
  });

  it('resolves the bot token only through SecretReference and redacts transport failures', async () => {
    const resolved: string[] = [];
    const factory = createTelegramAdapterFactory({ fetch: async () => { throw new Error('network down'); } });
    const adapter = await factory.create({
      instance: instance(),
      secrets: { resolve: async (reference) => { resolved.push(reference); return '123:super-secret'; } }
    });
    expect(resolved).toEqual(['secret://channels/telegram/personal/token']);
    await expect(adapter.send({
      id: 'send', target: { instanceId: 'telegram-personal', conversationId: '42' }, content: [{ type: 'text', text: 'hello' }]
    })).rejects.toThrow('telegram_delivery_outcome_unknown');
    await adapter.send({
      id: 'never', target: { instanceId: 'telegram-personal', conversationId: '42' }, content: [{ type: 'text', text: 'hello' }]
    }).catch((error: unknown) => expect(String(error)).not.toContain('super-secret'));
  });
});

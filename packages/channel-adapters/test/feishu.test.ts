import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ChannelInboundEvent, ChannelInstance } from '@desktop-agent/channel-core';
import { FeishuChannelAdapter, createFeishuAdapterFactory } from '../src/index.js';

const now = '2026-08-30T00:00:00.000Z';
const encryptKey = 'feishu-encrypt-key';
const verificationToken = 'verification-secret';

function instance(secretRefs: Record<string, string> = {
  appSecret: 'secret://feishu/app-secret',
  verificationToken: 'secret://feishu/verification-token',
  encryptKey: 'secret://feishu/encrypt-key'
}): ChannelInstance {
  return {
    id: 'feishu-work', kind: 'feishu', name: 'Feishu Work', enabled: true,
    config: { appId: 'cli_app_id' }, secretRefs,
    revision: 1, fingerprint: 'fp', createdAt: now, updatedAt: now
  };
}

function signature(rawBody: string, timestamp = '1788028800', nonce = 'nonce'): string {
  return createHash('sha256').update(timestamp).update(nonce).update(encryptKey).update(rawBody).digest('hex');
}

function webhook(body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  return {
    method: 'POST', body, rawBody,
    headers: {
      'X-Lark-Request-Timestamp': '1788028800',
      'X-Lark-Request-Nonce': 'nonce',
      'X-Lark-Signature': signature(rawBody)
    }
  };
}

function encrypt(payload: unknown): string {
  const iv = Buffer.from('0123456789abcdef');
  const key = createHash('sha256').update(encryptKey).digest();
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('test_timeout');
}

function adapter(fetchMock?: typeof fetch): FeishuChannelAdapter {
  return new FeishuChannelAdapter({
    instance: instance(), appSecret: 'app-secret', verificationToken, encryptKey,
    ...(fetchMock ? { fetch: fetchMock } : {}), now: () => new Date(now)
  });
}

describe('FeishuChannelAdapter', () => {
  it('verifies signed URL challenges and rejects invalid signatures', async () => {
    const channel = adapter();
    const challenge = webhook({ type: 'url_verification', challenge: 'challenge-value', token: verificationToken });
    await expect(channel.handleWebhook(challenge)).resolves.toEqual({ status: 200, body: { challenge: 'challenge-value' } });

    await expect(channel.handleWebhook({
      ...challenge, headers: { ...challenge.headers, 'X-Lark-Signature': 'invalid' }
    })).resolves.toMatchObject({ status: 401, body: { error: 'feishu_invalid_signature' } });
    const withoutRawBody = { method: challenge.method, headers: challenge.headers, body: challenge.body };
    await expect(channel.handleWebhook(withoutRawBody)).resolves.toMatchObject({ status: 400 });
  });

  it('decrypts and normalizes messages using message_id as the durable dedupe key', async () => {
    const events: ChannelInboundEvent[] = [];
    const channel = adapter();
    await channel.start({ signal: new AbortController().signal, emit: (event) => { events.push(event); } });
    const payload = {
      schema: '2.0',
      header: { event_id: 'event-1', event_type: 'im.message.receive_v1', create_time: '1788028800000', token: verificationToken },
      event: {
        sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
        message: {
          message_id: 'om_message', parent_id: 'om_parent', thread_id: 'omt_thread', chat_id: 'oc_chat', chat_type: 'group',
          message_type: 'text', content: JSON.stringify({ text: '@_user_1 hello' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Jojo' }]
        }
      }
    };
    const request = webhook({ encrypt: encrypt(payload) });
    await expect(channel.handleWebhook(request)).resolves.toEqual({ status: 200, body: {} });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      id: 'feishu_feishu-work_om_message', kind: 'message', channel: { kind: 'feishu', instanceId: 'feishu-work' },
      conversation: { id: 'oc_chat', type: 'group', threadId: 'omt_thread' }, sender: { id: 'ou_sender' },
      message: { id: 'om_message', text: '@_user_1 hello', replyTo: 'om_parent', mentions: [{ id: 'ou_bot', displayName: 'Jojo' }] },
      dedupeKey: 'message:om_message', security: { verified: true, verificationMethod: 'webhook_signature' }
    });
    expect(events[0]).not.toHaveProperty('raw');
  });

  it('acknowledges card actions immediately and emits an opaque action token', async () => {
    const events: ChannelInboundEvent[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const channel = adapter();
    await channel.start({ signal: new AbortController().signal, emit: async (event) => { events.push(event); await blocked; } });
    const request = webhook({
      schema: '2.0',
      header: { event_id: 'event-action', event_type: 'card.action.trigger', create_time: '1788028800000', token: verificationToken },
      event: {
        operator: { open_id: 'ou_operator' }, action: { value: { actionToken: 'opaque-action-token' } },
        context: { open_chat_id: 'oc_chat', open_message_id: 'om_card' }
      }
    });
    await expect(channel.handleWebhook(request)).resolves.toMatchObject({ status: 200, body: { toast: { type: 'info' } } });
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      kind: 'interaction', conversation: { id: 'oc_chat' }, sender: { id: 'ou_operator' },
      interaction: { actionToken: 'opaque-action-token' }, dedupeKey: 'event:event-action'
    });
    release();
  });

  it('caches tenant tokens and sends text, interactive cards, uploads and edits', async () => {
    const requests: Array<{ url: string; method: string; authorization?: string; body?: unknown }> = [];
    let message = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      let body: unknown = init?.body;
      if (typeof body === 'string') body = JSON.parse(body);
      requests.push({ url, method: init?.method ?? 'GET', ...(headers.get('authorization') ? { authorization: headers.get('authorization')! } : {}), body });
      if (url.endsWith('/tenant_access_token/internal')) {
        return Response.json({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (url.endsWith('/images')) return Response.json({ code: 0, data: { image_key: 'img-key' } });
      if (url.endsWith('/files')) return Response.json({ code: 0, data: { file_key: 'file-key' } });
      message += 1;
      return Response.json({ code: 0, data: { message_id: `om_${message}` } });
    };
    const channel = adapter(fetchMock);
    await expect(channel.send({
      id: 'send-text', target: { instanceId: 'feishu-work', conversationId: 'oc_chat' },
      content: [{ type: 'text', text: 'hello' }]
    })).resolves.toMatchObject({ nativeMessageId: 'om_1' });
    await expect(channel.send({
      id: 'send-card', target: { instanceId: 'feishu-work', conversationId: 'oc_chat' }, replyTo: 'om_parent',
      content: [
        { type: 'markdown', text: '**Approve?**' },
        { type: 'actions', buttons: [{ label: '允许', actionToken: 'action-allow', style: 'primary' }] }
      ]
    })).resolves.toMatchObject({ nativeMessageId: 'om_2' });
    await expect(channel.send({
      id: 'send-media', target: { instanceId: 'feishu-work', conversationId: 'oc_chat' },
      content: [
        { type: 'image', source: { kind: 'buffer', mimeType: 'image/png', data: Uint8Array.from([1]) } },
        { type: 'file', name: 'report.pdf', mimeType: 'application/pdf', source: { kind: 'buffer', mimeType: 'application/pdf', data: Uint8Array.from([2]) } }
      ]
    })).resolves.toMatchObject({ nativeMessageId: 'om_3' });
    await channel.edit?.({
      id: 'edit', nativeMessageId: 'om_1', target: { instanceId: 'feishu-work', conversationId: 'oc_chat' },
      content: [{ type: 'text', text: 'updated' }]
    });

    expect(requests.filter((request) => request.url.endsWith('/tenant_access_token/internal'))).toHaveLength(1);
    const sends = requests.filter((request) => request.url.includes('/messages'));
    expect(sends[0]).toMatchObject({ authorization: 'Bearer tenant-token', body: { receive_id: 'oc_chat', msg_type: 'text', content: '{"text":"hello"}' } });
    expect(sends[1]?.url).toContain('/messages/om_parent/reply');
    const cardBody = sends[1]?.body as { msg_type: string; content: string };
    expect(cardBody.msg_type).toBe('interactive');
    expect(JSON.parse(cardBody.content)).toMatchObject({ elements: [{ tag: 'markdown' }, { tag: 'action', actions: [{ value: { actionToken: 'action-allow' } }] }] });
    expect(requests.some((request) => request.url.endsWith('/images') && request.body instanceof FormData)).toBe(true);
    expect(requests.some((request) => request.url.endsWith('/files') && request.body instanceof FormData)).toBe(true);
    expect(sends.at(-1)).toMatchObject({ method: 'PATCH', body: { msg_type: 'text', content: '{"text":"updated"}' } });
  });

  it('resolves only SecretReferences and never leaks app secrets in errors', async () => {
    const resolved: string[] = [];
    const factory = createFeishuAdapterFactory({ fetch: async () => { throw new Error('network down'); } });
    const channel = await factory.create({
      instance: instance(),
      secrets: { resolve: async (reference) => {
        resolved.push(reference);
        if (reference.endsWith('app-secret')) return 'super-secret';
        if (reference.endsWith('verification-token')) return verificationToken;
        return encryptKey;
      } }
    });
    expect(resolved).toEqual([
      'secret://feishu/app-secret', 'secret://feishu/verification-token', 'secret://feishu/encrypt-key'
    ]);
    await channel.send({
      id: 'send', target: { instanceId: 'feishu-work', conversationId: 'oc_chat' }, content: [{ type: 'text', text: 'hello' }]
    }).catch((error: unknown) => {
      expect(String(error)).toContain('feishu_auth_transport_failed');
      expect(String(error)).not.toContain('super-secret');
    });
  });
});

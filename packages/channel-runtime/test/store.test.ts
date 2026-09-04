import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ChannelBinding, ChannelInboundEvent, ChannelInstance, ChannelOutboxItem, ChannelPairing } from '@desktop-agent/channel-core';
import { SqliteChannelStore } from '../src/index.js';

const now = '2026-08-30T00:00:00.000Z';
const instance: ChannelInstance = {
  id: 'inst', kind: 'fake', name: 'Fake', enabled: true, config: {}, secretRefs: { token: 'secret://fake/token' },
  revision: 1, fingerprint: 'fp', createdAt: now, updatedAt: now
};
const binding: ChannelBinding = {
  id: 'binding', instanceId: 'inst', conversation: { id: 'chat', type: 'direct' },
  routing: { sessionMode: 'persistent' },
  policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false },
  revision: 1, createdAt: now, updatedAt: now
};
const event: ChannelInboundEvent = {
  id: 'evt', kind: 'message', channel: { kind: 'fake', instanceId: 'inst' },
  conversation: { id: 'chat', type: 'direct' }, sender: { id: 'user' },
  message: { id: 'message', text: 'hello' }, receivedAt: now, dedupeKey: 'message',
  security: { verified: true, verificationMethod: 'local' }
};
const pairing: ChannelPairing = {
  id: 'pairing', instanceId: 'inst', conversationId: 'chat', senderId: 'user', codeHash: 'hash',
  status: 'pending', expiresAt: '2026-08-30T00:15:00.000Z', createdAt: now
};

async function filename(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-channel-')), 'channels.sqlite');
}

describe('SqliteChannelStore', () => {
  it('rejects plaintext credentials in ordinary instance config', async () => {
    const store = new SqliteChannelStore(await filename());
    await expect(store.saveInstance({
      ...instance,
      config: { nested: { botToken: 'plaintext' } },
      secretRefs: {}
    })).rejects.toThrow('channel_plaintext_secret_forbidden');
    await store.close();
  });

  it('persists instances, bindings and durable dedupe across restart', async () => {
    const file = await filename();
    const first = new SqliteChannelStore(file);
    await first.saveInstance(instance);
    await first.saveBinding(binding);
    expect(await first.claimInbound(event)).toBe(true);
    await first.close();

    const second = new SqliteChannelStore(file);
    expect(await second.findBinding('inst', 'chat')).toMatchObject({ id: 'binding' });
    expect(await second.claimInbound({ ...event, id: 'evt-duplicate' })).toBe(false);
    await second.close();
  });

  it('removes pairings when their Channel instance is deleted', async () => {
    const store = new SqliteChannelStore(await filename());
    await store.saveInstance(instance);
    await store.savePairing(pairing);
    await store.deleteInstance(instance.id);

    expect(await store.listPairings()).toEqual([]);
    await store.close();
  });

  it('cleans orphaned pairings left by an older database on startup', async () => {
    const file = await filename();
    const first = new SqliteChannelStore(file);
    await first.saveInstance(instance);
    await first.savePairing(pairing);
    await first.close();

    const legacyWriter = new DatabaseSync(file);
    legacyWriter.exec('PRAGMA foreign_keys = OFF;');
    legacyWriter.prepare('DELETE FROM channel_instances WHERE id = ?').run(instance.id);
    legacyWriter.close();

    const reopened = new SqliteChannelStore(file);
    expect(await reopened.listPairings()).toEqual([]);
    await reopened.close();
  });

  it('marks an interrupted sending attempt unknown instead of blindly retrying', async () => {
    const store = new SqliteChannelStore(await filename());
    const item: ChannelOutboxItem = {
      id: 'delivery', instanceId: 'inst', conversationId: 'chat',
      request: { id: 'delivery', target: { instanceId: 'inst', conversationId: 'chat' }, content: [{ type: 'text', text: 'hi' }] },
      idempotencyKey: 'key', status: 'sending', attemptCount: 1, createdAt: now
    };
    await store.enqueueOutbox(item);
    await store.recoverOutbox();
    expect(await store.getOutbox('delivery')).toMatchObject({ status: 'unknown' });
    await store.close();
  });

  it('atomically enforces action-token sender, expiry and one-time use', async () => {
    const store = new SqliteChannelStore(await filename());
    await store.saveActionTokens([{
      tokenHash: 'hash', actionType: 'approval', payload: { approvalId: 'approval', decision: 'allow' },
      allowedSenderId: 'owner', createdAt: now, expiresAt: '2026-08-30T00:10:00.000Z'
    }]);
    await expect(store.consumeActionToken('hash', 'attacker', '2026-08-30T00:01:00.000Z'))
      .rejects.toThrow('channel_action_token_sender_mismatch');
    await expect(store.consumeActionToken('hash', 'owner', '2026-08-30T00:01:00.000Z'))
      .resolves.toMatchObject({ usedAt: '2026-08-30T00:01:00.000Z' });
    await expect(store.consumeActionToken('hash', 'owner', '2026-08-30T00:02:00.000Z'))
      .rejects.toThrow('channel_action_token_used');
    await store.saveActionTokens([{
      tokenHash: 'expired', actionType: 'approval', payload: { approvalId: 'approval-2', decision: 'deny' },
      createdAt: now, expiresAt: '2026-08-30T00:00:01.000Z'
    }]);
    await expect(store.consumeActionToken('expired', 'owner', '2026-08-30T00:02:00.000Z'))
      .rejects.toThrow('channel_action_token_expired');
    await store.close();
  });
});

import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelInstance, ChannelOutboxItem } from '@desktop-agent/channel-core';
import { SqliteChannelStore } from '../src/index.js';
import { CHANNEL_SCHEMA_SQL } from '../src/store/schema.js';

// Historical v2 schema from personal-agent commit 0c92c70, independently pinned
// here so changes to today's v1 schema cannot silently expand compatibility.
const knownV2 = `
CREATE TABLE channel_instances (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  config_json TEXT NOT NULL, secret_refs_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE channel_bindings (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT,
  conversation_type TEXT NOT NULL, session_mode TEXT NOT NULL, session_id TEXT,
  workspace_root TEXT, provider_id TEXT, model TEXT, routing_json TEXT NOT NULL, policy_json TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(instance_id) REFERENCES channel_instances(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_channel_binding_address ON channel_bindings(instance_id, conversation_id, IFNULL(thread_id, ''));
CREATE TABLE channel_inbound_events (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, sender_id TEXT,
  conversation_id TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  UNIQUE(instance_id, dedupe_key)
);
CREATE TABLE channel_delivery_batches (
  batch_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  expected_parts INTEGER NOT NULL CHECK(expected_parts > 0), status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE channel_outbox (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, binding_id TEXT, conversation_id TEXT NOT NULL,
  batch_id TEXT, part_index INTEGER,
  thread_id TEXT, payload_json TEXT NOT NULL, mode TEXT NOT NULL, correlation_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
  next_attempt_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT, native_message_id TEXT, last_error TEXT
);
CREATE INDEX idx_channel_outbox_pending ON channel_outbox(status, next_attempt_at);
CREATE TABLE channel_pairings (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  code_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
  FOREIGN KEY(instance_id) REFERENCES channel_instances(id) ON DELETE CASCADE
);
CREATE INDEX idx_channel_pairing_lookup ON channel_pairings(instance_id, conversation_id, sender_id, status);
CREATE TABLE channel_action_tokens (
  token_hash TEXT PRIMARY KEY, action_type TEXT NOT NULL, payload_json TEXT NOT NULL,
  allowed_sender_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX idx_channel_action_tokens_expiry ON channel_action_tokens(expires_at, used_at);
CREATE UNIQUE INDEX idx_channel_outbox_batch_part ON channel_outbox(batch_id, part_index);
PRAGMA user_version = 2;
`;

const now = '2026-10-13T00:00:00.000Z';
const instance: ChannelInstance = {
  id: 'inst', kind: 'fake', name: 'Preserved channel', enabled: true, config: { webhook: '/hook' },
  secretRefs: { token: 'secret://channel/token' }, fingerprint: 'fp', revision: 3, createdAt: now, updatedAt: now
};

async function filename(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-channel-compat-')), 'channels.sqlite');
}

function item(id: string, status: ChannelOutboxItem['status'] = 'pending'): ChannelOutboxItem {
  return {
    id, instanceId: 'inst', conversationId: 'chat', idempotencyKey: `${id}:0`, status,
    request: { id, target: { instanceId: 'inst', conversationId: 'chat' }, content: [{ type: 'text', text: id }] },
    attemptCount: status === 'sending' ? 1 : 0, createdAt: now
  };
}

function seed(file: string, sql = knownV2): void {
  const database = new DatabaseSync(file);
  try {
    database.exec(sql);
    database.prepare('INSERT INTO channel_instances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(instance.id, instance.kind, instance.name, 1, JSON.stringify(instance.config), JSON.stringify(instance.secretRefs),
        instance.fingerprint, instance.revision, now, now);
    database.prepare(`INSERT INTO channel_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('binding', 'inst', 'chat', null, 'direct', 'persistent', 'session', '/workspace', 'provider', 'model',
        JSON.stringify({ sessionMode: 'persistent', sessionId: 'session', workspaceRoot: '/workspace', providerId: 'provider', model: 'model' }),
        JSON.stringify({ enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false }), 2, now, now);
    database.prepare(`INSERT INTO channel_pairings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('pairing', 'inst', 'chat', 'sender', 'code-hash', 'pending', '2026-10-13T00:15:00.000Z', now, null);
    database.prepare(`INSERT INTO channel_inbound_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('inbound', 'inst', 'dedupe', 'sender', 'chat', now, 'processed', null);
    database.prepare(`INSERT INTO channel_action_tokens VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('token', 'approval', JSON.stringify({ approvalId: 'approval', decision: 'allow' }), 'sender', '2026-10-13T00:15:00.000Z', now, null);
    database.prepare(`INSERT INTO channel_delivery_batches VALUES (?, ?, ?, ?, ?, ?)`)
      .run('batch', 'batch-key', 'hash', 3, 'pending', now);
    const insert = database.prepare(`INSERT INTO channel_outbox
      (id, instance_id, conversation_id, payload_json, mode, idempotency_key, status, attempt_count, created_at, batch_id, part_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 3; index++) {
      const part = item(`part-${index}`);
      insert.run(part.id, part.instanceId, part.conversationId, JSON.stringify(part.request), 'system',
        part.idempotencyKey, part.status, part.attemptCount, part.createdAt, 'batch', index);
    }
  } finally { database.close(); }
}

function inspect(file: string): { version: number; batch: Record<string, unknown>; parts: Record<string, unknown>[] } {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      version: (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      batch: database.prepare('SELECT * FROM channel_delivery_batches WHERE batch_id = ?').get('batch')!,
      parts: database.prepare('SELECT * FROM channel_outbox ORDER BY part_index').all()
    };
  } finally { database.close(); }
}

describe('known channel schema 2 compatibility', () => {
  it.each(['fresh', 'migrated', 'early-v1-migrated'] as const)('preserves %s v2 schema and data across writes and restart', async shape => {
    const file = await filename();
    let sql = knownV2;
    if (shape !== 'fresh') {
      sql = sql.replace('  batch_id TEXT, part_index INTEGER,\n', '')
        .replace('native_message_id TEXT, last_error TEXT\n', 'native_message_id TEXT, last_error TEXT, batch_id TEXT, part_index INTEGER\n');
    }
    if (shape === 'early-v1-migrated') {
      const start = sql.indexOf('CREATE TABLE channel_pairings');
      sql = sql.slice(0, start) + sql.slice(start)
        .replace(/,\n\s*FOREIGN KEY\(instance_id\) REFERENCES channel_instances\(id\) ON DELETE CASCADE/u, '');
    }
    seed(file, sql);
    const before = inspect(file);
    const store = new SqliteChannelStore(file);
    expect(await store.getInstance('inst')).toEqual(instance);
    expect(await store.findBinding('inst', 'chat')).toMatchObject({ id: 'binding', routing: { sessionId: 'session' } });
    expect(await store.listPairings()).toMatchObject([{ id: 'pairing' }]);
    expect(await store.getOutbox('part-1')).toMatchObject({ idempotencyKey: 'part-1:0', status: 'pending' });
    await store.saveInstance({ ...instance, name: 'Updated', revision: 4 }, 3);
    await store.enqueueOutbox(item('new-delivery'));
    await store.close();
    const after = inspect(file);
    expect(after.version).toBe(2);
    expect(after.batch).toEqual(before.batch);
    expect(after.parts.filter(row => row.batch_id === 'batch')).toEqual(before.parts);
    const reopened = new SqliteChannelStore(file);
    expect(await reopened.getInstance('inst')).toMatchObject({ name: 'Updated', revision: 4 });
    expect(await reopened.getOutbox('new-delivery')).toMatchObject({ status: 'pending' });
    await reopened.close();
  });

  it('dispatches existing batch parts in order and updates the aggregate receipt', async () => {
    const file = await filename(); seed(file);
    const store = new SqliteChannelStore(file);
    expect((await store.listReadyOutbox(now)).map(part => part.id)).toEqual(['part-0']);
    await expect(store.updateOutbox('part-1', { status: 'sending' })).rejects.toThrow('channel_delivery_not_ready');
    await store.updateOutbox('part-0', { status: 'sending', attemptCount: 1 });
    await expect(store.updateOutbox('part-0', { status: 'sending' })).rejects.toThrow('channel_delivery_not_ready');
    expect(await store.listReadyOutbox(now)).toEqual([]);
    await store.updateOutbox('part-0', { status: 'delivered', deliveredAt: now, nativeMessageId: 'native' });
    expect((await store.listReadyOutbox(now)).map(part => part.id)).toEqual(['part-1']);
    for (const id of ['part-1', 'part-2']) {
      await store.updateOutbox(id, { status: 'sending', attemptCount: 1 });
      await store.updateOutbox(id, { status: 'delivered', deliveredAt: now });
    }
    await store.close();
    expect(inspect(file).batch).toMatchObject({ status: 'delivered', request_hash: 'hash', expected_parts: 3 });
    expect(inspect(file).parts.map(part => [part.batch_id, part.part_index])).toEqual([['batch', 0], ['batch', 1], ['batch', 2]]);
  });

  it('blocks later parts when a previous delivery fails', async () => {
    const file = await filename(); seed(file);
    const store = new SqliteChannelStore(file);
    await store.updateOutbox('part-0', { status: 'failed', lastError: 'delivery failed' });
    expect(await store.listReadyOutbox(now)).toEqual([]);
    expect(await store.listOutbox()).toMatchObject([
      { status: 'failed' }, { status: 'blocked', lastError: 'A preceding delivery part failed.' },
      { status: 'blocked', lastError: 'A preceding delivery part failed.' }
    ]);
    await store.close();
    expect(inspect(file).batch.status).toBe('failed');
  });

  it('recovers interrupted parts as unknown and preserves legacy receipt uncertainty', async () => {
    const file = await filename(); seed(file);
    const store = new SqliteChannelStore(file);
    await store.updateOutbox('part-0', { status: 'sending', attemptCount: 1 });
    await store.close();
    const reopened = new SqliteChannelStore(file);
    await reopened.recoverOutbox();
    expect(await reopened.getOutbox('part-0')).toMatchObject({ status: 'unknown' });
    expect(await reopened.listReadyOutbox(now)).toEqual([]);
    await reopened.close();
    expect(inspect(file).batch.status).toBe('unknown');
    const writer = new DatabaseSync(file);
    writer.exec("UPDATE channel_outbox SET status = 'delivered'; UPDATE channel_delivery_batches SET request_hash = 'legacy:batch';");
    writer.close();
    const legacy = new SqliteChannelStore(file);
    await legacy.recoverOutbox();
    await legacy.close();
    expect(inspect(file).batch.status).toBe('unknown');
  });

  it('keeps incomplete delivered manifests unknown instead of reporting success', async () => {
    const file = await filename(); seed(file);
    const writer = new DatabaseSync(file);
    writer.exec("DELETE FROM channel_outbox WHERE id = 'part-2'; UPDATE channel_outbox SET status = 'delivered';");
    writer.close();
    const store = new SqliteChannelStore(file);
    await store.recoverOutbox();
    await store.close();
    expect(inspect(file).batch).toMatchObject({ status: 'unknown', expected_parts: 3 });
  });

  it.each([0, 1, 2])('does not dispatch an incomplete batch with missing part %s', async missing => {
    const file = await filename(); seed(file);
    const writer = new DatabaseSync(file);
    writer.prepare('DELETE FROM channel_outbox WHERE part_index = ?').run(missing);
    writer.close();
    const store = new SqliteChannelStore(file);
    expect(await store.listReadyOutbox(now)).toEqual([]);
    await expect(store.updateOutbox(missing === 0 ? 'part-1' : 'part-0', { status: 'sending' }))
      .rejects.toThrow('channel_delivery_not_ready');
    await store.recoverOutbox();
    await store.close();
    expect(inspect(file).batch.status).toBe('unknown');
  });

  it.each([
    ['future version', `${knownV2}\nPRAGMA user_version = 3;`, 3],
    ['relabeled v1', `${CHANNEL_SCHEMA_SQL}\nPRAGMA user_version = 2;`, 2],
    ['missing part index', knownV2.replace('batch_id TEXT, part_index INTEGER,', 'batch_id TEXT,').replace('CREATE UNIQUE INDEX idx_channel_outbox_batch_part ON channel_outbox(batch_id, part_index);', ''), 2],
    ['changed batch constraint', knownV2.replace('CHECK(expected_parts > 0)', 'CHECK(expected_parts >= 0)'), 2],
    ['changed address constraint', knownV2.replace('CREATE UNIQUE INDEX idx_channel_binding_address', 'CREATE INDEX idx_channel_binding_address'), 2],
    ['missing batch index', knownV2.replace('CREATE UNIQUE INDEX idx_channel_outbox_batch_part ON channel_outbox(batch_id, part_index);', ''), 2],
    ['changed part default', knownV2.replace('part_index INTEGER,', 'part_index INTEGER DEFAULT 0,'), 2],
    ['changed foreign key', knownV2.replace('ON DELETE CASCADE', 'ON DELETE SET NULL'), 2],
    ['unexpected trigger', `${knownV2}\nCREATE TRIGGER future_write AFTER UPDATE ON channel_instances BEGIN DELETE FROM channel_outbox; END;`, 2],
    ['unexpected required column', knownV2.replace('part_index INTEGER,', "part_index INTEGER, future_required TEXT NOT NULL DEFAULT 'future',"), 2]
  ])('rejects %s before journal or database changes', async (_label, sql, version) => {
    const file = await filename();
    const writer = new DatabaseSync(file); writer.exec(String(sql)); writer.close();
    const before = await readFile(file);
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    try {
      expect(() => new SqliteChannelStore(file)).toThrow(`channel_sqlite_version_unsupported: ${version}`);
      expect(close).toHaveBeenCalled();
    } finally { close.mockRestore(); }
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(path.dirname(file))).toEqual(['channels.sqlite']);
  });

  it('retains normal v1 behavior and creates new databases at version 1', async () => {
    const file = await filename();
    const store = new SqliteChannelStore(file);
    await store.enqueueOutbox(item('first'));
    await store.enqueueOutbox(item('second'));
    expect((await store.listReadyOutbox(now)).map(part => part.id)).toEqual(['first', 'second']);
    await store.close();
    const reader = new DatabaseSync(file, { readOnly: true });
    try {
      expect(reader.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(reader.prepare("SELECT name FROM sqlite_master WHERE name = 'channel_delivery_batches'").get()).toBeUndefined();
    } finally { reader.close(); }
  });
});

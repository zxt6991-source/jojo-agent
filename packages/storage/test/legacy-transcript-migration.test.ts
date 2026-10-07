import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { JsonlSessionStore } from '../src/index.js';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';
import { transcriptHash } from '../src/legacy-transcript-migration.js';

const directories: string[] = [];
const stores: SqliteAgentRuntimeStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'jojo-legacy-migration-'));
  directories.push(directory);
  const source = await readFile(new URL('./fixtures/legacy-session/session.jsonl', import.meta.url), 'utf8');
  await writeFile(path.join(directory, 'session.jsonl'), source);
  const legacy = new JsonlSessionStore(directory);
  const snapshot = await legacy.loadForMigration('session');
  const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'), { now: () => 100 });
  stores.push(store);
  await store.createSession({ id: 'session', createdAt: 0 });
  await store.saveLane({ sessionId: 'session', name: 'main', leafId: null, currentOperationId: null });
  return { directory, legacy, store, messages: snapshot.messages, source };
}
const extra: Message = { id: 'delivery', role: 'assistant', content: [{ type: 'text', text: 'scheduled' }], createdAt: '2026-09-02T00:00:00.000Z' };
async function transcript(store: SqliteAgentRuntimeStore) {
  const lane = await store.getLane('session', 'main');
  return (await store.readPath(lane!.leafId)).flatMap((entry) => entry.type === 'message' ? [entry.message] : []);
}

describe('legacy JSONL migration', () => {
  it('imports a fixture, collapses duplicates and remains idempotent after reopening', async () => {
    const { store, messages } = await fixture();
    expect(store.importLegacyTranscript('session', messages)).toMatchObject({ status: 'imported', importedCount: 2 });
    expect(await transcript(store)).toEqual(messages.slice(0, 2));
    const marker = store.getLegacyTranscriptMigration('session');
    expect(marker).toMatchObject({ sourceCount: 2, importedCount: 2, importedHash: transcriptHash(messages.slice(0, 2)) });
    const reopened = new SqliteAgentRuntimeStore(store.filename);
    stores.push(reopened);
    expect(reopened.importLegacyTranscript('session', messages)).toMatchObject({ status: 'unchanged', importedCount: 0 });
    expect(reopened.getLegacyTranscriptMigration('session')).toEqual(marker);
    expect(await transcript(reopened)).toHaveLength(2);
  });

  it.each(['entry', 'lane', 'marker'])('rolls back all facts at the %s commit point and succeeds on retry', async (point) => {
    const { store, messages } = await fixture();
    const db = new DatabaseSync(store.filename);
    try {
      const clause = point === 'entry' ? "BEFORE INSERT ON entries WHEN NEW.id = 'assistant-1'" : point === 'lane' ? 'BEFORE UPDATE ON lanes' : 'BEFORE INSERT ON runtime_migrations';
      db.exec(`CREATE TRIGGER fault ${clause} BEGIN SELECT RAISE(ABORT, 'migration fault'); END;`);
      expect(() => store.importLegacyTranscript('session', messages)).toThrow('migration fault');
      expect(await store.getEntry('user-1')).toBeNull();
      expect(await transcript(store)).toEqual([]);
      expect(store.getLegacyTranscriptMigration('session')).toBeNull();
      db.exec('DROP TRIGGER fault');
      expect(store.importLegacyTranscript('session', messages).importedCount).toBe(2);
    } finally { db.close(); }
  });

  it('keeps the previous marker and transcript when an incremental import fails', async () => {
    const { store, messages } = await fixture();
    store.importLegacyTranscript('session', messages);
    const previous = store.getLegacyTranscriptMigration('session');
    const db = new DatabaseSync(store.filename);
    try {
      db.exec("CREATE TRIGGER fault BEFORE UPDATE ON runtime_migrations BEGIN SELECT RAISE(ABORT, 'marker update fault'); END;");
      expect(() => store.importLegacyTranscript('session', [...messages, extra])).toThrow('marker update fault');
      expect(await store.getEntry(extra.id)).toBeNull();
      expect(store.getLegacyTranscriptMigration('session')).toEqual(previous);
      expect(await transcript(store)).toEqual(messages.slice(0, 2));
    } finally { db.close(); }
  });

  it('repairs an entry stranded by the old non-atomic seed', async () => {
    const { store, messages } = await fixture();
    await store.appendEntry({ id: 'user-1', sessionId: 'session', parentId: null, type: 'message', message: messages[0]! });
    expect(store.importLegacyTranscript('session', messages).importedCount).toBe(2);
    expect(await transcript(store)).toEqual(messages.slice(0, 2));
  });

  it('retains authoritative runtime content and imports only a new delivery', async () => {
    const { store, messages } = await fixture();
    store.importLegacyTranscript('session', messages);
    const changed = messages.map((message) => ({ ...message, content: [{ type: 'text' as const, text: 'redacted projection' }] }));
    expect(store.importLegacyTranscript('session', [...changed, extra])).toMatchObject({ importedCount: 1, retainedCount: 2 });
    expect(await transcript(store)).toEqual([...messages.slice(0, 2), extra]);
  });

  it('does not mutate a lane with an active owner', async () => {
    const { store, messages } = await fixture();
    const db = new DatabaseSync(store.filename);
    try { db.prepare('UPDATE lanes SET current_operation_id = ?').run('active'); } finally { db.close(); }
    expect(store.importLegacyTranscript('session', messages).status).toBe('busy');
    expect(store.getLegacyTranscriptMigration('session')).toBeNull();
    expect(await transcript(store)).toEqual([]);
  });

  it('rejects duplicate conflicts and cross-session entry collisions without partial writes', async () => {
    const { store, messages } = await fixture();
    expect(() => store.importLegacyTranscript('session', [messages[0]!, { ...extra, id: 'user-1' }])).toThrow('legacy_message_conflict');
    await store.createSession({ id: 'other', createdAt: 0 });
    await store.appendEntry({ id: 'assistant-1', sessionId: 'other', parentId: null, type: 'message', message: messages[1]! });
    expect(() => store.importLegacyTranscript('session', messages)).toThrow('legacy_entry_collision');
    expect(await store.getEntry('user-1')).toBeNull();
    expect(store.getLegacyTranscriptMigration('session')).toBeNull();
  });

  it('hides restored stale JSONL behind a deletion tombstone', async () => {
    const { legacy, store, directory, source, messages } = await fixture();
    store.importLegacyTranscript('session', messages);
    await legacy.delete('session');
    await store.deleteSession('session');
    await writeFile(path.join(directory, 'session.jsonl'), source);
    expect(await legacy.get('session')).toBeNull();
    expect(await legacy.messages('session')).toEqual([]);
    expect(await legacy.list()).toEqual([]);
    await expect(legacy.loadForMigration('session')).rejects.toThrow('legacy_session_unavailable');
    expect(store.getLegacyTranscriptMigration('session')).toBeNull();
    expect(() => store.importLegacyTranscript('session', messages)).toThrow('runtime_session_not_found');
  });

  it('refuses to mark partially invalid JSONL as successfully migrated', async () => {
    const { legacy, directory, source } = await fixture();
    await writeFile(path.join(directory, 'session.jsonl'), source + '{"schemaVersion":');
    expect((await legacy.load('session')).warnings).toHaveLength(1);
    await expect(legacy.loadForMigration('session')).rejects.toThrow('legacy_transcript_invalid');
  });

  it('upgrades the previous SQLite schema without changing its transcript', async () => {
    const { store, messages } = await fixture();
    await store.appendEntry({ id: 'user-1', sessionId: 'session', parentId: null, type: 'message', message: messages[0]! });
    await store.saveLane({ sessionId: 'session', name: 'main', leafId: 'user-1', currentOperationId: null });
    const db = new DatabaseSync(store.filename);
    try { db.exec('DROP TABLE runtime_migrations; PRAGMA user_version = 1;'); } finally { db.close(); }
    const upgraded = new SqliteAgentRuntimeStore(store.filename);
    stores.push(upgraded);
    expect(upgraded.importLegacyTranscript('session', messages)).toMatchObject({ importedCount: 1, retainedCount: 1 });
    expect(await transcript(upgraded)).toEqual(messages.slice(0, 2));
  });
});

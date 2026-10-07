import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
const message: Message = { id: 'delivery', role: 'assistant', content: [{ type: 'text', text: 'scheduled result' }], createdAt: '2026-09-24T00:00:00.000Z' };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-conversation-'));
  const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
  const db = new DatabaseSync(store.filename);
  disposers.push(async () => { db.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.createSession({ id: 's', createdAt: 0 });
  await store.saveLane({ sessionId: 's', name: 'main', leafId: null, currentOperationId: null });
  return { store, db };
}
it('commits an idle delivery to main once', async () => {
  const { store } = await fixture();
  store.appendConversationMessage('s', message);
  store.appendConversationMessage('s', message);
  expect(store.readConversationMessages('s')).toEqual([message]);
  expect((await store.getLane('s', 'main'))?.leafId).toBe(message.id);
});
it('makes an active-lane delivery readable and durable without overwriting the operation leaf', async () => {
  const { store, db } = await fixture();
  db.exec("UPDATE lanes SET current_operation_id = 'running'");
  store.appendConversationMessage('s', message);
  store.appendConversationMessage('s', message);
  expect((await store.getLane('s', 'main'))?.leafId).toBeNull();
  const reopened = new SqliteAgentRuntimeStore(store.filename);
  try {
    expect(reopened.readConversationMessages('s')).toEqual([message]);
    const answer = { ...message, id: 'answer' };
    await reopened.appendEntry({ id: answer.id, sessionId: 's', parentId: null, type: 'message', message: answer });
    db.exec("UPDATE lanes SET current_operation_id = NULL, leaf_id = 'answer'");
    reopened.flushConversationMessages('s');
    reopened.flushConversationMessages('s');
    expect(reopened.readConversationMessages('s')).toEqual([answer, message]);
    expect((await reopened.getEntry(message.id))?.parentId).toBe(answer.id);
  } finally { reopened.close(); }
});
it('preserves the durable pending delivery when draining fails', async () => {
  const { store, db } = await fixture();
  db.exec("UPDATE lanes SET current_operation_id = 'running'");
  store.appendConversationMessage('s', message);
  db.exec("UPDATE lanes SET current_operation_id = NULL; CREATE TRIGGER fault BEFORE DELETE ON runtime_pending_messages BEGIN SELECT RAISE(ABORT, 'drain fault'); END");
  expect(() => store.flushConversationMessages('s')).toThrow('drain fault');
  expect(await store.getEntry(message.id)).toBeNull();
  expect(store.readConversationMessages('s')).toEqual([message]);
  db.exec('DROP TRIGGER fault');
  store.flushConversationMessages('s');
  expect(store.readConversationMessages('s')).toEqual([message]);
});
it('rejects conflicting delivery IDs and deletes pending facts with the session', async () => {
  const { store, db } = await fixture();
  db.exec("UPDATE lanes SET current_operation_id = 'running'");
  store.appendConversationMessage('s', message);
  expect(() => store.appendConversationMessage('s', { ...message, content: [] })).toThrow('runtime_message_conflict');
  await store.deleteSession('s');
  expect(store.readConversationMessages('s')).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_pending_messages').get()).toMatchObject({ count: 0 });
  expect(() => store.appendConversationMessage('s', message)).toThrow('runtime_session_not_found');
});
it('never reimports a JSONL tail after the one-time cutover', async () => {
  const { store } = await fixture();
  store.importLegacyTranscript('s', [message], { once: true });
  expect(store.hasLegacyTranscriptCutover('s')).toBe(true);
  expect(store.importLegacyTranscript('s', [message, { ...message, id: 'stale-tail' }], { once: true }).status).toBe('unchanged');
  expect(store.readConversationMessages('s')).toEqual([message]);
});

it('permanently deleted sessions cannot be reopened by a late host preparation', async () => {
  const { store } = await fixture();
  store.appendConversationMessage('s', message);
  store.deleteSessionPermanently('s');
  store.deleteSessionPermanently('s');
  await expect(store.createSession({ id: 's', createdAt: 1 })).rejects.toThrow('runtime_session_deleted');
  expect(store.readConversationMessages('s')).toEqual([]);
});

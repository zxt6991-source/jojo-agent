import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import { SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import { readRuntimeMessages } from './transcript-reader';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
it('returns complete durable conversation history without replacing it with compaction context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-transcript-reader-'));
  const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
  cleanup.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.createSession({ id: 's', createdAt: 0 });
  const first: Message = { id: 'first', role: 'user', content: [{ type: 'text', text: 'original artifact' }], createdAt: '2026-09-01T00:00:00.000Z' };
  const last: Message = { ...first, id: 'last', role: 'assistant' };
  await store.appendEntry({ id: first.id, sessionId: 's', parentId: null, type: 'message', message: first });
  await store.appendEntry({ id: 'compact', sessionId: 's', parentId: first.id, type: 'compaction', summary: 'short summary', retainedTail: [], tokensBefore: 100 });
  await store.appendEntry({ id: last.id, sessionId: 's', parentId: 'compact', type: 'message', message: last });
  await store.saveLane({ sessionId: 's', name: 'main', leafId: last.id, currentOperationId: null });
  expect(await readRuntimeMessages(store, 's')).toEqual([first, last]);
  expect(await readRuntimeMessages(store, 'missing')).toEqual([]);
});

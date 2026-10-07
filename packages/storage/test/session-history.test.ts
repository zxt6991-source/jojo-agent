import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';
import { SessionSearchQuerySchema, SessionReadWindowQuerySchema } from '@desktop-agent/contracts';

describe('durable session history search', () => {
  it('searches Chinese and error codes, ranks main decisions, excludes private/internal/tool data and deleted sessions', async () => {
    const filename = path.join(await mkdtemp(path.join(os.tmpdir(), 'history-')), 'runtime.sqlite');
    let store = new SqliteAgentRuntimeStore(filename);
    try {
      for (const id of ['main', 'cron', 'private']) await store.createSession({ id, createdAt: 0, metadata: { source: id === 'cron' ? 'scheduler' : 'main' } });
      const leaves = new Map<string, string>();
      const append = async (sessionId: string, id: string, text: string, internal = false) => {
        await store.appendEntry({ id, sessionId, parentId: leaves.get(sessionId) ?? null, type: 'message', message: { id, role: 'user', createdAt: '2026-10-07T00:00:00.000Z', metadata: { internal }, content: [{ type: 'text', text }] } });
        leaves.set(sessionId, id);
        await store.saveLane({ sessionId, name: 'main', leafId: id, currentOperationId: null });
      };
      await append('main', 'decision', '我们选择数据库 SQLite，原因是 SQLITE_BUSY 恢复逻辑可追溯。');
      await append('main', 'internal', '数据库 SQLite internal token', true);
      await append('private', 'private-entry', '数据库 SQLite private secret');
      for (let i = 0; i < 20; i++) await append('cron', `cron-${i}`, '数据库 SQLite 日报');
      await store.appendEntry({ id: 'abandoned', sessionId: 'main', parentId: 'decision', type: 'message', message: { id: 'abandoned', role: 'assistant', createdAt: '2026-10-07T00:00:00.000Z', content: [{ type: 'text', text: '数据库 SQLite abandoned branch' }] } });
      const all = await store.searchMessages(SessionSearchQuerySchema.parse({ query: '数据库 SQLite', source: 'all' }), ['main', 'cron']);
      expect(all[0]?.entryId).toBe('decision');
      expect(all.some(hit => hit.entryId === 'private-entry' || hit.entryId === 'internal' || hit.entryId === 'abandoned')).toBe(false);
      expect(await store.searchMessages(SessionSearchQuerySchema.parse({ query: 'SQLITE_BUSY' }), ['main'])).toHaveLength(1);
      expect(await store.searchMessages(SessionSearchQuerySchema.parse({ query: '原因' }), ['main'])).toHaveLength(1);
      expect(await store.searchMessages(SessionSearchQuerySchema.parse({ query: 'SQLite OR " *' }), ['main'])).toEqual([]);
      const window = await store.readMessageWindow(SessionReadWindowQuerySchema.parse({ sessionId: 'main', anchorSeq: all[0]!.seq, maxCharacters: 12 }));
      expect(window.items.map(item => item.content).join('').length).toBeLessThanOrEqual(12);
      expect(window.truncated).toBe(true);
      store.close(); store = new SqliteAgentRuntimeStore(filename);
      expect(await store.searchMessages(SessionSearchQuerySchema.parse({ query: 'SQLite' }), ['main'])).toHaveLength(1);
      store.deleteSessionPermanently('main');
      expect(await store.searchMessages(SessionSearchQuerySchema.parse({ query: 'SQLite' }), ['main'])).toEqual([]);
      await expect(store.createSession({ id: 'main', createdAt: 0 })).rejects.toThrow('runtime_session_deleted');
    } finally { store.close(); }
  });
});

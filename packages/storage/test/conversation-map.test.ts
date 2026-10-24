import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { ScriptedProvider, describeTestProvider, createTestExecutionSnapshot } from '@desktop-agent/agent-runtime/testing';
import type { ConversationMapHistoryQuery, Message } from '@desktop-agent/contracts';
import type { Session } from '@desktop-agent/agent-runtime/spi';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';
import { canonicalConversationMapDirectory } from '../src/sqlite-conversation-map.js';

const when = '2026-10-12T10:00:00.000Z';
const query: ConversationMapHistoryQuery = {
  rangeStart: '2026-10-01T00:00:00.000Z', rangeEnd: '2026-10-24T00:00:00.000Z', scope: { kind: 'personal_main' }, limit: 100
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-map-'));
  const store = new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
  const leaves = new Map<string, string>();
  async function session(id: string, metadata: Session['metadata'] = {}) {
    await store.createSession({ id, createdAt: 1, metadata });
    await store.saveLane({ sessionId: id, name: 'main', leafId: null, currentOperationId: null });
  }
  async function append(sessionId: string, id: string, role: Message['role'] = 'user', text = id, options: Partial<Message> = {}) {
    const entry = await store.appendEntry({ id, sessionId, parentId: leaves.get(sessionId) ?? null, type: 'message',
      message: { id: `message-${id}`, createdAt: when, content: [{ type: 'text', text }], role, ...options } });
    leaves.set(sessionId, id);
    await store.saveLane({ sessionId, name: 'main', leafId: id, currentOperationId: null });
    return entry;
  }
  return { directory, store, session, append };
}

describe('conversation map bounded private history', () => {
  it('pairs consecutive assistants, paginates same timestamps by stable keys and rechecks authorization on every read', async () => {
    const f = await fixture();
    try {
      await f.session('a'); await f.session('b');
      await f.append('a', 'a1'); await f.append('a', 'a2', 'assistant'); await f.append('a', 'a3', 'assistant');
      await f.append('a', 'a4'); await f.append('b', 'b1');
      const first = await f.store.readConversationMapPage({ ...query, limit: 1 }, ['a', 'b']);
      expect(first.turns.map(turn => turn.turnId)).toEqual(['a1']);
      expect(first.turns[0]?.assistants.map(item => item.reference.entryId)).toEqual(['a2', 'a3']);
      expect(first.hasMore).toBe(true);
      const second = await f.store.readConversationMapPage({ ...query, limit: 1, cursor: first.nextCursor! }, ['a', 'b']);
      expect(second.turns.map(turn => turn.turnId)).toEqual(['a4']);
      expect(second.turns[0]?.assistants).toEqual([]);
      expect(await f.store.readConversationMapPage({ ...query, cursor: second.nextCursor! }, ['a'])).toEqual({ turns: [], hasMore: false });
      expect((await f.store.readConversationMapPage({ ...query, cursor: second.nextCursor! }, ['b'])).turns[0]?.turnId).toBe('b1');
      expect(await f.store.readConversationMapPage(query, [])).toEqual({ turns: [], hasMore: false });
      expect(await f.store.readConversationMapSource({ sessionId: 'a', entryId: 'a1', scope: query.scope }, ['b'])).toEqual({ available: false });
      await expect(f.store.readConversationMapPage({ ...query, limit: 101 }, ['a'])).rejects.toThrow();
      await expect(f.store.readConversationMapPage(query, Array.from({ length: 1001 }, (_, index) => `s${index}`))).rejects.toThrow('scope_too_large');
    } finally { f.store.close(); }
  });

  it('uses message date, durable main ancestry and text only, excluding abandoned/internal/tool/attachment/scheduler records', async () => {
    const f = await fixture();
    try {
      await f.session('s');
      await f.append('s', 'old', 'user', 'old', { createdAt: '2026-09-01T00:00:00.000Z' });
      await f.append('s', 'question', 'user', '', { content: [{ type: 'text', text: 'ordinary text' },
        { type: 'text', text: 'ATTACHMENT_SECRET', attachment: { name: 'file.txt', relativePath: 'file.txt', size: 17, truncated: false } }] });
      await f.append('s', 'answer', 'assistant');
      await f.append('s', 'internal', 'assistant', 'INTERNAL_SECRET', { metadata: { internal: true } });
      await f.append('s', 'tool', 'tool', 'TOOL_SECRET');
      await f.append('s', 'automation', 'user', 'SCHEDULER_SECRET', { metadata: { source: 'scheduler' } });
      await f.append('s', 'automation-answer', 'assistant');
      await f.append('s', 'current');
      await f.store.appendEntry({ id: 'abandoned', sessionId: 's', parentId: 'question', type: 'message',
        message: { id: 'abandoned', role: 'user', createdAt: when, content: [{ type: 'text', text: 'ABANDONED_SECRET' }] } });
      await f.store.saveLane({ sessionId: 's', name: 'side', leafId: 'abandoned', currentOperationId: null });
      await f.store.appendEntry({ id: 'compact', sessionId: 's', parentId: 'current', type: 'compaction',
        summary: 'COMPACTION_SECRET', retainedTail: [], tokensBefore: 10 });
      await f.store.saveLane({ sessionId: 's', name: 'main', leafId: 'compact', currentOperationId: null });
      const page = await f.store.readConversationMapPage(query, ['s']);
      expect(page.turns.map(turn => turn.turnId)).toEqual(['question', 'current']);
      expect(page.turns[0]?.user.text).toBe('ordinary text');
      expect(page.turns[0]?.assistants.map(item => item.reference.entryId)).toEqual(['answer']);
      expect(JSON.stringify(page)).not.toContain('SECRET');
      expect(await f.store.readConversationMapSource({ sessionId: 's', entryId: 'abandoned', scope: query.scope }, ['s'])).toEqual({ available: false });
      expect(await f.store.readConversationMapSource({ sessionId: 's', entryId: 'question', scope: query.scope }, ['s'])).toMatchObject({ available: true, messageId: 'message-question', text: 'ordinary text' });
      f.store.deleteSessionPermanently('s');
      expect(await f.store.readConversationMapPage(query, ['s'])).toEqual({ turns: [], hasMore: false });
      expect(await f.store.readConversationMapSource({ sessionId: 's', entryId: 'question', scope: query.scope }, ['s'])).toEqual({ available: false });
    } finally { f.store.close(); }
  });

  it('matches canonical project directories exactly and excludes channel/team/spawn/automation session provenance', async () => {
    const f = await fixture();
    try {
      const project = path.join(f.directory, 'project');
      await mkdir(project); await symlink(project, path.join(f.directory, 'alias'));
      const samples: Array<[string, Session['metadata']]> = [
        ['main', { __runtimeExecutionScope: { kind: 'workspace', workingDirectory: project } }],
        ['alias', { __runtimeWorkingDirectory: path.join(f.directory, 'alias') }],
        ['other', { __runtimeWorkingDirectory: `${project}-private` }],
        ['nested', { __runtimeWorkingDirectory: path.join(project, 'nested') }],
        ['custom', { __runtimeExecutionScope: { kind: 'none' }, __runtimeWorkingDirectory: project }],
        ['channel', { channel: { bindingId: 'private' }, __runtimeWorkingDirectory: project }],
        ...['team', 'spawn', 'subagent', 'scheduler', 'workflow', 'channel', 'unknown'].map(source => [`source-${source}`, { source, __runtimeWorkingDirectory: project }] as [string, Session['metadata']])
      ];
      for (const [id, metadata] of samples) { await f.session(id, metadata); await f.append(id, `${id}-user`); }
      const allowed = samples.map(([id]) => id);
      const scope = { kind: 'project' as const, workingDirectory: `${project}/../project/` };
      expect((await f.store.readConversationMapPage({ ...query, scope }, allowed)).turns.map(turn => turn.sessionId)).toEqual(['alias', 'main']);
      expect(await f.store.readConversationMapSource({ sessionId: 'other', entryId: 'other-user', scope }, allowed)).toEqual({ available: false });
      expect(canonicalConversationMapDirectory(path.join(f.directory, 'alias'))).toBe(canonicalConversationMapDirectory(project));
      await expect(f.store.readConversationMapPage({ ...query, scope: { kind: 'project', workingDirectory: 'relative' } }, allowed)).rejects.toThrow('invalid_project');
    } finally { f.store.close(); }
  });

  it('clips oversized messages and excessive assistant replies with explicit truncation', async () => {
    const f = await fixture();
    try {
      await f.session('s'); await f.append('s', 'large', 'user', 'x'.repeat(5000));
      for (let i = 0; i < 21; i++) await f.append('s', `a${i}`, 'assistant');
      const turn = (await f.store.readConversationMapPage(query, ['s'])).turns[0]!;
      expect(turn.user.text).toHaveLength(3000); expect(turn.user.truncated).toBe(true);
      expect(turn.assistants).toHaveLength(20); expect(turn.truncated).toBe(true);
      expect(await f.store.readConversationMapSource({ sessionId: 's', entryId: 'large', scope: query.scope }, ['s'])).toMatchObject({ available: true, truncated: true });
    } finally { f.store.close(); }
  });

  it('bounds UTF-16 message length and marks emoji clipping accurately', async () => {
    const f = await fixture();
    try {
      await f.session('s'); await f.append('s', 'emoji', 'user', '🙂'.repeat(2500));
      const turn = (await f.store.readConversationMapPage(query, ['s'])).turns[0]!;
      expect(turn.user.text).toHaveLength(3000); expect(turn.user.truncated).toBe(true);
      expect(await f.store.readConversationMapSource({ sessionId: 's', entryId: 'emoji', scope: query.scope }, ['s'])).toMatchObject({ available: true, truncated: true });
    } finally { f.store.close(); }
  });

  it('excludes nonpersonal durable execution even when session metadata looks like a main conversation', async () => {
    const f = await fixture();
    try {
      for (const trigger of ['user', 'scheduler', 'channel_message', 'team_member', 'subagent', 'workflow', 'api'] as const) {
        await f.session(trigger); await f.append(trigger, `${trigger}-user`);
        const execution = createTestExecutionSnapshot({ trigger: { kind: trigger } });
        await f.store.startOperation({ id: `op-${trigger}`, sessionId: trigger, lane: 'main', kind: 'run', createdAt: 1,
          providerId: 'provider-1', model: 'model-1', maxIterations: 12, execution }, {
          phase: 'ready', operationId: `op-${trigger}`, lane: 'main', iteration: 0, outputContinuations: 0,
          progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
        });
      }
      expect((await f.store.readConversationMapPage(query, ['user', 'scheduler', 'channel_message', 'team_member', 'subagent', 'workflow', 'api'])).turns.map(turn => turn.sessionId)).toEqual(['user']);
    } finally { f.store.close(); }
  });

  it('reads actual public-runtime Desktop user turns and rejects public-runtime channel actors', async () => {
    const f = await fixture();
    // Runtime's injected clock timestamps session metadata, but the message
    // factories use Date directly. Freeze Date too, without faking async timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(when));
    try {
      const runtime = createAgentRuntime({ store: f.store, now: () => new Date(when), environment: {
        host: { kind: 'test' }, providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([[
          { type: 'text_delta', text: 'AI recommendation' }, { type: 'response_completed', stopReason: 'stop' }
        ]]) }, tools: { resolve: () => ({ snapshot: () => [] }) }, permissions: { check: async () => ({ decision: 'allow' }) }
      } });
      for (const id of ['desktop', 'channel']) {
        const session = await runtime.openSession({ id, executionScope: { kind: 'workspace', workingDirectory: f.directory } });
        const lane = await session.getLane('main');
        const run = await lane.run({ providerId: 'p', model: 'm', input: 'Which approach should I use?',
          actor: { kind: id === 'desktop' ? 'main' : 'channel_user' }, trigger: { kind: id === 'desktop' ? 'user' : 'channel_message' } });
        await run.result;
      }
      const scope = { kind: 'project' as const, workingDirectory: f.directory };
      const page = await f.store.readConversationMapPage({ ...query, scope }, ['desktop', 'channel']);
      expect(page.turns).toHaveLength(1); expect(page.turns[0]?.sessionId).toBe('desktop');
      expect(page.turns[0]?.user.reference.createdAt).toBe(when);
      expect(page.turns[0]?.assistants[0]?.reference.createdAt).toBe(when);
      expect(page.turns[0]?.assistants[0]?.text).toBe('AI recommendation');
      // The reader retains its inclusive start / exclusive end date boundary.
      expect((await f.store.readConversationMapPage({ ...query, scope, rangeStart: when }, ['desktop', 'channel'])).turns).toHaveLength(1);
      expect((await f.store.readConversationMapPage({ ...query, scope, rangeEnd: when }, ['desktop', 'channel'])).turns).toEqual([]);
    } finally { vi.useRealTimers(); f.store.close(); }
  });
});

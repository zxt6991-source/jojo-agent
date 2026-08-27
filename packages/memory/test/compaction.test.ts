import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCompactInput } from '@desktop-agent/agent-runtime/memory';
import { createProjectIdentity, DurableMemoryRuntime, MarkdownMemoryStore, MemoryIndex } from '../src/index.js';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-compaction-'));
  directories.push(directory);
  const index = new MemoryIndex(path.join(directory, 'memory.sqlite'));
  const store = new MarkdownMemoryStore(path.join(directory, 'memory'), index);
  await store.initialize();
  const identity = await createProjectIdentity(directory);
  if (!identity) throw new Error('Expected project identity.');
  return { directory, index, store, identity, runtime: new DurableMemoryRuntime(store) };
}

function compactInput(overrides: Partial<MemoryCompactInput> = {}): MemoryCompactInput {
  return {
    sessionId: 'sess_1',
    operationId: 'op_compact',
    lane: 'main',
    compactionOrdinal: 1,
    currentSnapshotId: 'snapshot_1',
    messagesToSummarize: [{
      id: 'message_1', role: 'user', createdAt: '2026-08-23T08:00:00.000Z',
      content: [{ type: 'text', text: 'continue' }]
    }],
    retainedTail: [],
    memoryToolEvents: [],
    currentSnapshotScopeVersions: {},
    signal: new AbortController().signal,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('M4 compaction memory checkpoint', () => {
  it('does not refresh an unchanged empty snapshot', async () => {
    const { index, store, identity, runtime } = await fixture();
    const snapshot = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_1', projectIdentity: identity,
      contextWindowTokens: 128_000, signal: new AbortController().signal
    });
    const result = await runtime.beforeCompact(compactInput({
      projectIdentity: identity,
      currentSnapshotId: snapshot.id,
      currentSnapshotScopeVersions: snapshot.scopeVersions
    }));
    expect(result.refreshSnapshot).toBe(false);
    expect(result.handoff).toMatchObject({ openTasks: [], decisions: [], memoryWrites: [] });
    await store.rebuildIndex(store.globalScope());
    const afterIndexRebuild = await runtime.beforeCompact(compactInput({
      projectIdentity: identity,
      currentSnapshotId: snapshot.id,
      currentSnapshotScopeVersions: snapshot.scopeVersions
    }));
    expect(afterIndexRebuild.refreshSnapshot).toBe(false);
    index.close();
  });

  it('builds a deterministic handoff, appends Daily once, and refreshes after a scope change', async () => {
    const { index, store, identity, runtime } = await fixture();
    const snapshot = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_1', projectIdentity: identity,
      contextWindowTokens: 128_000, signal: new AbortController().signal
    });
    const scope = store.projectScope(identity);
    const scratchpad = await store.read(scope, 'SCRATCHPAD.md');
    await store.patch({
      scope,
      path: 'SCRATCHPAD.md',
      expectedRevision: scratchpad.revision,
      patch: { type: 'append', content: '- [ ] Finish Windows E2E\n\n## Decisions\n- Use SHA-256 revisions.' }
    });
    const input = compactInput({
      projectIdentity: identity,
      currentSnapshotId: snapshot.id,
      currentSnapshotScopeVersions: snapshot.scopeVersions,
      memoryToolEvents: [{
        toolCallId: 'call_1', effect: 'memory.write', scope: 'project',
        entryId: 'mem_1', result: 'success'
      }]
    });
    const first = await runtime.beforeCompact(input);
    const second = await runtime.beforeCompact(input);
    expect(first.refreshSnapshot).toBe(true);
    expect(second.handoff).toEqual(first.handoff);
    expect(first.handoff).toMatchObject({
      openTasks: [{ text: 'Finish Windows E2E', source: 'scratchpad' }],
      decisions: [{ text: 'Use SHA-256 revisions.', source: 'scratchpad' }],
      memoryWrites: [{ text: 'mem_1 written (project)', sourceEntryId: 'mem_1' }]
    });
    const daily = await readFile(path.join(scope.directory, 'daily', '2026-08-23.md'), 'utf8');
    expect(daily.match(/jojo-memory-handoff:/gu)).toHaveLength(1);
    const refreshed = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_compact', projectIdentity: identity,
      contextWindowTokens: 128_000, signal: new AbortController().signal
    });
    expect(refreshed.id).not.toBe(snapshot.id);
    index.close();
  });

  it('degrades a Daily append failure to a warning', async () => {
    const { index, store, identity, runtime } = await fixture();
    const snapshot = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_1', projectIdentity: identity,
      contextWindowTokens: 128_000, signal: new AbortController().signal
    });
    vi.spyOn(store, 'appendDailyHandoff').mockRejectedValueOnce(new Error('disk unavailable'));
    const result = await runtime.beforeCompact(compactInput({
      projectIdentity: identity,
      currentSnapshotId: snapshot.id,
      currentSnapshotScopeVersions: snapshot.scopeVersions,
      runtimeOpenTasks: ['Keep working']
    }));
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'memory_handoff_failed' })]);
    index.close();
  });
});

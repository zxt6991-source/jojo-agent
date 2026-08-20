import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import { projectEntriesToMessages, resumeAgentTurn } from '@desktop-agent/agent-runtime';
import { runtimeStoreConformance } from '../../agent-runtime/test/store-conformance.js';
import { SqliteAgentRuntimeStore } from '../src/index.js';

async function databaseFile(prefix: string): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), prefix)), 'runtime.sqlite');
}

describe('SqliteAgentRuntimeStore conformance', () => {
  runtimeStoreConformance(async (clock) => new SqliteAgentRuntimeStore(
    await databaseFile('agent-runtime-sqlite-'),
    clock
  ));
});

describe('SqliteAgentRuntimeStore durability', () => {
  it('reopens lanes, operation snapshots, compactions, and usage', async () => {
    const filename = await databaseFile('agent-runtime-sqlite-reopen-');
    const store = new SqliteAgentRuntimeStore(filename, { now: () => 1_000 });
    await store.createSession({ id: 'session-1', createdAt: 900 });
    const root = await store.appendEntry({
      id: 'root', sessionId: 'session-1', parentId: null, type: 'message',
      message: {
        id: 'root', role: 'user', createdAt: '2026-08-20T00:00:00.000Z',
        content: [{ type: 'text', text: 'old context' }]
      }
    });
    const compaction = await store.appendEntry({
      id: 'compaction', sessionId: 'session-1', parentId: root.id, type: 'compaction',
      summary: 'durable summary', retainedTail: [], tokensBefore: 1_000
    });
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: compaction.id, currentOperationId: null });
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 901,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, {
      phase: 'ready', operationId: 'operation-1', lane: 'main', iteration: 0,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    });
    await store.saveOperationState({
      phase: 'checkpoint', operationId: 'operation-1', lane: 'main', iteration: 1,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    });
    await store.appendUsage({
      id: 'usage-1', sessionId: 'session-1', operationId: 'operation-1', lane: 'main', cause: 'model',
      providerId: 'provider', model: 'model', inputTokens: 4, outputTokens: 2, createdAt: 902
    });
    store.close();

    const reopened = new SqliteAgentRuntimeStore(filename);
    const lane = await reopened.getLane('session-1', 'main');
    const entries = await reopened.readPath(lane?.leafId ?? null);
    expect(lane).toMatchObject({ currentOperationId: 'operation-1', leafId: 'compaction' });
    expect(await reopened.loadOperation('operation-1')).toMatchObject({ state: { phase: 'checkpoint', iteration: 1 } });
    expect(await reopened.readUsage('session-1')).toHaveLength(1);
    expect(projectEntriesToMessages(entries)).toMatchObject([{
      metadata: { internal: true },
      content: [{ type: 'text', text: expect.stringContaining('durable summary') }]
    }]);
    reopened.close();
  });

  it('rolls back operation creation when its lane is busy', async () => {
    const store = new SqliteAgentRuntimeStore(await databaseFile('agent-runtime-sqlite-atomic-'));
    await store.createSession({ id: 'session-1', createdAt: 900 });
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: null, currentOperationId: null });
    const state = {
      phase: 'ready' as const, operationId: 'operation-1', lane: 'main', iteration: 0,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    };
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 901,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, state);
    await expect(store.startOperation({
      id: 'operation-2', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 902,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, { ...state, operationId: 'operation-2' })).rejects.toThrow(/runtime_lane_busy/);
    expect(await store.loadOperation('operation-2')).toBeNull();
    expect(await store.getLane('session-1', 'main')).toMatchObject({ currentOperationId: 'operation-1' });
    store.close();
  });

  it('resumes a persisted checkpoint after reopening the database', async () => {
    const filename = await databaseFile('agent-runtime-sqlite-resume-');
    const store = new SqliteAgentRuntimeStore(filename);
    await store.createSession({ id: 'session-1', createdAt: 900 });
    const root = await store.appendEntry({
      id: 'user-1', sessionId: 'session-1', parentId: null, type: 'message',
      message: {
        id: 'user-1', role: 'user', createdAt: '2026-08-20T00:00:00.000Z',
        content: [{ type: 'text', text: 'finish after restart' }]
      }
    });
    if (root.type !== 'message') throw new Error('Expected a message entry.');
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: root.id, currentOperationId: null });
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 901,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, {
      phase: 'ready', operationId: 'operation-1', lane: 'main', iteration: 0,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    });
    await store.saveOperationState({
      phase: 'checkpoint', operationId: 'operation-1', lane: 'main', iteration: 1,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    });
    store.close();

    const reopened = new SqliteAgentRuntimeStore(filename);
    const result = await resumeAgentTurn({
      runtimeStore: reopened,
      operationId: 'operation-1',
      sessionId: 'session-1',
      workingDirectory: process.cwd(),
      providerId: 'provider',
      model: 'model',
      history: [root.message],
      provider: new ScriptedProvider([[
        { type: 'text_delta', text: 'recovered answer' },
        { type: 'response_completed', stopReason: 'stop' }
      ]]),
      tools: [],
      permissionGate: { check: async () => ({ decision: 'allow' }) },
      signal: new AbortController().signal,
      emit: () => undefined,
      approve: async () => true
    });

    expect(result.stopReason).toBe('stop');
    expect(await reopened.loadOperation('operation-1')).toMatchObject({ state: { phase: 'completed' } });
    const lane = await reopened.getLane('session-1', 'main');
    expect(lane?.currentOperationId).toBeNull();
    expect((await reopened.readPath(lane?.leafId ?? null)).at(-1)).toMatchObject({
      type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }] }
    });
    reopened.close();
  });
});

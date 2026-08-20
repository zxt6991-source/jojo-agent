import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeStoreConformance } from '../../agent-runtime/test/store-conformance.js';
import { projectEntriesToMessages } from '@desktop-agent/agent-runtime';
import { JsonlAgentRuntimeStore } from '../src/index.js';

describe('JsonlAgentRuntimeStore conformance', () => {
  runtimeStoreConformance(async (clock) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-store-'));
    return new JsonlAgentRuntimeStore(directory, clock);
  });
});

describe('JsonlAgentRuntimeStore recovery', () => {
  it('restores durable compaction entries and projects them into model context', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-compaction-'));
    const store = new JsonlAgentRuntimeStore(directory, { now: () => 1_000 });
    await store.createSession({ id: 'session-1', createdAt: 900 });
    const old = await store.appendEntry({
      id: 'old', sessionId: 'session-1', parentId: null, type: 'message',
      message: {
        id: 'old', role: 'user', createdAt: '2026-08-20T00:00:00.000Z',
        content: [{ type: 'text', text: 'large old context' }]
      }
    });
    const compaction = await store.appendEntry({
      id: 'compaction-1', sessionId: 'session-1', parentId: old.id, type: 'compaction',
      summary: 'persisted summary', retainedTail: [], tokensBefore: 10_000
    });
    await store.saveLane({
      sessionId: 'session-1', name: 'main', leafId: compaction.id, currentOperationId: null
    });

    const restarted = new JsonlAgentRuntimeStore(directory);
    const lane = await restarted.getLane('session-1', 'main');
    const entries = await restarted.readPath(lane?.leafId ?? null);

    expect(entries.map((entry) => entry.type)).toEqual(['message', 'compaction']);
    expect(projectEntriesToMessages(entries)).toMatchObject([{
      role: 'user', metadata: { internal: true },
      content: [{ type: 'text', text: expect.stringContaining('persisted summary') }]
    }]);
  });

  it('uses the last complete snapshot before a damaged tail', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-tail-'));
    const store = new JsonlAgentRuntimeStore(directory, { now: () => 1_000 });
    await store.createSession({ id: 'session-1', createdAt: 900 });
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: null, currentOperationId: null });
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
    await appendFile(path.join(directory, 'session-1.jsonl'), '{"schemaVersion":1,"type":"operation.state"');

    const restarted = new JsonlAgentRuntimeStore(directory);
    expect(await restarted.loadOperation('operation-1')).toMatchObject({ state: { phase: 'checkpoint', iteration: 1 } });
    expect(await restarted.getWarnings('session-1')).toHaveLength(1);
  });

  it('writes complete operation snapshots instead of deltas', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-snapshot-'));
    const store = new JsonlAgentRuntimeStore(directory);
    await store.createSession({ id: 'session-1', createdAt: 900 });
    await store.saveLane({ sessionId: 'session-1', name: 'main', leafId: null, currentOperationId: null });
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 901,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, {
      phase: 'ready', operationId: 'operation-1', lane: 'main', iteration: 0,
      outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
    });
    const records = (await readFile(path.join(directory, 'session-1.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      type: 'operation.started',
      state: { phase: 'ready', operationId: 'operation-1', progress: { toolCallCounts: {} } }
    });
  });
});

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryAgentRuntimeStore, createTestExecutionSnapshot } from '@desktop-agent/agent-runtime/testing';
import type { AgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import { JsonlAgentRuntimeStore } from '../src/runtime-store.js';
import { SqliteAgentRuntimeStore } from '../src/sqlite-runtime-store.js';

for (const kind of ['memory', 'jsonl', 'sqlite'] as const) describe(`${kind} execution snapshot`, () => {
  it('preserves immutable semantics through state updates and reopening', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'execution-store-'));
    const open = (): AgentRuntimeStore => kind === 'memory' ? new MemoryAgentRuntimeStore()
      : kind === 'jsonl' ? new JsonlAgentRuntimeStore(directory) : new SqliteAgentRuntimeStore(path.join(directory, 'runtime.sqlite'));
    let store = open();
    const execution = createTestExecutionSnapshot();
    const original = structuredClone(execution);
    const initial = { phase: 'ready' as const, operationId: 'o', lane: 'main', iteration: 0, outputContinuations: 0,
      progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null, iterationLimit: 12 } };
    try {
      await store.createSession({ id: 's', createdAt: 1 });
      await store.saveLane({ sessionId: 's', name: 'main', currentOperationId: null, leafId: null });
      await store.startOperation({ id: 'o', sessionId: 's', lane: 'main', kind: 'run', createdAt: 1, providerId: 'provider-1', model: 'model-1', maxIterations: 12, execution, config: { maxWallTimeMs: 3000 } }, initial);
      execution.actor.kind = 'workflow';
      await store.saveOperationState({ ...initial, phase: 'checkpoint', iteration: 1 });
      if (kind !== 'memory') {
        if (store instanceof SqliteAgentRuntimeStore) store.close();
        store = open();
      }
      expect((await store.loadOperation('o'))?.meta).toMatchObject({ execution: original, config: { maxWallTimeMs: 3000 } });
      const loaded = (await store.loadOperation('o'))!;
      loaded.meta.execution!.instructions.requested.push('must not mutate store');
      expect((await store.loadOperation('o'))?.meta.execution).toEqual(original);
      await expect(store.startOperation({ ...loaded.meta, id: 'bad', execution: { ...original, schemaVersion: 2 } as never }, { ...initial, operationId: 'bad' })).rejects.toThrow('runtime_execution_snapshot_version_unsupported');
      expect((await store.getLane('s', 'main'))?.currentOperationId).toBe('o');
    } finally { if (store instanceof SqliteAgentRuntimeStore) store.close(); }
  });
});

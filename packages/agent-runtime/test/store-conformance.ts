import { expect, it } from 'vitest';
import { createReadyState } from '../src/operation/reducer.js';
import type { OperationState } from '../src/operation/state.js';
import type { AgentRuntimeStore, Clock } from '../src/store.js';

export type StoreFactory = (clock: Clock) => Promise<AgentRuntimeStore> | AgentRuntimeStore;

export function runtimeStoreConformance(factory: StoreFactory): void {
  it('stores sessions, immutable entries, lanes, operation snapshots, and usage', async () => {
    let time = 1_000;
    const clock: Clock = { now: () => time += 1 };
    const store = await factory(clock);

    await store.createSession({ id: 'session-1', createdAt: 900, metadata: { tenant: 'test' } });
    expect(await store.getSession('session-1')).toEqual({
      id: 'session-1', createdAt: 900, metadata: { tenant: 'test' }
    });
    expect(await store.listSessions()).toEqual([
      { id: 'session-1', createdAt: 900, metadata: { tenant: 'test' } }
    ]);

    const root = await store.appendEntry({
      id: 'entry-1', sessionId: 'session-1', parentId: null, type: 'custom',
      namespace: 'test.root', payload: { value: 1 }
    });
    const child = await store.appendEntry({
      id: 'entry-2', sessionId: 'session-1', parentId: root.id, type: 'branch_summary', summary: 'branch'
    });
    expect([root.seq, child.seq]).toEqual([1, 2]);
    expect((await store.readPath(child.id)).map((entry) => entry.id)).toEqual(['entry-1', 'entry-2']);

    const returned = await store.getEntry(root.id);
    if (returned?.type === 'custom' && returned.payload && !Array.isArray(returned.payload) && typeof returned.payload === 'object') {
      returned.payload.value = 99;
    }
    expect(await store.getEntry(root.id)).toMatchObject({ payload: { value: 1 } });

    await store.saveLane({
      sessionId: 'session-1', name: 'main', leafId: child.id, currentOperationId: null
    });
    const initial = createReadyState('operation-1');
    await store.startOperation({
      id: 'operation-1', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 1_010,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, initial);
    expect(await store.getLane('session-1', 'main')).toMatchObject({ currentOperationId: 'operation-1' });
    await expect(store.saveLane({
      sessionId: 'session-1', name: 'main', leafId: child.id, currentOperationId: null
    })).rejects.toThrow(/runtime_lane_busy/);

    await expect(store.startOperation({
      id: 'operation-2', sessionId: 'session-1', lane: 'main', kind: 'run', createdAt: 1_011,
      providerId: 'provider', model: 'model', maxIterations: 12
    }, createReadyState('operation-2'))).rejects.toThrow(/runtime_lane_busy/);

    const checkpoint: OperationState = {
      ...initial,
      phase: 'checkpoint',
      iteration: 1
    };
    await store.saveOperationState(checkpoint);
    expect(await store.loadOperation('operation-1')).toEqual(expect.objectContaining({ state: checkpoint }));

    await store.appendUsage({
      id: 'usage-1', sessionId: 'session-1', operationId: 'operation-1', lane: 'main',
      cause: 'model', providerId: 'provider', model: 'model', inputTokens: 10, outputTokens: 4, createdAt: 1_012
    });
    expect(await store.readUsage('session-1')).toHaveLength(1);

    await store.saveOperationState({
      phase: 'completed', operationId: 'operation-1', lane: 'main', stopReason: 'stop', finalEntryId: child.id
    });
    expect(await store.getLane('session-1', 'main')).toMatchObject({ currentOperationId: null });
    expect(await store.listLanes('session-1')).toHaveLength(1);
  });

  it('rejects dangling tree and operation references', async () => {
    const store = await factory({ now: () => 1_000 });
    await store.createSession({ id: 'session-1', createdAt: 900 });
    await expect(store.appendEntry({
      id: 'entry', sessionId: 'session-1', parentId: 'missing', type: 'branch_summary', summary: 'bad'
    })).rejects.toThrow(/runtime_parent_not_found/);
    await expect(store.saveLane({
      sessionId: 'session-1', name: 'main', leafId: 'missing', currentOperationId: null
    })).rejects.toThrow(/runtime_lane_leaf_not_found/);
    await expect(store.saveOperationState(createReadyState('missing'))).rejects.toThrow(/runtime_operation_not_found/);
  });
}

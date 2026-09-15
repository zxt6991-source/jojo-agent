import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import { createAgentRuntime } from '../src/index.js';
import { MemoryAgentRuntimeStore } from '../src/memory-store.js';
import { createReadyState } from '../src/operation/reducer.js';
import type { OperationState, ToolsState } from '../src/operation/state.js';

function runtimeFor(store: MemoryAgentRuntimeStore, resolve = vi.fn(() => new ScriptedProvider([[{ type: 'text_delta', text: 'new answer' }, { type: 'response_completed', stopReason: 'stop' }]]))) {
  return { resolve, runtime: createAgentRuntime({ store, environment: {
    host: { kind: 'test' }, providers: { describe: describeTestProvider, resolve }, tools: { resolve: () => ({ snapshot: () => [] }) },
    permissions: { check: async () => ({ decision: 'allow' }) }
  } }) };
}
async function seed(store: MemoryAgentRuntimeStore, state: OperationState = createReadyState('old')) {
  await store.createSession({ id: 's', createdAt: 0 });
  await store.saveLane({ sessionId: 's', name: 'main', leafId: null, currentOperationId: null });
  await store.startOperation({ id: 'old', sessionId: 's', lane: 'main', kind: 'run', createdAt: 0, providerId: 'p', model: 'm', maxIterations: 5 }, state);
}
function tools(status: ToolsState['calls'][number]['status']): ToolsState {
  return { ...createReadyState('old'), phase: 'tools', assistantEntryId: 'a', currentIndex: 0,
    noProgressDetected: false, finalResponseOnly: false,
    calls: [{ toolIndex: 0, callId: 'c', toolName: 'write', input: {}, resultEntryId: 'r', replay: 'safe', permission: 'approved', status, ...(status === 'completed' ? { result: { callId: 'c', ok: true, content: 'done' } } : {}) }] };
}
async function assistant(store: MemoryAgentRuntimeStore) {
  await store.appendEntry({ id: 'a', sessionId: 's', parentId: null, type: 'message', message: {
    id: 'a', createdAt: new Date(0).toISOString(), role: 'assistant', content: [{ type: 'tool_call', call: { id: 'c', name: 'write', input: {} } }]
  } });
  await store.saveLane({ sessionId: 's', name: 'main', leafId: 'a', currentOperationId: 'old' });
}

describe('interrupt recovery', () => {
  it.each(['planned', 'effect_pending'] as const)('settles %s without resolving a provider and allows another run', async status => {
    const store = new MemoryAgentRuntimeStore();
    await seed(store, tools(status));
    await assistant(store);
    const { runtime, resolve } = runtimeFor(store);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(await store.getEntry('r')).toMatchObject({ message: { content: [{ result: {
      code: status === 'planned' ? 'interrupted_before_execution' : 'interrupted_uncertain_effect'
    } }] } });
    const before = await store.readPath('r');
    await runtime.recoverInterruptedOperations({ reason: 'host_restart' });
    expect(await store.readPath('r')).toEqual(before);
    await expect(runtime.resumeOperation({ operationId: 'old' })).rejects.toThrow('runtime_operation_terminal');
    const lane = await (await runtime.getSession('s'))!.getLane();
    expect((await (await lane.run({ input: 'next', providerId: 'p', model: 'm' })).result).status).toBe('completed');
    expect(await runtime.inspectRun('old')).toMatchObject({ result: { error: { code: 'runtime_interrupted', detail: { leafId: 'r' } } } });
    await runtime.close();
  });

  it('reconnects a real result committed before the leaf and preserves it on repeated recovery', async () => {
    const store = new MemoryAgentRuntimeStore();
    await seed(store, tools('effect_pending')); await assistant(store);
    await store.appendEntry({ id: 'r', sessionId: 's', parentId: 'a', type: 'message', message: {
      id: 'r', createdAt: new Date(0).toISOString(), role: 'tool', content: [{ type: 'tool_result', result: { callId: 'c', ok: true, content: 'real result' } }]
    } });
    const { runtime } = runtimeFor(store);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).outcomes[0]?.uncertainToolCallIds).toEqual([]);
    expect(await store.getLane('s', 'main')).toMatchObject({ leafId: 'r', currentOperationId: null });
    expect(await store.getEntry('r')).toMatchObject({ message: { content: [{ result: { ok: true } }] } });
  });

  it('rejects completed calls with no result and leaves the lane occupied', async () => {
    const store = new MemoryAgentRuntimeStore(); await seed(store, tools('completed')); await assistant(store);
    const { runtime } = runtimeFor(store);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(false);
    expect(await store.getLane('s', 'main')).toMatchObject({ currentOperationId: 'old' });
  });

  it('recognizes assistant entries committed while model_pending', async () => {
    const store = new MemoryAgentRuntimeStore();
    await seed(store, { ...createReadyState('old'), phase: 'model_pending', responseEntryId: 'a', usageId: 'u', attempt: 1,
      request: { providerId: 'p', model: 'm', toolNames: ['write'], maxOutputTokens: 100, finalResponseOnly: false } });
    await assistant(store);
    const { runtime } = runtimeFor(store);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(true);
    const lane = await store.getLane('s', 'main');
    expect(await store.getEntry(lane!.leafId!)).toMatchObject({ message: { content: [{ result: { code: 'interrupted_before_execution' } }] } });
  });

  it('shares concurrent recovery, gates execution, and retries after a storage failure', async () => {
    const store = new MemoryAgentRuntimeStore(); await seed(store);
    const { runtime } = runtimeFor(store);
    const lane = await (await runtime.getSession('s'))!.getLane();
    const original = store.listSessions.bind(store);
    let release!: () => void;
    vi.spyOn(store, 'listSessions').mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
    const first = runtime.recoverInterruptedOperations({ reason: 'host_restart' });
    expect(runtime.recoverInterruptedOperations({ reason: 'host_restart' })).toBe(first);
    await expect(lane.run({ input: 'no', providerId: 'p', model: 'm' })).rejects.toThrow('runtime_recovery_busy');
    await expect(runtime.resumeOperation({ operationId: 'old' })).rejects.toThrow('runtime_recovery_busy');
    vi.spyOn(store, 'saveOperationState').mockRejectedValueOnce(new Error('disk full'));
    release(); await expect(first).rejects.toThrow('disk full');
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(true);
  });

  it('persists the explicit interruption reason and preserves terminal history', async () => {
    const store = new MemoryAgentRuntimeStore(); await seed(store);
    const { runtime } = runtimeFor(store);
    await expect(runtime.interruptOperation({ operationId: 'missing', reason: 'resume_unavailable' })).rejects.toMatchObject({ code: 'runtime_operation_not_found' });
    expect(await runtime.interruptOperation({ operationId: 'old', reason: 'resume_unavailable' })).toMatchObject({ status: 'interrupted' });
    const before = await store.loadOperation('old');
    expect(before).toMatchObject({ state: { error: { detail: { reason: 'resume_unavailable' } } } });
    await store.saveLane({ sessionId: 's', name: 'main', leafId: null, currentOperationId: 'old' });
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).outcomes[0]?.status).toBe('already_terminal');
    expect(await store.loadOperation('old')).toEqual(before);
    expect(await runtime.interruptOperation({ operationId: 'old', reason: 'host_restart' })).toMatchObject({ status: 'already_terminal' });
    vi.spyOn(store, 'listLanes').mockResolvedValue([{ sessionId: 's', name: 'main', leafId: null, currentOperationId: 'missing' }]);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(false);
  });

  it('does not move the leaf backward when multiple recovery results were committed before a crash', async () => {
    const store = new MemoryAgentRuntimeStore();
    const state = tools('effect_pending');
    state.calls.push({ ...state.calls[0]!, toolIndex: 1, callId: 'c2', resultEntryId: 'r2', status: 'planned' });
    await seed(store, state);
    await store.appendEntry({ id: 'a', sessionId: 's', parentId: null, type: 'message', message: {
      id: 'a', createdAt: new Date(0).toISOString(), role: 'assistant', content: state.calls.map(call => ({ type: 'tool_call' as const, call: { id: call.callId, name: call.toolName, input: {} } }))
    } });
    await store.saveLane({ sessionId: 's', name: 'main', leafId: 'a', currentOperationId: 'old' });
    const { runtime } = runtimeFor(store);
    vi.spyOn(store, 'saveOperationState').mockRejectedValueOnce(new Error('crash'));
    await expect(runtime.recoverInterruptedOperations({ reason: 'host_restart' })).rejects.toThrow('crash');
    const entries = await store.readPath('r2');
    expect(entries.map(entry => entry.id)).toEqual(['a', 'r', 'r2']);
    expect((await runtime.recoverInterruptedOperations({ reason: 'host_restart' })).ready).toBe(true);
    expect((await store.getLane('s', 'main'))?.leafId).toBe('r2');
    expect(await store.readPath('r2')).toEqual(entries);
  });

  it('blocks recovery while a run is establishing lane ownership', async () => {
    const store = new MemoryAgentRuntimeStore();
    const { runtime } = runtimeFor(store);
    const lane = await (await runtime.openSession({ id: 's' })).getLane();
    const getLane = store.getLane.bind(store);
    let release!: () => void;
    vi.spyOn(store, 'getLane').mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; });
      return getLane(...args);
    });
    const starting = lane.run({ input: 'start', providerId: 'p', model: 'm' });
    await expect(runtime.recoverInterruptedOperations({ reason: 'host_restart' })).rejects.toThrow('runtime_recovery_busy');
    release(); await (await starting).result;
    await runtime.close();
  });

  it('keeps historical completed output bound to its own final entry', async () => {
    const store = new MemoryAgentRuntimeStore();
    const { runtime } = runtimeFor(store, vi.fn(() => new ScriptedProvider([[{ type: 'text_delta', text: 'answer' }, { type: 'response_completed', stopReason: 'stop' }]])));
    const lane = await (await runtime.openSession({ id: 's' })).getLane();
    const first = await lane.run({ runId: 'first', input: 'one', providerId: 'p', model: 'm' }); await first.result;
    const before = await runtime.inspectRun('first');
    await (await lane.run({ runId: 'second', input: 'two', providerId: 'p', model: 'm' })).result;
    expect(await runtime.inspectRun('first')).toEqual(before);
    await runtime.close();
  });
});

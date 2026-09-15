import { describe, expect, it, vi } from 'vitest';
import type { ModelRequest } from '@desktop-agent/contracts';
import { createAgentRuntime, executionFingerprint, instructionContentHash, type RuntimeEnvironment, type RuntimeResolutionContext, type RuntimeActor, type OperationExecutionSnapshotV1 } from '../src/index.js';
import { createTestExecutionSnapshot, describeTestProvider, MemoryAgentRuntimeStore, ScriptedProvider } from '../src/testing/index.js';
import { createReadyState } from '../src/operation/reducer.js';
import { executionInstructions } from '../src/operation/execution-snapshot.js';

const instructionBlock = { id: 'a', source: 'mcp', kind: 'instruction' as const, priority: 50, content: 'extension text',
  sourceFingerprint: executionFingerprint('source-v1'), contentHash: instructionContentHash('extension text') };
async function fixture(actor: RuntimeActor = { kind: 'main' }, config: Record<string, number> = {}, overrides: Partial<OperationExecutionSnapshotV1> = {}) {
  const store = new MemoryAgentRuntimeStore();
  const contexts: RuntimeResolutionContext[] = [];
  const requests: ModelRequest[] = [];
  const resolveProvider = vi.fn((context: RuntimeResolutionContext) => {
    contexts.push(context);
    return { async *stream(request: ModelRequest) { requests.push(request); yield { type: 'text_delta' as const, text: 'done' }; yield { type: 'response_completed' as const, stopReason: 'stop' }; } };
  });
  const snapshotTools = vi.fn(() => []);
  const resolveTools = vi.fn((context: RuntimeResolutionContext) => { contexts.push(context); return { snapshot: snapshotTools }; });
  const environment: RuntimeEnvironment = { host: { kind: 'test' }, providers: { describe: describeTestProvider, resolve: resolveProvider },
    tools: { resolve: resolveTools }, permissions: { check: async () => ({ decision: 'allow' }) },
    runContext: { resolve: context => { contexts.push(context); return { instructionBlocks: [instructionBlock] }; } },
    telemetry: { diagnostic: (_event, context) => { expect(context.actor).toEqual(actor); expect(context.trigger).toEqual({ kind: 'scheduler', id: 'schedule-original' }); } }
  };
  const runtime = createAgentRuntime({ store, environment });
  await runtime.openSession({ id: 's', executionScope: { kind: 'none' } });
  const execution = createTestExecutionSnapshot({ actor, trigger: { kind: 'scheduler', id: 'schedule-original' },
    workflow: { id: 'workflow-original', stepId: 'step-original' }, team: { id: 'team-original', memberId: 'member-original' },
    budget: { maxIterations: 12, contextWindowTokens: 48000, maxOutputTokens: 1024, allowPartialOnLimit: true },
    instructions: executionInstructions(['base one', 'base one'], [instructionBlock]), ...overrides });
  const ready = createReadyState('o', 'main', 12);
  ready.progress.startedAt = Date.now() - 10000;
  ready.progress.toolCalls = 3;
  ready.progress.usage = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 120, costUsd: 0 };
  await store.startOperation({ id: 'o', sessionId: 's', lane: 'main', kind: 'run', createdAt: 1,
    providerId: 'provider-1', model: 'model-1', maxIterations: 12, execution, config }, { ...ready, phase: 'model_pending',
    responseEntryId: 'response', usageId: 'usage', attempt: 1,
    request: { providerId: 'provider-1', model: 'model-1', maxOutputTokens: 1024, toolNames: [], finalResponseOnly: false } });
  return { store, runtime, environment, contexts, requests, resolveProvider, resolveTools, snapshotTools, execution };
}

describe('semantic recovery preflight', () => {
  it.each(['main', 'subagent', 'workflow', 'team_member', 'channel_user'] as const)('restores %s identity and full original budget/instructions', async kind => {
    const f = await fixture({ kind, id: 'original-actor', profile: 'general' });
    const states: unknown[] = [];
    const save = f.store.saveOperationState.bind(f.store);
    vi.spyOn(f.store, 'saveOperationState').mockImplementation(async state => { states.push(structuredClone(state)); await save(state); });
    const result = await (await f.runtime.resumeOperation({ operationId: 'o' })).result;
    expect(result.status).toBe('completed');
    expect(f.requests[0]).toMatchObject({ model: 'model-1', maxOutputTokens: 1024 });
    expect(f.requests[0]?.instructions?.filter(text => text === 'base one')).toHaveLength(2);
    expect(f.requests[0]?.instructions?.filter(text => text === 'extension text')).toHaveLength(1);
    for (const context of f.contexts) expect(context).toMatchObject({ actor: f.execution.actor, trigger: f.execution.trigger,
      workflow: f.execution.workflow, team: f.execution.team, recovery: { operationId: 'o' } });
    expect(f.snapshotTools).toHaveBeenCalledWith(expect.objectContaining({ contextWindowTokens: 48000, maxOutputTokens: 1024 }));
    expect(states[0]).toMatchObject({ progress: { toolCalls: 3, usage: { totalTokens: 120 } }, attempt: 2 });
    expect((await f.store.loadOperation('o'))?.meta.execution).toEqual(f.execution);
    const summary = await f.runtime.inspectRun('o');
    expect(summary?.execution?.actor).toEqual(f.execution.actor);
    expect(JSON.stringify(summary?.execution)).not.toContain('base one');
    await expect(f.runtime.resumeOperation({ operationId: 'o' })).rejects.toThrow('runtime_operation_terminal');
    await f.runtime.close();
  });
  it.each(['provider', 'instructions', 'policy', 'memory', 'scope'] as const)('rejects changed %s before resolving provider/tools', async part => {
    const f = await fixture();
    if (part === 'provider') f.environment.providers.describe = context => ({ ...describeTestProvider(context), configurationFingerprint: executionFingerprint('changed') });
    if (part === 'instructions') f.environment.runContext = { resolve: () => ({ instructionBlocks: [] }) };
    if (part === 'policy') f.environment.runContext = { resolve: () => ({ instructionBlocks: [instructionBlock], executionPolicyFingerprint: executionFingerprint('changed') }) };
    if (part === 'memory') f.environment.runContext = { resolve: () => ({ instructionBlocks: [instructionBlock], memoryBinding: { mode: 'none', childSnapshotId: 'new', parentSnapshotId: 'p' } }) };
    if (part === 'scope') vi.spyOn(f.store, 'getSession').mockResolvedValue({ id: 's', createdAt: 1, metadata: { __runtimeExecutionScope: { kind: 'workspace', workingDirectory: '/changed' } } });
    await expect(f.runtime.resumeOperation({ operationId: 'o' })).rejects.toThrow(`runtime_resume_${part === 'memory' ? 'memory_binding' : part}_changed`);
    expect(f.resolveProvider).not.toHaveBeenCalled();
    expect(f.resolveTools).not.toHaveBeenCalled();
    expect((await f.store.loadOperation('o'))?.state.phase).toBe('model_pending');
    await f.runtime.close();
  });
  it.each([{ maxWallTimeMs: 1 }, { maxTotalTokens: 100 }, { maxToolCalls: 2 }])('keeps spent budgets on a pending model request: %j', async config => {
    const f = await fixture({ kind: 'main' }, config);
    const result = await (await f.runtime.resumeOperation({ operationId: 'o' })).result;
    expect(result.status).toBe('completed');
    expect(['time_budget', 'token_budget', 'tool_call_budget']).toContain(result.stopReason);
    expect(f.requests[0]?.tools).toEqual([]);
    expect(f.requests[0]?.instructions).toContain('base one');
    await f.runtime.close();
  });
  it.each([
    { mode: 'project-minimal' as const, childSnapshotId: 'memory', parentSnapshotId: 'parent' },
    { mode: 'project-minimal' as const, memorySnapshotId: 'memory', teamId: 'team', memberId: 'member' },
    { memorySnapshotId: 'memory', contentHash: 'memory-hash', scopeVersions: {}, createdAt: 1 }
  ])('requires the exact durable Memory snapshot for %j', async memoryBinding => {
    const runContext = { executionPolicyFingerprint: executionFingerprint('runtime-main-policy-v1'), memoryBinding };
    const f = await fixture({ kind: 'main' }, {}, { runContext });
    f.environment.runContext = { resolve: () => ({ ...runContext, instructionBlocks: [instructionBlock] }) };
    await expect(f.runtime.resumeOperation({ operationId: 'o' })).rejects.toThrow('runtime_resume_memory_binding_changed');
    expect(f.resolveProvider).not.toHaveBeenCalled();
    await f.store.appendEntry({ id: 'memory-entry', sessionId: 's', parentId: null, type: 'memory_snapshot',
      snapshotId: 'memory', content: 'bound memory', contentHash: 'memory-hash', sourceEntryIds: [], scopeVersions: {}, estimatedTokens: 3, refreshedBy: 'session_start' });
    await f.store.saveLane({ sessionId: 's', name: 'main', leafId: 'memory-entry', currentOperationId: 'o' });
    expect((await (await f.runtime.resumeOperation({ operationId: 'o' })).result).status).toBe('completed');
    await f.runtime.close();
  });
  it('captures public runs before tool snapshots and clones caller input', async () => {
    const store = new MemoryAgentRuntimeStore();
    const instructions = ['original', 'original'];
    let release!: () => void;
    const resolving = new Promise<void>(resolve => { release = resolve; });
    const runtime = createAgentRuntime({ store, environment: { host: { kind: 'test' },
      providers: { describe: describeTestProvider, resolve: async () => { await resolving; return new ScriptedProvider([[{ type: 'response_completed', stopReason: 'stop' }]]); } },
      tools: { resolve: () => ({ snapshot: () => [] }) }, permissions: { check: async () => ({ decision: 'allow' }) } } });
    const lane = await (await runtime.openSession({ id: 's' })).getLane();
    const starting = lane.run({ runId: 'o', input: 'hello', providerId: 'p', model: 'm', instructions, budget: { contextWindowTokens: 48000, maxOutputTokens: 1024 } });
    instructions.push('mutation'); release();
    expect((await (await starting).result).status).toBe('completed');
    expect((await store.loadOperation('o'))?.meta.execution?.instructions.requested).toEqual(['original', 'original']);
    await runtime.close();
  });
});

import { expect, it, vi } from 'vitest';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { describeTestProvider, ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { ApplicationContext, PendingApprovalSnapshot } from '@desktop-agent/contracts/application';
import { createJojoAppService, MemoryServerStateStore, type ApplicationApprovalBroker, type ApprovalEvent, type JojoAppServiceOptions } from '../src/index.js';

const ctx: ApplicationContext = { requestId: 'test', principal: { id: 'local', type: 'local', scopes: [] } };
const input = { laneId: 'main', providerId: 'p', model: 'm', input: { content: [{ type: 'text' as const, text: 'hello' }] } };

async function capturedRun(runtime: ReturnType<typeof createAgentRuntime>) {
  const session = await runtime.openSession({ id: 's', executionScope: { kind: 'none' } });
  const result = await (await (await session.getLane()).run({ ...input, runId: 'captured' })).result;
  const snapshot = (await runtime.inspectRun('captured'))!;
  return { result, snapshot };
}

function fixture(options: JojoAppServiceOptions = {}) {
  const stateStore = new MemoryServerStateStore();
  const runtime = createAgentRuntime({ environment: {
    host: { kind: 'test' },
    providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([[
      { type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }
    ]]) },
    tools: { resolve: () => ({ snapshot: () => [] }) },
    permissions: { check: async () => ({ decision: 'allow' }) }
  } });
  return { runtime, stateStore, app: createJojoAppService(runtime, { ...options, stateStore }) };
}

it('opens host sessions idempotently without losing application metadata or transcript', async () => {
  const { app } = fixture();
  try {
    await app.openSession(ctx, { id: 's', executionScope: { kind: 'none' } });
    await app.patchSession(ctx, 's', { title: 'kept', favorite: true });
    await app.executeRun(ctx, 's', input);
    await app.openSession(ctx, { id: 's', executionScope: { kind: 'none' } });
    const session = await app.getSession(ctx, 's');
    expect(session).toMatchObject({ title: 'kept', favorite: true, activeRuns: [] });
    expect(session.transcript).toHaveLength(2);
  } finally { await app.close(); }
});

it('returns only after the shared run state is terminal and preserves channel origin', async () => {
  const { app, stateStore } = fixture();
  try {
    await app.openSession(ctx, { id: 's', executionScope: { kind: 'none' } });
    const statuses: string[] = [];
    app.subscribe(event => { if (event.type === 'run.updated') statuses.push(event.run.status); });
    const result = await app.executeRun(ctx, 's', input, {
      runId: 'channel-run', actor: { kind: 'channel_user', id: 'sender' },
      trigger: { kind: 'channel_message' },
      metadata: { channel: { bindingId: 'b', instanceId: 'i', conversationId: 'c', senderId: 'sender', inboundMessageId: 'message' } }
    });
    expect(result).toMatchObject({ status: 'completed', finalText: 'done' });
    expect(statuses).toEqual(['accepted', 'starting', 'running', 'completed']);
    expect(await app.getRun(ctx, 's', 'channel-run')).toMatchObject({ status: 'completed', result });
    expect((await stateStore.runs.get('channel-run'))?.requestMeta?.origin).toMatchObject({ kind: 'channel', channel: { bindingId: 'b' } });
  } finally { await app.close(); }
});

it('passes host cancellation through the same run lifecycle', async () => {
  const { app } = fixture();
  try {
    await app.openSession(ctx, { id: 's', executionScope: { kind: 'none' } });
    const controller = new AbortController();
    controller.abort();
    const result = await app.executeRun(ctx, 's', input, { runId: 'cancelled', signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(await app.getRun(ctx, 's', 'cancelled')).toMatchObject({ status: 'cancelled' });
  } finally { await app.close(); }
});

it('adopts a Runtime terminal result without executing it again', async () => {
  const { app, runtime } = fixture();
  try {
    const { result } = await capturedRun(runtime);
    const resume = vi.spyOn(runtime, 'resumeOperation');
    expect(await app.resumeRun(ctx, 's', 'captured')).toEqual(result);
    expect(await app.resumeRun(ctx, 's', 'captured')).toEqual(result);
    expect(resume).not.toHaveBeenCalled();
    expect(await app.getRun(ctx, 's', 'captured')).toMatchObject({ status: 'completed', result });
    await expect(app.resumeRun(ctx, 'another-session', 'captured')).rejects.toThrow('run_not_found');
  } finally { await app.close(); }
});

it('joins concurrent recoveries, validates ownership, and commits the original run identity', async () => {
  const { app, runtime } = fixture();
  try {
    const { snapshot, result } = await capturedRun(runtime);
    const pending = { ...snapshot };
    delete pending.result;
    vi.spyOn(runtime, 'inspectRun').mockResolvedValue({ ...pending, status: 'running' });
    let finish!: () => void;
    const completed = new Promise<typeof result>(resolve => { finish = () => resolve(result); });
    const resume = vi.spyOn(runtime, 'resumeOperation').mockResolvedValue({ id: result.runId, result: completed, cancel: async () => finish() });
    const controller = new AbortController();
    const first = app.resumeRun(ctx, 's', result.runId, { signal: controller.signal });
    const second = app.resumeRun(ctx, 's', result.runId);
    await expect(app.resumeRun(ctx, 'other', result.runId)).rejects.toThrow('run_not_found');
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    expect(resume).toHaveBeenCalledWith({ operationId: result.runId, signal: controller.signal });
    finish();
    expect(await Promise.all([first, second])).toEqual([result, result]);
    expect(await app.getRun(ctx, 's', result.runId)).toMatchObject({ status: 'completed' });
  } finally { await app.close(); }
});

it('keeps failed recovery preparation retryable', async () => {
  const { app, runtime } = fixture();
  try {
    const { snapshot, result } = await capturedRun(runtime);
    const pending = { ...snapshot };
    delete pending.result;
    vi.spyOn(runtime, 'inspectRun').mockResolvedValue({ ...pending, status: 'suspended' });
    vi.spyOn(runtime, 'resumeOperation').mockRejectedValueOnce(new Error('environment unavailable'))
      .mockResolvedValue({ id: result.runId, result: Promise.resolve(result), cancel: async () => undefined });
    await expect(app.resumeRun(ctx, 's', result.runId)).rejects.toThrow('environment unavailable');
    expect(await app.getRun(ctx, 's', result.runId)).toMatchObject({ status: 'starting' });
    expect(await app.resumeRun(ctx, 's', result.runId)).toEqual(result);
  } finally { await app.close(); }
});


it('uses the Host approval adapter for ownership, decisions, events and shutdown', async () => {
  const snapshot: PendingApprovalSnapshot = {
    id: 'host-approval', sessionId: 's', laneId: 'main', runId: 'host-run',
    createdAt: new Date().toISOString(),
    request: { requestId: 'host-approval', sessionId: 's',
      call: { id: 'call', name: 'write_file', input: {} }, reason: 'Host policy' }
  };
  let listener: ((event: ApprovalEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const broker: ApplicationApprovalBroker = {
    requestApproval: async () => false,
    list: sessionId => !sessionId || sessionId === 's' ? [snapshot] : [],
    getSessionId: async id => {
      if (id !== snapshot.id) throw new Error(`approval_not_found: ${id}`);
      return snapshot.sessionId;
    },
    resolve: vi.fn(async (_id, decision) => { listener?.({ type: 'approval.resolved', approval: snapshot, decision }); }),
    interruptAll: vi.fn(async () => {}),
    subscribe: callback => { listener = callback; return unsubscribe; }
  };
  const { app, stateStore } = fixture({ approvalBroker: broker });
  const events: unknown[] = [];
  app.subscribe(event => events.push(event));
  try {
    await app.openSession(ctx, { id: 's', executionScope: { kind: 'none' } });
    expect(await stateStore.approvals.get(snapshot.id)).toBeUndefined();
    expect(await app.getApprovalSessionId(ctx, snapshot.id)).toBe('s');
    await expect(app.getApprovalSessionId(ctx, 'missing')).rejects.toThrow('approval_not_found');
    expect(await app.listApprovals(ctx, 's')).toEqual([snapshot]);
    expect(await app.listApprovals(ctx, 'other')).toEqual([]);
    expect((await app.getSession(ctx, 's')).pendingApprovals).toEqual([snapshot]);
    await app.resolveApproval(ctx, snapshot.id, 'allow');
    expect(broker.resolve).toHaveBeenCalledWith(snapshot.id, 'allow', 'local');
    expect(events).toContainEqual({ type: 'approval.resolved', approval: snapshot, decision: 'allow' });
  } finally { await app.close(); }
  expect(broker.interruptAll).toHaveBeenCalledWith('server_shutdown');
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

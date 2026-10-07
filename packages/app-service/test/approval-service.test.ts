import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import { MemoryServerStateStore, ServerApprovalBroker, type ApprovalStore } from '../src/index.js';

const request: ApprovalRequest = {
  requestId: 'approval-1',
  sessionId: 'session-1',
  call: { id: 'call-1', name: 'write_file', input: { token: 'must-not-persist' } },
  reason: 'Write requires approval',
  preview: {
    kind: 'update', path: '/workspace/file.txt', patch: 'secret patch', additions: 1, deletions: 1
  }
};

const context: RuntimeResolutionContext = {
  sessionId: 'session-1', laneId: 'main', runId: 'run-1', executionScope: { kind: 'none' },
  providerId: 'test', model: 'test', workingDirectory: ''
};

async function preparedStore(): Promise<MemoryServerStateStore> {
  const store = new MemoryServerStateStore();
  await store.sessions.ensureActive({ sessionId: 'session-1' });
  await store.runs.createAccepted({
    id: 'run-1', sessionId: 'session-1', laneId: 'main', providerId: 'test', model: 'test', inputHash: 'hash'
  });
  return store;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('ServerApprovalBroker durable ordering', () => {
  it('reserves the request ID while persistence is pending', async () => {
    const state = await preparedStore();
    const gate = deferred();
    const createPending = vi.fn(async (input: Parameters<ApprovalStore['createPending']>[0]) => {
      await gate.promise;
      return state.approvals.createPending(input);
    });
    const broker = new ServerApprovalBroker({ store: { ...state.approvals, createPending } });
    const controller = new AbortController();
    const waiting = broker.requestApproval(request, context, controller.signal);
    const duplicate = new AbortController();
    await expect(broker.requestApproval(request, context, duplicate.signal)).rejects.toThrow('approval_exists');
    duplicate.abort();
    expect(() => broker.bindStore(state.approvals)).toThrow('approval_store_bind_after_use');
    gate.resolve();
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    expect(createPending).toHaveBeenCalledTimes(1);
    await broker.resolve(request.requestId, 'allow');
    expect(await waiting).toBe(true);
  });

  it('does not republish an already resolved durable request', async () => {
    const state = await preparedStore();
    const broker = new ServerApprovalBroker({ store: state.approvals });
    const waiting = broker.requestApproval(request, context, new AbortController().signal);
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    await broker.resolve(request.requestId, 'deny');
    expect(await waiting).toBe(false);
    const event = vi.fn();
    broker.subscribe(event);
    await expect(broker.requestApproval(request, context, new AbortController().signal)).rejects.toThrow('approval_already_resolved');
    expect(event).not.toHaveBeenCalled();
    expect(broker.list()).toEqual([]);
  });

  it('persists a sanitized summary before publishing approval.required', async () => {
    const state = await preparedStore();
    const gate = deferred();
    const approvals: ApprovalStore = {
      ...state.approvals,
      createPending: async (input) => {
        await gate.promise;
        return state.approvals.createPending(input);
      }
    };
    const broker = new ServerApprovalBroker({ store: approvals });
    const events: string[] = [];
    broker.subscribe((event) => events.push(event.type));
    const controller = new AbortController();
    const waiting = broker.requestApproval(request, context, controller.signal);
    await Promise.resolve();
    expect(events).toEqual([]);
    gate.resolve();
    for (let attempt = 0; attempt < 10 && events.length === 0; attempt += 1) await Promise.resolve();
    expect(events).toEqual(['approval.required']);
    const durable = await state.approvals.get('approval-1');
    expect(JSON.stringify(durable)).not.toContain('must-not-persist');
    expect(JSON.stringify(durable)).not.toContain('secret patch');
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it('commits a decision before settling the runtime wait', async () => {
    const state = await preparedStore();
    const gate = deferred();
    const approvals: ApprovalStore = {
      ...state.approvals,
      resolve: async (id, decision, principalId, version) => {
        await gate.promise;
        return state.approvals.resolve(id, decision, principalId, version);
      }
    };
    const broker = new ServerApprovalBroker({ store: approvals });
    const controller = new AbortController();
    const waiting = broker.requestApproval(request, context, controller.signal);
    for (let attempt = 0; attempt < 10 && broker.list().length === 0; attempt += 1) await Promise.resolve();
    let settled = false;
    void waiting.then(() => { settled = true; });
    const resolving = broker.resolve('approval-1', 'allow', 'principal-1');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await state.approvals.get('approval-1'))?.status).toBe('pending');
    gate.resolve();
    await resolving;
    await expect(waiting).resolves.toBe(true);
    expect(await state.approvals.get('approval-1')).toMatchObject({
      status: 'allowed', decision: 'allow', resolvedBy: 'principal-1'
    });
  });
});


it('keeps durable approval ownership available after settlement and broker recreation', async () => {
  const state = await preparedStore();
  const broker = new ServerApprovalBroker({ store: state.approvals });
  const waiting = broker.requestApproval(request, context, new AbortController().signal);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
  expect(await broker.getSessionId(request.requestId)).toBe(context.sessionId);
  await broker.resolve(request.requestId, 'deny');
  expect(await waiting).toBe(false);
  const reopened = new ServerApprovalBroker({ store: state.approvals });
  expect(reopened.list()).toEqual([]);
  expect(await reopened.getSessionId(request.requestId)).toBe(context.sessionId);
  await expect(reopened.getSessionId('missing')).rejects.toThrow('approval_not_found');
});

it('persists preparation approval before publication and records its decision without a fabricated run', async () => {
  const state = new MemoryServerStateStore();
  await state.sessions.ensureActive({ sessionId: request.sessionId });
  const broker = new ServerApprovalBroker({ store: state.approvals });
  const events: unknown[] = [];
  broker.subscribe(event => events.push(event));
  const waiting = broker.requestSessionApproval(request, new AbortController().signal);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
  expect(broker.list()[0]).toMatchObject({ scope: 'session', sessionId: request.sessionId });
  expect(broker.list()[0]).not.toHaveProperty('runId');
  expect(await state.approvals.get(request.requestId)).toMatchObject({ scope: 'session', status: 'pending' });
  expect(await state.runs.list(request.sessionId)).toEqual([]);
  await broker.resolve(request.requestId, 'allow', 'local-user');
  expect(await waiting).toBe(true);
  const reopened = new ServerApprovalBroker({ store: state.approvals });
  await expect(reopened.resolve(request.requestId, 'allow', 'local-user')).resolves.toBeUndefined();
  await expect(reopened.resolve(request.requestId, 'deny')).rejects.toThrow('approval_already_resolved');
  expect(await reopened.getSessionId(request.requestId)).toBe(request.sessionId);
  expect(await state.approvals.get(request.requestId)).toMatchObject({ status: 'allowed', resolvedBy: 'local-user' });
  expect(JSON.stringify(await state.approvals.get(request.requestId))).not.toContain('must-not-persist');
  expect(events).toHaveLength(2);
});

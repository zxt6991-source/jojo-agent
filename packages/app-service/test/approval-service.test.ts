import { describe, expect, it } from 'vitest';
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

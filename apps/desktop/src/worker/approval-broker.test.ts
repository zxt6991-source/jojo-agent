import { expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import { PendingApprovalSnapshotSchema } from '@desktop-agent/contracts/application';
import { MemoryServerStateStore, type ApprovalEvent } from '@desktop-agent/app-service';
import { DesktopApprovalBroker } from './approval-broker';

const request: ApprovalRequest = { requestId: 'a', sessionId: 's',
  call: { id: 'c', name: 'write_file', input: {} }, reason: 'Approval required' };
const context = { sessionId: 's', runId: 'r', laneId: 'main', executionScope: { kind: 'none' as const },
  providerId: 'p', model: 'm', workingDirectory: '' };

it('distinguishes preparation approvals from run approvals without accepting ambiguous snapshots', async () => {
  const state = new MemoryServerStateStore();
  const broker = new DesktopApprovalBroker(state);
  const waiting = broker.requestSessionApproval(request, new AbortController().signal);
  await vi.waitFor(() => expect(broker.get('a')).toBeDefined());
  const snapshot = broker.get('a')!;
  expect(snapshot).toMatchObject({ scope: 'session', sessionId: 's' });
  expect(snapshot).not.toHaveProperty('runId');
  expect(PendingApprovalSnapshotSchema.safeParse(snapshot).success).toBe(true);
  expect(PendingApprovalSnapshotSchema.safeParse({ ...snapshot, runId: 'fake' }).success).toBe(false);
  expect(PendingApprovalSnapshotSchema.safeParse({ ...snapshot, scope: undefined }).success).toBe(false);
  expect(await broker.getSessionId('a')).toBe('s');
  expect(broker.list('other')).toEqual([]);
  snapshot.request.reason = 'mutated';
  expect(broker.get('a')?.request.reason).toBe(request.reason);
  await broker.resolve('a', 'allow');
  expect(await waiting).toBe(true);
  await state.runs.createAccepted({ id: 'r', sessionId: 's', laneId: 'main', providerId: 'p', model: 'm', inputHash: 'hash' });
  const running = broker.requestApproval({ ...request, requestId: 'run-approval' }, context, new AbortController().signal);
  await vi.waitFor(() => expect(broker.get('run-approval')).toBeDefined());
  expect(broker.get('run-approval')).toMatchObject({ runId: 'r', laneId: 'main' });
  expect(PendingApprovalSnapshotSchema.safeParse(broker.get('run-approval')).success).toBe(true);
  await broker.resolve('run-approval', 'deny');
  expect(await running).toBe(false);
  await expect(broker.resolve('run-approval', 'allow')).rejects.toThrow('approval_already_resolved');
  await expect(broker.requestApproval(request, { ...context, sessionId: 'other' }, new AbortController().signal))
    .rejects.toThrow('approval_session_mismatch');
});

it('cancels only the requested session and emits invalidation events on abort and shutdown', async () => {
  const state = new MemoryServerStateStore();
  const broker = new DesktopApprovalBroker(state);
  const events: ApprovalEvent[] = [];
  broker.subscribe(event => events.push(event));
  broker.subscribe(() => { throw new Error('observer failed'); });
  const controller = new AbortController();
  const first = broker.requestSessionApproval(request, controller.signal);
  const second = broker.requestSessionApproval({ ...request, requestId: 'b', sessionId: 'other' }, new AbortController().signal);
  await vi.waitFor(() => expect(broker.list()).toHaveLength(2));
  await expect(broker.requestSessionApproval(request, new AbortController().signal)).rejects.toThrow('approval_exists');
  controller.abort();
  expect(await first).toBe(false);
  expect(broker.list()).toHaveLength(1);
  await broker.interruptSession('s');
  expect(broker.list()).toHaveLength(1);
  await broker.interruptAll('shutdown');
  expect(await second).toBe(false);
  expect(events.filter(event => event.type === 'approval.resolved').map(event => event.approval.id)).toEqual(['a', 'b']);
  expect(broker.list()).toEqual([]);
  expect(await broker.requestSessionApproval(request, controller.signal)).toBe(false);
  expect(events).toHaveLength(4);
});

it('retains terminal audit and rejects interrupted or conflicting decisions after broker recreation', async () => {
  const state = new MemoryServerStateStore();
  const broker = new DesktopApprovalBroker(state);
  const controller = new AbortController();
  const waiting = broker.requestSessionApproval(request, controller.signal);
  await vi.waitFor(() => expect(broker.get('a')).toBeDefined());
  controller.abort();
  expect(await waiting).toBe(false);
  const reopened = new DesktopApprovalBroker(state);
  expect(await reopened.getSessionId('a')).toBe('s');
  await expect(reopened.resolve('a', 'allow')).rejects.toThrow('approval_interrupted');
  await expect(reopened.requestSessionApproval(request, new AbortController().signal)).rejects.toThrow('approval_already_resolved');
  const next = reopened.requestSessionApproval({ ...request, requestId: 'fresh' }, new AbortController().signal);
  await vi.waitFor(() => expect(reopened.get('fresh')).toBeDefined());
  await reopened.resolve('fresh', 'allow', 'owner');
  expect(await next).toBe(true);
  expect(await state.approvals.get('fresh')).toMatchObject({ status: 'allowed', resolvedBy: 'owner' });
  const final = new DesktopApprovalBroker(state);
  await expect(final.resolve('fresh', 'allow', 'owner')).resolves.toBeUndefined();
  await expect(final.resolve('fresh', 'deny')).rejects.toThrow('approval_already_resolved');
});

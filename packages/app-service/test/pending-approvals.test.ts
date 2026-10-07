import { expect, it, vi } from 'vitest';
import { PendingApprovals } from '../src/index.js';

it('does not register or publish an already cancelled approval', async () => {
  const approvals = new PendingApprovals<{ sessionId: string }>();
  const controller = new AbortController();
  controller.abort();
  const registered = vi.fn();
  expect(await approvals.wait('a', { sessionId: 's' }, controller.signal, { registered })).toBe(false);
  expect(registered).not.toHaveBeenCalled();
  expect(approvals.size).toBe(0);
});

it('rejects duplicate IDs without replacing the original waiter', async () => {
  const approvals = new PendingApprovals<{ sessionId: string }>();
  const controller = new AbortController();
  const waiting = approvals.wait('a', { sessionId: 's' }, controller.signal);
  const original = approvals.get('a')!;
  await expect(approvals.wait('a', { sessionId: 'other' }, controller.signal)).rejects.toThrow('approval_exists');
  original.settle(true);
  controller.abort();
  expect(await waiting).toBe(true);
  expect(approvals.size).toBe(0);
  const next = approvals.wait('a', { sessionId: 'new' }, new AbortController().signal);
  original.settle(false);
  expect(approvals.get('a')?.sessionId).toBe('new');
  approvals.get('a')!.settle(false);
  expect(await next).toBe(false);
});

it('cancels synchronously during publication without retaining listeners', async () => {
  const approvals = new PendingApprovals<object>();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  expect(await approvals.wait('a', {}, controller.signal, { registered: () => controller.abort() })).toBe(false);
  expect(approvals.size).toBe(0);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('waits for durable abort and propagates persistence failure without orphaning the waiter', async () => {
  const approvals = new PendingApprovals<object>();
  const controller = new AbortController();
  let fail!: (error: Error) => void;
  const durable = new Promise<boolean>((_resolve, reject) => { fail = reject; });
  const waiting = approvals.wait('a', {}, controller.signal, { abort: () => durable });
  const rejected = expect(waiting).rejects.toThrow('storage unavailable');
  controller.abort();
  expect(approvals.size).toBe(1);
  fail(new Error('storage unavailable'));
  await rejected;
  expect(approvals.size).toBe(0);
});

it('cleans up when publication throws', async () => {
  const approvals = new PendingApprovals<object>();
  await expect(approvals.wait('a', {}, new AbortController().signal, {
    registered: () => { throw new Error('publish failed'); }
  })).rejects.toThrow('publish failed');
  expect(approvals.size).toBe(0);
});

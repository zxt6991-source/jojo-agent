import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemoryServerStateStore, type DurableIdempotencyStore } from '@desktop-agent/app-service';
import { IdempotencyStore } from '../src/idempotency.js';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

describe('IdempotencyStore durable execution', () => {
  it.each([
    'session.create',
    'run.start:session-1',
    'approval.resolve:approval-1'
  ])('reuses a completed %s response across store instances', async (route) => {
    const state = new MemoryServerStateStore(() => new Date(1_000));
    const first = new IdempotencyStore(10_000, () => 1_000, state.idempotency);
    const work = vi.fn(async () => ({ operation: route }));
    await expect(first.execute('principal-1', route, 'key-1', { value: 1 }, work))
      .resolves.toEqual({ operation: route });

    const restarted = new IdempotencyStore(10_000, () => 2_000, state.idempotency);
    const duplicate = vi.fn(async () => ({ operation: 'duplicate' }));
    await expect(restarted.execute('principal-1', route, 'key-1', { value: 1 }, duplicate))
      .resolves.toEqual({ operation: route });
    expect(work).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
  });

  it('does not execute a duplicate while a crash-uncertain claim is pending', async () => {
    const state = new MemoryServerStateStore(() => new Date(1_000));
    const gate = deferred<{ id: string }>();
    const first = new IdempotencyStore(10_000, () => 1_000, state.idempotency);
    const running = first.execute('principal-1', 'run.start:session-1', 'key-1', { value: 1 }, () => gate.promise);
    await Promise.resolve();

    const restarted = new IdempotencyStore(10_000, () => 2_000, state.idempotency);
    const duplicate = vi.fn(async () => ({ id: 'duplicate' }));
    await expect(restarted.execute(
      'principal-1', 'run.start:session-1', 'key-1', { value: 1 }, duplicate
    )).rejects.toMatchObject({ protocol: { code: 'idempotency_in_progress', retryable: true } });
    expect(duplicate).not.toHaveBeenCalled();

    gate.resolve({ id: 'run-1' });
    await expect(running).resolves.toEqual({ id: 'run-1' });
  });

  it('keeps the durable claim when response persistence fails after business completion', async () => {
    const state = new MemoryServerStateStore(() => new Date(1_000));
    const abandon = vi.fn(state.idempotency.abandon.bind(state.idempotency));
    const durable: DurableIdempotencyStore = {
      claim: state.idempotency.claim.bind(state.idempotency),
      complete: async () => { throw new Error('simulated_complete_failure'); },
      abandon
    };
    const store = new IdempotencyStore(10_000, () => 1_000, durable);
    const work = vi.fn(async () => ({ id: 'run-1' }));

    await expect(store.execute(
      'principal-1', 'run.start:session-1', 'key-1', { value: 1 }, work
    )).rejects.toThrow('simulated_complete_failure');
    expect(work).toHaveBeenCalledOnce();
    expect(abandon).not.toHaveBeenCalled();
    await expect(state.idempotency.claim({
      principalId: 'principal-1', route: 'run.start:session-1', key: 'key-1', requestHash: requestHash({ value: 1 }),
      expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({ status: 'pending' });
  });
});

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

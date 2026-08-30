import { describe, expect, it } from 'vitest';
import {
  DefaultScheduleCalculator,
  DurableScheduleEngine,
  MemoryScheduleStore,
  type Schedule,
  type ScheduleDispatchRequest,
  type ScheduleTargetDispatcher,
  type TargetExecutionEvent,
  type TargetExecutionReference,
  type TargetExecutionSnapshot
} from '../src/index.js';

class FakeDispatcher implements ScheduleTargetDispatcher {
  readonly requests: ScheduleDispatchRequest[] = [];
  readonly snapshots = new Map<string, TargetExecutionSnapshot>();
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();

  constructor(private readonly idempotent = true) {}

  async dispatch(input: ScheduleDispatchRequest): Promise<TargetExecutionSnapshot> {
    this.requests.push(input);
    const snapshot: TargetExecutionSnapshot = { kind: input.target.kind, id: input.executionId, state: 'running' };
    this.snapshots.set(snapshot.id, snapshot);
    return snapshot;
  }
  async inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    return this.snapshots.get(reference.id);
  }
  async cancel(reference: TargetExecutionReference): Promise<void> {
    this.finish(reference.id, 'cancelled');
  }
  supportsIdempotentDispatch(): boolean { return this.idempotent; }
  subscribe(listener: (event: TargetExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  finish(id: string, state: TargetExecutionSnapshot['state']): void {
    const current = this.snapshots.get(id);
    if (!current) return;
    const snapshot = { ...current, state };
    this.snapshots.set(id, snapshot);
    for (const listener of this.listeners) listener({ snapshot });
  }
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_daily', name: 'Daily', enabled: true,
    spec: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-08-30T00:00:00.000Z' },
    target: {
      kind: 'agent', sessionId: 'session-1', input: { content: [{ type: 'text', text: 'review' }] },
      providerId: 'provider', model: 'model'
    },
    misfire: { kind: 'fire_once', graceMs: 24 * 60 * 60_000 }, concurrency: 'skip',
    nextRunAt: '2026-08-30T00:01:00.000Z', revision: 1, createdBy: 'user-1',
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

describe('DurableScheduleEngine', () => {
  it('claims and advances an occurrence before dispatching', async () => {
    const store = new MemoryScheduleStore();
    await store.create(schedule());
    const dispatcher = new FakeDispatcher();
    let nextId = 0;
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'engine-1', {
      now: () => new Date('2026-08-30T00:01:00.000Z'), idGenerator: () => `${++nextId}`
    });
    await engine.initialize();

    expect(dispatcher.requests).toHaveLength(1);
    expect(await store.get('sch_daily')).toMatchObject({ nextRunAt: '2026-08-30T00:02:00.000Z', revision: 2 });
    expect(await store.listRuns('sch_daily')).toMatchObject([{
      occurrenceKey: `timer:${new Date('2026-08-30T00:01:00.000Z').getTime()}`,
      status: 'running', targetExecutionId: 'schedrun:sr_1'
    }]);
    await engine.close();
  });

  it('records a skipped misfire without dispatching and jumps after now', async () => {
    const store = new MemoryScheduleStore();
    await store.create(schedule({ misfire: { kind: 'skip' } }));
    const dispatcher = new FakeDispatcher();
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'engine-1', {
      now: () => new Date('2026-08-30T00:05:30.000Z'), idGenerator: () => '1'
    });
    await engine.initialize();

    expect(dispatcher.requests).toHaveLength(0);
    expect(await store.listRuns('sch_daily')).toMatchObject([{ status: 'skipped', errorCode: 'schedule_misfire_skipped' }]);
    expect(await store.get('sch_daily')).toMatchObject({ nextRunAt: '2026-08-30T00:06:00.000Z' });
    await engine.close();
  });

  it('skips overlap and coalesces queued occurrences to one', async () => {
    const store = new MemoryScheduleStore();
    const queued = schedule({ concurrency: 'queue' });
    await store.create(queued);
    await store.createManualRun({
      id: 'sr_active', scheduleId: queued.id, occurrenceKey: 'manual:active', scheduledFor: queued.createdAt,
      trigger: 'manual', status: 'running', targetKind: 'agent', createdAt: queued.createdAt,
      targetExecutionId: 'schedrun:sr_active', targetSnapshot: queued.target
    });
    const dispatcher = new FakeDispatcher();
    dispatcher.snapshots.set('schedrun:sr_active', { kind: 'agent', id: 'schedrun:sr_active', state: 'running' });
    let now = new Date('2026-08-30T00:01:00.000Z');
    let id = 0;
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'engine-1', {
      now: () => now, idGenerator: () => `${++id}`
    });
    await engine.initialize();
    now = new Date('2026-08-30T00:02:00.000Z');
    engine.poke();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await store.listRuns(queued.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({ status: 'skipped', errorCode: 'schedule_queue_coalesced' })
    ]));
    await engine.close();
  });

  it('lets a standby engine claim leadership after the active engine releases its lease', async () => {
    const store = new MemoryScheduleStore();
    await store.create(schedule());
    const leaderDispatcher = new FakeDispatcher();
    const standbyDispatcher = new FakeDispatcher();
    let now = new Date('2026-08-30T00:00:00.000Z');
    const leader = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), leaderDispatcher, 'leader', {
      now: () => now,
      idGenerator: () => 'leader-run'
    });
    const standby = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), standbyDispatcher, 'standby', {
      now: () => now,
      idGenerator: () => 'standby-run'
    });
    await leader.initialize();
    await standby.initialize();
    expect(leaderDispatcher.requests).toHaveLength(0);
    expect(standbyDispatcher.requests).toHaveLength(0);

    now = new Date('2026-08-30T00:01:00.000Z');
    await leader.close();
    standby.poke();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(standbyDispatcher.requests).toHaveLength(1);
    expect(await store.listRuns('sch_daily')).toMatchObject([{
      status: 'running', targetExecutionId: 'schedrun:sr_standby-run'
    }]);
    await standby.close();
  });

  it('re-dispatches a crash-window run with the same target execution id when the dispatcher is idempotent', async () => {
    const store = new MemoryScheduleStore();
    const persisted = schedule({ nextRunAt: '2026-08-30T00:10:00.000Z' });
    await store.create(persisted);
    await store.createManualRun({
      id: 'sr_crash', scheduleId: persisted.id, occurrenceKey: 'manual:crash',
      scheduledFor: '2026-08-30T00:00:00.000Z', trigger: 'manual', status: 'dispatching',
      targetKind: 'agent', createdAt: '2026-08-30T00:00:00.000Z', targetSnapshot: persisted.target
    });
    const dispatcher = new FakeDispatcher(true);
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'recovery', {
      now: () => new Date('2026-08-30T00:00:30.000Z')
    });
    await engine.initialize();

    expect(dispatcher.requests).toMatchObject([{ executionId: 'schedrun:sr_crash' }]);
    expect(await store.getRun('sr_crash')).toMatchObject({
      status: 'running', targetExecutionId: 'schedrun:sr_crash'
    });
    await engine.close();
  });

  it('interrupts a crash-window run when safe re-dispatch cannot be proven', async () => {
    const store = new MemoryScheduleStore();
    const persisted = schedule({ nextRunAt: '2026-08-30T00:10:00.000Z' });
    await store.create(persisted);
    await store.createManualRun({
      id: 'sr_uncertain', scheduleId: persisted.id, occurrenceKey: 'manual:uncertain',
      scheduledFor: '2026-08-30T00:00:00.000Z', trigger: 'manual', status: 'dispatching',
      targetKind: 'agent', createdAt: '2026-08-30T00:00:00.000Z', targetSnapshot: persisted.target
    });
    const dispatcher = new FakeDispatcher(false);
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'recovery', {
      now: () => new Date('2026-08-30T00:00:30.000Z')
    });
    await engine.initialize();

    expect(dispatcher.requests).toHaveLength(0);
    expect(await store.getRun('sr_uncertain')).toMatchObject({
      status: 'interrupted', errorCode: 'schedule_dispatch_uncertain'
    });
    await engine.close();
  });
});

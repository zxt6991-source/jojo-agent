import { describe, expect, it } from 'vitest';
import {
  DefaultScheduleCalculator,
  DefaultScheduleService,
  DurableScheduleEngine,
  MemoryScheduleStore,
  type ScheduleDispatchRequest,
  type ScheduleTargetDispatcher,
  type TargetExecutionEvent,
  type TargetExecutionReference,
  type TargetExecutionSnapshot
} from '../src/index.js';

class ImmediateDispatcher implements ScheduleTargetDispatcher {
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();
  async dispatch(input: ScheduleDispatchRequest): Promise<TargetExecutionSnapshot> {
    return { kind: input.target.kind, id: input.executionId, state: 'running' };
  }
  async inspect(_reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> { return undefined; }
  async cancel(): Promise<void> {}
  supportsIdempotentDispatch(): boolean { return true; }
  subscribe(listener: (event: TargetExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe('DefaultScheduleService', () => {
  it('creates, revises, disables, manually runs, and soft-deletes schedules', async () => {
    const store = new MemoryScheduleStore();
    const calculator = new DefaultScheduleCalculator();
    const dispatcher = new ImmediateDispatcher();
    let id = 0;
    const now = () => new Date('2026-08-30T00:00:00.000Z');
    const engine = new DurableScheduleEngine(store, calculator, dispatcher, 'engine-1', {
      now, idGenerator: () => `${++id}`
    });
    const service = new DefaultScheduleService(store, calculator, engine, {
      now, idGenerator: () => `${++id}`
    });
    await service.initialize();
    const created = await service.create({
      name: 'Daily review', spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
      target: {
        kind: 'agent', sessionId: 'session-1', input: { content: [{ type: 'text', text: 'review' }] },
        providerId: 'provider', model: 'model'
      }
    }, { id: 'user-1' });
    expect(created).toMatchObject({
      id: 'sch_1', nextRunAt: '2026-08-31T00:00:00.000Z', concurrency: 'skip',
      misfire: { kind: 'fire_once', graceMs: 86_400_000 }
    });

    const updated = await service.update(created.id, {
      spec: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      expectedRevision: created.revision
    });
    expect(updated).toMatchObject({ revision: 2, nextRunAt: '2026-08-30T01:00:00.000Z' });
    await expect(service.update(created.id, { name: 'stale', expectedRevision: created.revision }))
      .rejects.toThrow('schedule_revision_conflict');

    const disabled = await service.setEnabled(created.id, false, updated.revision);
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeUndefined();
    const manual = await service.runNow(created.id);
    expect(manual).toMatchObject({ trigger: 'manual', status: 'running' });

    await service.delete(created.id);
    await expect(service.get(created.id)).rejects.toThrow('schedule_not_found');
    await expect(service.listRuns(created.id)).resolves.toHaveLength(1);
    await service.close();
  });

  it('rejects unsafe agent overlap and past once schedules', async () => {
    const store = new MemoryScheduleStore();
    const calculator = new DefaultScheduleCalculator();
    const dispatcher = new ImmediateDispatcher();
    const now = () => new Date('2026-08-30T00:00:00.000Z');
    const engine = new DurableScheduleEngine(store, calculator, dispatcher, 'engine-1', { now });
    const service = new DefaultScheduleService(store, calculator, engine, { now });
    const target = {
      kind: 'agent' as const, sessionId: 'session-1', input: { content: [{ type: 'text' as const, text: 'review' }] },
      providerId: 'provider', model: 'model'
    };
    await expect(service.create({
      name: 'Unsafe', spec: { kind: 'interval', intervalMs: 60_000, anchorAt: now().toISOString() },
      target, concurrency: 'allow'
    }, { id: 'user-1' })).rejects.toThrow('cannot use allow concurrency');
    await expect(service.create({
      name: 'Past', spec: { kind: 'once', runAt: '2026-08-29T00:00:00.000Z' }, target
    }, { id: 'user-1' })).rejects.toThrow('must be in the future');
    await service.close();
  });
});

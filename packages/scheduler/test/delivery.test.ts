import { describe, expect, it } from 'vitest';
import {
  ConversationScheduleDeliveryService,
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
import type { Message } from '@desktop-agent/contracts';

class CompletedDispatcher implements ScheduleTargetDispatcher {
  async dispatch(input: ScheduleDispatchRequest): Promise<TargetExecutionSnapshot> {
    return { kind: input.target.kind, id: input.executionId, state: 'completed', resultPreview: '今日天气晴朗。' };
  }
  async inspect(_reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> { return undefined; }
  async cancel(): Promise<void> {}
  supportsIdempotentDispatch(): boolean { return true; }
  subscribe(_listener: (event: TargetExecutionEvent) => void): () => void { return () => undefined; }
}

function schedule(delivery = true): Schedule {
  return {
    id: 'sch_weather', name: '每日天气', enabled: true,
    spec: { kind: 'cron', expression: '0 8 * * *', timezone: 'Asia/Shanghai' },
    target: {
      kind: 'agent', sessionId: 'session-1', input: { content: [{ type: 'text', text: 'weather' }] },
      providerId: 'provider', model: 'model'
    },
    ...(delivery ? { delivery: { conversation: { enabled: true, sessionId: 'session-1' } } } : {}),
    misfire: { kind: 'fire_once', graceMs: 86_400_000 }, concurrency: 'skip',
    nextRunAt: '2026-08-31T00:00:00.000Z', revision: 1, createdBy: 'desktop-user',
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
  };
}

describe('schedule conversation delivery', () => {
  it('persists a scheduler assistant message and records delivered independently from execution', async () => {
    const messages: Array<{ sessionId: string; message: Message }> = [];
    const store = new MemoryScheduleStore();
    const item = await store.create(schedule());
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), new CompletedDispatcher(), 'engine', {
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      idGenerator: () => 'run',
      deliveryService: new ConversationScheduleDeliveryService({
        appendMessage: async (sessionId, message) => { messages.push({ sessionId, message }); }
      })
    });
    await engine.initialize();

    const run = await engine.runNow(item);
    expect(run).toMatchObject({ status: 'completed', deliveryStatus: 'delivered', deliveryMessageId: 'scheduler_sr_run' });
    expect(messages).toMatchObject([{
      sessionId: 'session-1',
      message: {
        id: 'scheduler_sr_run', role: 'assistant', content: [{ type: 'text', text: '今日天气晴朗。' }],
        metadata: {
          source: 'scheduler',
          automation: { scheduleId: 'sch_weather', scheduleRunId: 'sr_run', name: '每日天气' }
        }
      }
    }]);
    await engine.close();
  });

  it('keeps a successful execution completed when conversation delivery fails', async () => {
    const store = new MemoryScheduleStore();
    const item = await store.create(schedule());
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), new CompletedDispatcher(), 'engine', {
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      idGenerator: () => 'failed-delivery',
      deliveryService: new ConversationScheduleDeliveryService({
        appendMessage: async () => { throw new Error('session store unavailable'); }
      })
    });
    await engine.initialize();

    await expect(engine.runNow(item)).resolves.toMatchObject({
      status: 'completed', deliveryStatus: 'failed', deliveryError: 'session store unavailable'
    });
    await engine.close();
  });

  it('treats legacy schedules without delivery as silent', async () => {
    const messages: Message[] = [];
    const store = new MemoryScheduleStore();
    const item = await store.create(schedule(false));
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), new CompletedDispatcher(), 'engine', {
      now: () => new Date('2026-08-30T00:00:00.000Z'),
      idGenerator: () => 'legacy',
      deliveryService: new ConversationScheduleDeliveryService({
        appendMessage: async (_sessionId, message) => { messages.push(message); }
      })
    });
    await engine.initialize();

    await expect(engine.runNow(item)).resolves.toMatchObject({ status: 'completed', deliveryStatus: 'skipped' });
    expect(messages).toHaveLength(0);
    await engine.close();
  });

  it('records skipped delivery for a directly terminal misfire occurrence', async () => {
    const store = new MemoryScheduleStore();
    await store.create({ ...schedule(), misfire: { kind: 'skip' } });
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), new CompletedDispatcher(), 'engine', {
      now: () => new Date('2026-08-31T00:05:00.000Z'),
      idGenerator: () => 'misfire',
      deliveryService: new ConversationScheduleDeliveryService({ appendMessage: async () => undefined })
    });
    await engine.initialize();

    expect(await store.listRuns('sch_weather')).toMatchObject([{
      status: 'skipped', errorCode: 'schedule_misfire_skipped', deliveryStatus: 'skipped'
    }]);
    await engine.close();
  });

  it('recovers a pending terminal delivery after restart', async () => {
    const messages: Message[] = [];
    const store = new MemoryScheduleStore();
    const item = await store.create(schedule());
    await store.createManualRun({
      id: 'sr_recover', scheduleId: item.id, occurrenceKey: 'manual:recover',
      scheduledFor: '2026-08-30T00:00:00.000Z', trigger: 'manual', status: 'completed',
      targetKind: 'agent', createdAt: '2026-08-30T00:00:00.000Z', finishedAt: '2026-08-30T00:00:01.000Z',
      resultPreview: '恢复后的结果', deliveryStatus: 'pending', targetSnapshot: item.target
    });
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), new CompletedDispatcher(), 'recovery', {
      now: () => new Date('2026-08-30T00:00:02.000Z'),
      deliveryService: new ConversationScheduleDeliveryService({
        appendMessage: async (_sessionId, message) => { messages.push(message); }
      })
    });
    await engine.initialize();

    expect(await store.getRun('sr_recover')).toMatchObject({ deliveryStatus: 'delivered' });
    expect(messages).toHaveLength(1);
    await engine.close();
  });
});

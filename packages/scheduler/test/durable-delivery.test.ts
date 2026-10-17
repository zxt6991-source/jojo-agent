import { describe, expect, it, vi } from 'vitest';
import {
  DefaultScheduleCalculator, DurableScheduleDeliveryProcessor, DurableScheduleEngine,
  LegacyScheduleDeliveryAdapter, MemoryScheduleStore, ReminderScheduleDispatcher, ScheduleDispatcherRegistry,
  ConversationScheduleDeliveryService, prepareScheduleDeliveries,
  type Schedule, type ScheduleDeliveryAdapter, type ScheduleDeliveryItem, type ScheduleRun,
  type ScheduleDispatchRequest, type ScheduleTargetDispatcher, type TargetExecutionEvent,
  type TargetExecutionSnapshot
} from '../src/index.js';
import type { Message } from '@desktop-agent/contracts';

const NOW = '2026-10-14T00:00:00.000Z';
const voice = { enabled: true, deviceId: 'local-desktop' as const,
  content: { kind: 'result' as const, maxChars: 600 }, expiresAfterMs: 60_000 };
function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule', name: '喝水', enabled: true,
    spec: { kind: 'once', runAt: '2026-10-14T00:01:00.000Z' },
    target: { kind: 'reminder', text: '休息一下，喝杯水。' },
    delivery: { voice, conversation: { enabled: true, sessionId: 'original-session' } },
    misfire: { kind: 'fire_once', graceMs: 60_000 }, concurrency: 'skip', revision: 1,
    createdBy: 'user', createdAt: NOW, updatedAt: NOW, nextRunAt: '2026-10-14T00:01:00.000Z',
    ...overrides
  };
}
function run(item: Schedule): ScheduleRun {
  return { id: 'run', scheduleId: item.id, occurrenceKey: 'manual:1', scheduledFor: NOW,
    trigger: 'manual', status: 'completed', targetKind: item.target.kind,
    targetExecutionId: 'schedrun:run', createdAt: NOW, finishedAt: NOW, targetSnapshot: item.target,
    deliverySnapshot: { name: item.name, scheduleRevision: item.revision, ...(item.delivery ? { delivery: item.delivery } : {}) }, version: 1 };
}
function sequence(): () => string { let id = 0; return () => `${++id}`; }
const inertTimers = { setTimer: () => ({} as ReturnType<typeof setTimeout>), clearTimer: () => undefined };

async function seed(item: Schedule): Promise<{ store: MemoryScheduleStore; deliveries: ScheduleDeliveryItem[] }> {
  const store = new MemoryScheduleStore();
  await store.create(item);
  const initial = run(item);
  const created = await store.createManualRun({ ...initial, status: 'running' });
  const deliveries = await prepareScheduleDeliveries(initial, { idGenerator: sequence() });
  await store.transitionRunWithDeliveries(created.id, { status: 'completed', finishedAt: NOW, deliveryStatus: 'pending' }, deliveries, created.version);
  return { store, deliveries };
}

describe('durable reminder delivery', () => {
  it('resolves the selected preset from the immutable destination snapshot when preparing a delivery', async () => {
    const presetVersion = vi.fn((presetId?: string) => `version:${presetId ?? 'default'}`);
    const item = schedule({ delivery: { voice: { ...voice, presetId: 'morning' } } });
    const deliveries = await prepareScheduleDeliveries(run(item), { idGenerator: sequence(), voicePresetVersion: presetVersion });
    expect(presetVersion).toHaveBeenCalledExactlyOnceWith('morning');
    expect(deliveries).toMatchObject([{ payloadSnapshot: { kind: 'voice', presetId: 'morning', presetVersion: 'version:morning' } }]);
  });
  it('completes a static reminder without dispatching an Agent and does not wait for playback', async () => {
    const store = new MemoryScheduleStore();
    const saved = await store.create(schedule());
    const registry = new ScheduleDispatcherRegistry();
    registry.register(new ReminderScheduleDispatcher());
    let releasePlayback: (() => void) | undefined;
    const adapter: ScheduleDeliveryAdapter = { deliver: async (item, context) => {
      if (item.destination !== 'voice') return { status: 'delivered' };
      await store.ackDelivery({ ...context.identity, now: Date.parse(NOW), state: 'playing' });
      await new Promise<void>((resolve) => { releasePlayback = resolve; });
      return { status: 'played' };
    } };
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), registry, 'engine', {
      now: () => new Date(NOW), idGenerator: sequence(), deliveryAdapter: adapter, voicePresetVersion: () => 'preset-1', ...inertTimers
    });
    await engine.initialize();
    const result = await engine.runNow(saved);
    expect(result).toMatchObject({ status: 'completed', targetKind: 'reminder', deliveryStatus: 'pending' });
    await expect.poll(() => store.listDeliveries({ destination: 'voice' })).toMatchObject([{
      state: 'playing', payloadSnapshot: { content: '休息一下，喝杯水。', presetVersion: 'preset-1' }
    }]);
    releasePlayback?.();
    await expect.poll(() => store.listDeliveries({ destination: 'voice' })).toMatchObject([{ state: 'played' }]);
    await engine.close();
    registry.close();
  });

  it('recovers a reminder crash window with the original stable execution id and target text', async () => {
    const store = new MemoryScheduleStore();
    const saved = await store.create(schedule());
    await store.createManualRun({ ...run(saved), status: 'dispatching', targetExecutionId: 'schedrun:run' });
    const registry = new ScheduleDispatcherRegistry();
    const reminder = new ReminderScheduleDispatcher();
    const dispatched = vi.spyOn(reminder, 'dispatch');
    registry.register(reminder);
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), registry, 'recovery', {
      now: () => new Date(NOW), idGenerator: sequence(), ...inertTimers
    });
    await engine.initialize();
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'schedrun:run' }));
    expect(await store.getRun('run')).toMatchObject({ status: 'completed', targetExecutionId: 'schedrun:run',
      deliveryItems: expect.arrayContaining([expect.objectContaining({ payloadSnapshot: expect.objectContaining({ content: saved.target.kind === 'reminder' ? saved.target.text : '' }) })]) });
    await engine.close();
  });

  it('reads committed execution content, never a preview or raw tool output, and fixes limited destinations', async () => {
    const item = schedule({ target: { kind: 'agent', sessionId: 's', input: { content: [{ type: 'text', text: 'weather' }] }, providerId: 'p', model: 'm' } });
    const snapshot = { ...run(item), resultPreview: 'RAW TOOL SECRET' };
    const reader = vi.fn(async () => `# 正文\n\n[天气](https://example.com)\n\n\`\`\`sh\nSECRET\n\`\`\`\n${'晴'.repeat(1_000)}`);
    const items = await prepareScheduleDeliveries(snapshot, { resultContent: { readCommittedResult: reader }, idGenerator: sequence() });
    expect(reader).toHaveBeenCalledWith({ targetKind: 'agent', executionId: 'schedrun:run' });
    const spoken = items.find((entry) => entry.destination === 'voice')?.payloadSnapshot.content;
    expect(spoken).toHaveLength(600);
    expect(spoken).not.toMatch(/RAW TOOL|SECRET|https|```/u);
    expect(items.find((entry) => entry.destination === 'conversation')?.payloadSnapshot.content).toContain('晴'.repeat(1_000));
    const fallback = await prepareScheduleDeliveries(snapshot, { resultContent: { readCommittedResult: async () => { throw new Error('secret path'); } }, idGenerator: sequence() });
    expect(fallback).toEqual(expect.arrayContaining([expect.objectContaining({ errorCode: 'schedule_result_read_failed', payloadSnapshot: expect.objectContaining({ content: '任务已完成，请查看结果。' }) })]));
  });

  it('uses the run snapshot after its schedule name, target, and destination are edited', async () => {
    const store = new MemoryScheduleStore();
    const original = await store.create(schedule({ target: { kind: 'agent', sessionId: 's', input: { content: [{ type: 'text', text: 'old' }] }, providerId: 'p', model: 'm' } }));
    let listener: ((event: TargetExecutionEvent) => void) | undefined;
    const dispatcher: ScheduleTargetDispatcher = {
      dispatch: async (input: ScheduleDispatchRequest) => ({ kind: input.target.kind, id: input.executionId, state: 'running' }),
      inspect: async () => undefined, cancel: async () => undefined, supportsIdempotentDispatch: () => true,
      subscribe: (next) => { listener = next; return () => undefined; }
    };
    const engine = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), dispatcher, 'engine', {
      now: () => new Date(NOW), idGenerator: sequence(), resultContent: { readCommittedResult: async () => '原任务结果' }, ...inertTimers
    });
    await engine.initialize();
    const started = await engine.runNow(original);
    await store.update({ ...original, name: '新名字', target: { kind: 'reminder', text: '新内容' }, delivery: {
      voice, conversation: { enabled: true, sessionId: 'new-session' }
    }, updatedAt: NOW }, original.revision);
    const final: TargetExecutionSnapshot = { kind: 'agent', id: started.targetExecutionId ?? '', state: 'completed', resultPreview: '不应投递这个预览' };
    listener?.({ snapshot: final });
    await expect.poll(() => store.getRun(started.id)).toMatchObject({ status: 'completed', deliveryItems: expect.arrayContaining([
      expect.objectContaining({ destinationId: 'original-session', payloadSnapshot: expect.objectContaining({ title: '喝水', content: '原任务结果' }) })
    ]) });
    expect((await store.listDeliveries()).some((entry) => entry.destinationId === 'new-session')).toBe(false);
    await engine.close();
  });

  it('bounds UTF-16 payloads without cutting an emoji surrogate pair', async () => {
    const item = schedule({ target: { kind: 'agent', sessionId: 's', input: { content: [{ type: 'text', text: 'result' }] }, providerId: 'p', model: 'm' },
      delivery: { voice: { ...voice, content: { kind: 'result', maxChars: 599 } } } });
    const items = await prepareScheduleDeliveries(run(item), {
      resultContent: { readCommittedResult: async () => '😀'.repeat(1_000) }, idGenerator: sequence()
    });
    const content = items[0]?.payloadSnapshot.content ?? '';
    expect(content.length).toBe(598);
    expect(content).toBe('😀'.repeat(299));
  });

  it('restores immutable conversation intents after restart using the same id and createdAt', async () => {
    const { store } = await seed(schedule({ delivery: { conversation: { enabled: true, sessionId: 'original-session' } } }));
    const messages: Message[] = [];
    const adapter = new LegacyScheduleDeliveryAdapter(store, new ConversationScheduleDeliveryService({
      appendMessage: async (_sessionId, message) => { messages.push(message); }
    }));
    const processor = new DurableScheduleDeliveryProcessor(store, adapter, { now: () => new Date(NOW), idGenerator: sequence(), ...inertTimers });
    await processor.initialize();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ state: 'delivered' }]);
    expect(messages).toMatchObject([{ id: 'scheduler_run', createdAt: NOW, content: [{ type: 'text', text: '休息一下，喝杯水。' }] }]);
    await processor.close();
    const restarted = new DurableScheduleDeliveryProcessor(store, adapter, { now: () => new Date(NOW), ...inertTimers });
    await restarted.initialize();
    expect(messages).toHaveLength(1);
    await restarted.close();
  });

  it('retries transient preparation with bounded 1 / 5 second delays and fresh claim tokens', async () => {
    const { store } = await seed(schedule({ delivery: { voice } }));
    let now = Date.parse(NOW);
    const tokens: string[] = [];
    const processor = new DurableScheduleDeliveryProcessor(store, { deliver: async (_item, context) => {
      tokens.push(context.identity.claimToken);
      return { status: 'failed', reason: 'network_unavailable', retryable: true };
    } }, { now: () => new Date(now), idGenerator: sequence(), ...inertTimers });
    await processor.initialize();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ attempts: 1, state: 'failed', nextAttemptAt: new Date(now + 1_000).toISOString() }]);
    now += 999; await processor.pump(); expect(tokens).toHaveLength(1);
    now += 1; await processor.pump();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ attempts: 2, nextAttemptAt: new Date(now + 5_000).toISOString() }]);
    now += 5_000; await processor.pump();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ attempts: 3, state: 'failed' }]);
    expect((await store.listDeliveries())[0]?.nextAttemptAt).toBeUndefined();
    now += 15_000; await processor.pump(); expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
    await processor.close();
  });

  it('does not retry permanent authentication failure or replay a voice lease whose sound is uncertain', async () => {
    const { store } = await seed(schedule({ delivery: { voice } }));
    let now = Date.parse(NOW);
    const deliver = vi.fn(async () => ({ status: 'failed' as const, reason: 'unauthorized', retryable: true }));
    const processor = new DurableScheduleDeliveryProcessor(store, { deliver }, { now: () => new Date(now), ...inertTimers });
    await processor.initialize();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ state: 'failed', attempts: 1 }]);
    now += 5_000; await processor.pump(); expect(deliver).toHaveBeenCalledTimes(1);
    await processor.close();
    const item = (await store.listDeliveries())[0];
    const replay = await store.replayDelivery(item?.id ?? '', now);
    const claim = await store.claimDelivery({ itemId: replay?.id ?? '', claimToken: 'old-token', playbackId: 'old-play', generation: 1, now, ttlMs: 20_000 });
    expect(claim?.state).toBe('claimed');
    now += 20_000;
    const recovered = new DurableScheduleDeliveryProcessor(store, { deliver }, { now: () => new Date(now), ...inertTimers });
    await recovered.initialize();
    expect(await store.getDelivery(item?.id ?? '')).toMatchObject({ state: 'uncertain', errorCode: 'delivery_claim_expired' });
    expect(deliver).toHaveBeenCalledTimes(1);
    await recovered.close();
  });

  it('reconciles an accepted channel outbox receipt without consuming another retry attempt', async () => {
    const { store } = await seed(schedule({ delivery: { channels: [{ enabled: true, bindingId: 'channel' }] } }));
    let sent = false;
    const deliver = vi.fn(async () => ({ status: 'deferred' as const }));
    const inspect = vi.fn(async () => sent ? { status: 'delivered' as const } : { status: 'deferred' as const });
    const processor = new DurableScheduleDeliveryProcessor(store, { deliver, inspect }, { now: () => new Date(NOW), ...inertTimers });
    await processor.initialize();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ state: 'claimed', attempts: 1 }]);
    await processor.pump(); expect(inspect).toHaveBeenCalled();
    sent = true; await processor.pump();
    expect(await store.listDeliveries()).toMatchObject([{ state: 'delivered', attempts: 1 }]);
    expect(deliver).toHaveBeenCalledTimes(1);
    await processor.close();
  });

  it('recovers persisted intents when a standby becomes leader after initialization', async () => {
    const { store } = await seed(schedule({ delivery: { conversation: { enabled: true, sessionId: 'original-session' } } }));
    await store.acquireEngineLease('leader', Date.parse(NOW), 30_000);
    const registry = new ScheduleDispatcherRegistry();
    registry.register(new ReminderScheduleDispatcher());
    const deliver = vi.fn(async () => ({ status: 'delivered' as const }));
    const standby = new DurableScheduleEngine(store, new DefaultScheduleCalculator(), registry, 'standby', {
      now: () => new Date(NOW), deliveryAdapter: { deliver }, ...inertTimers
    });
    await standby.initialize();
    expect(deliver).not.toHaveBeenCalled();
    await store.releaseEngineLease('leader');
    standby.poke();
    await expect.poll(() => store.listDeliveries()).toMatchObject([{ state: 'delivered' }]);
    expect(deliver).toHaveBeenCalledTimes(1);
    await standby.close();
  });
});

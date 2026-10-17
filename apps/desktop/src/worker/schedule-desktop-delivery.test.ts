import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechProviderError, SpeechSettingsSchema, type AudioAsset, type AudioAssetOwner,
  type SpeechAssetStore, type SpeechProvider, type WorkerMessage, type SchedulePlaybackIdentity } from '@desktop-agent/contracts';
import { MemoryScheduleStore, type Schedule, type ScheduleDeliveryItem, type ScheduleStore } from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '@desktop-agent/storage';
import type { ReadySpeechAsset } from '@desktop-agent/storage';
import { DesktopSpeechRuntime } from './speech-runtime.js';
import { DesktopScheduleDeliveryAdapter, scheduleVoicePresetVersion } from './schedule-desktop-delivery.js';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const time = Date.parse('2026-10-14T12:00:00.000Z');
const stamp = (offset = 0) => new Date(time + offset).toISOString();
async function flush() { for (let index = 0; index < 8; index += 1) await Promise.resolve(); await nextTick(); }
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(time); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function harness(kind: 'sqlite' | 'memory' = 'sqlite', destination: 'voice' | 'notification' = 'voice', failCancelPost = false, presetId?: string) {
  const store: ScheduleStore = kind === 'sqlite'
    ? new SqliteScheduleStore(path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-desktop-delivery-')), 'scheduler.sqlite'))
    : new MemoryScheduleStore();
  let settings = SpeechSettingsSchema.parse({ enabled: true, ...(presetId ? {
    voicePresets: [{ id: presetId, name: '早间', speakerId: 'morning-speaker', speechRate: 15 }]
  } : {}) });
  const schedule: Schedule = {
    id: 'schedule', name: '喝水', enabled: true, spec: { kind: 'once', runAt: stamp() }, target: { kind: 'reminder', text: '该喝水了' },
    delivery: { voice: { enabled: true, deviceId: 'local-desktop', content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 120_000,
      ...(presetId ? { presetId } : {}) }, notification: { enabled: true } },
    revision: 1, misfire: { kind: 'fire_once', graceMs: 60_000 }, concurrency: 'skip', createdBy: 'user', createdAt: stamp(), updatedAt: stamp()
  };
  await store.create(schedule);
  await store.createManualRun({ id: 'run', scheduleId: schedule.id, occurrenceKey: 'manual:run', scheduledFor: stamp(), trigger: 'manual',
    status: 'running', targetKind: 'reminder', targetSnapshot: schedule.target, createdAt: stamp() });
  const pending: ScheduleDeliveryItem = {
    id: 'item', scheduleRunId: 'run', destination, destinationId: 'local-desktop', dedupeKey: `run:${destination}`,
    payloadSnapshot: destination === 'voice'
      ? { kind: 'voice', title: schedule.name, content: '该喝水了', deviceId: 'local-desktop', messageId: 'message', createdAt: stamp(),
        ...(presetId ? { presetId } : {}), presetVersion: scheduleVoicePresetVersion(settings, presetId) }
      : { kind: 'notification', title: schedule.name, content: '该喝水了', messageId: 'message', createdAt: stamp() },
    state: 'pending', attempts: 0, createdAt: stamp(), updatedAt: stamp(), expiresAt: stamp(120_000), version: 1
  };
  await store.transitionRunWithDeliveries('run', { status: 'completed', finishedAt: stamp() }, [pending], 1);
  const identity: SchedulePlaybackIdentity = { itemId: 'item', claimToken: 'claim', playbackId: 'playback', generation: 1 };
  const item = (await store.claimDelivery({ ...identity, now: time, ttlMs: 20_000 }))!;
  const references = new Map<string, AudioAsset>();
  const released = vi.fn(async (asset: AudioAsset) => { references.delete(asset.id); });
  const assets: SpeechAssetStore & { close(): void; getReadyAsset(id: string, owner: AudioAssetOwner): Promise<ReadySpeechAsset | undefined> } = {
    find: vi.fn(async () => undefined),
    begin: vi.fn(async (_key: string, owner: AudioAssetOwner) => ({
      append: vi.fn(async () => undefined),
      complete: vi.fn(async () => {
        const asset: AudioAsset = { id: randomUUID(), owner, bytes: 2, format: 'wav', sampleRate: 24000, createdAt: Date.now(), expiresAt: Date.now() + 86_400_000 };
        references.set(asset.id, asset); return asset;
      }),
      abort: vi.fn(async () => undefined)
    })),
    release: released, releaseOwner: vi.fn(async (owner) => { for (const asset of references.values()) if (asset.owner.kind === owner.kind && asset.owner.id === owner.id) references.delete(asset.id); }),
    clear: vi.fn(async () => references.clear()), close: vi.fn(),
    getReadyAsset: vi.fn(async (id, owner) => {
      const asset = references.get(id);
      if (!asset || asset.owner.kind !== owner.kind || asset.owner.id !== owner.id) return undefined;
      return { asset, path: `/offline/${id}.wav` };
    })
  };
  const audioGate = deferred<void>(); const entered = deferred<void>(); const signals: AbortSignal[] = [];
  const provider: SpeechProvider = {
    asr: { recognize: vi.fn(async function* (request: Parameters<SpeechProvider['asr']['recognize']>[0]): ReturnType<SpeechProvider['asr']['recognize']> { yield { type: 'ready', requestId: request.requestId }; }) },
    tts: { synthesize: vi.fn(async function* (request: Parameters<SpeechProvider['tts']['synthesize']>[0]): ReturnType<SpeechProvider['tts']['synthesize']> {
      signals.push(request.signal); entered.resolve();
      const cancelled = deferred<void>();
      const abort = () => cancelled.reject(new SpeechProviderError('cancelled', 'Offline speech was cancelled.'));
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      try { await Promise.race([audioGate.promise, cancelled.promise]); }
      finally { request.signal.removeEventListener('abort', abort); }
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      yield { type: 'completed', requestId: request.requestId };
    }) }
  };
  const speech = new DesktopSpeechRuntime('/unused', { assets, createProvider: () => provider });
  await speech.configure(settings);
  const posted = deferred<Extract<WorkerMessage, { type: 'scheduler.desktop.delivery' }>>();
  const messages: WorkerMessage[] = [];
  const adapter = new DesktopScheduleDeliveryAdapter({ speech, store: () => store, readSettings: () => settings,
    post: message => {
      if (failCancelPost && message.type === 'scheduler.desktop.cancel') throw new Error('Worker output port closed.');
      messages.push(message); if (message.type === 'scheduler.desktop.delivery') posted.resolve(message);
    } });
  const cancel = new AbortController();
  cleanups.push(async () => { cancel.abort(); adapter.close(); audioGate.resolve(); await flush(); speech.close(); await store.close?.(); });
  return { store, schedule, identity, item, provider, entered, signals, audioGate, speech, assets, references, released, adapter, posted, messages, cancel,
    currentSettings: () => settings,
    async configure(next = { ...settings, provider: { ...settings.provider, tts: { ...settings.provider.tts, speechRate: 10 } } }) { settings = next; await speech.configure(next); },
    deliver() { return adapter.deliver(item, { identity, signal: cancel.signal }); } };
}

for (const kind of ['sqlite', 'memory'] as const) describe(`${kind} Worker schedule delivery bridge`, () => {
  it('renews the real claim every five seconds during TTS and requires start before durable played ACK', async () => {
    const fixture = await harness(kind); const delivering = fixture.deliver(); await fixture.entered.promise;
    const renew = vi.spyOn(fixture.store, 'renewDeliveryClaim');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(renew).toHaveBeenCalledTimes(5);
    expect(await fixture.store.getDelivery('item')).toMatchObject({ state: 'preparing', claimExpiresAt: stamp(45_000) });
    fixture.audioGate.resolve(); const message = await fixture.posted.promise;
    expect(message.delivery).toMatchObject({ kind: 'voice', scheduleId: 'schedule', scheduleRunId: 'run', identity: fixture.identity });
    expect([...fixture.references.values()]).toMatchObject([{ owner: { kind: 'schedule', id: 'schedule' } }]);
    expect(await fixture.store.ackDelivery({ ...fixture.identity, state: 'played', now: Date.now() })).toBeUndefined();
    expect(await fixture.store.ackDelivery({ ...fixture.identity, state: 'playing', now: Date.now() })).toMatchObject({ state: 'playing' });
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'played' });
    expect(await delivering).toEqual({ status: 'played' });
    expect(await fixture.store.ackDelivery({ ...fixture.identity, state: 'played', now: Date.now() })).toMatchObject({ state: 'played' });
    expect(await fixture.store.ackDelivery({ ...fixture.identity, state: 'played', now: Date.now() })).toBeUndefined();
    const calls = renew.mock.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(renew).toHaveBeenCalledTimes(calls);
  });
  it('ignores a stale Main generation and clears its pending output request when closed', async () => {
    const fixture = await harness(kind); fixture.audioGate.resolve(); const delivering = fixture.deliver();
    const message = await fixture.posted.promise; const settled = vi.fn(); void delivering.then(settled);
    fixture.adapter.accept(message.requestId, { identity: { ...fixture.identity, generation: 0 }, state: 'played' }); await flush();
    expect(settled).not.toHaveBeenCalled(); expect(await fixture.store.getDelivery('item')).toMatchObject({ state: 'ready' });
    fixture.adapter.close(); expect(await delivering).toMatchObject({ status: 'interrupted' });
    expect(fixture.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'scheduler.desktop.cancel', identity: fixture.identity })]));
    const count = fixture.messages.length;
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'played' }); await vi.advanceTimersByTimeAsync(310_000);
    expect(fixture.messages).toHaveLength(count);
  });
  it('cancels the active provider and prevents output when configuration changes during preparation', async () => {
    const fixture = await harness(kind); const delivering = fixture.deliver(); await fixture.entered.promise;
    await fixture.configure(); expect(fixture.signals[0]?.aborted).toBe(true);
    expect(await delivering).toMatchObject({ status: 'interrupted' }); expect(fixture.messages).toEqual([]);
    expect(fixture.references.size).toBe(0); expect(fixture.provider.asr.recognize).not.toHaveBeenCalled();
  });
  it('aborts pre-play TTS when its lease is no longer renewable', async () => {
    const fixture = await harness(kind); const delivering = fixture.deliver(); await fixture.entered.promise;
    vi.setSystemTime(time + 20_001); await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.signals[0]?.aborted).toBe(true); expect(await delivering).toMatchObject({ status: 'interrupted' });
    expect(await fixture.store.getDelivery('item')).toMatchObject({ state: 'uncertain' });
    expect(fixture.messages).toEqual([]); expect(await fixture.store.claimDelivery({ ...fixture.identity, claimToken: 'new', now: Date.now(), ttlMs: 20_000 })).toBeUndefined();
  });
});

describe('Worker schedule delivery cancellation boundaries', () => {
  it('keeps independent preset snapshots valid when only the default speaker changes', async () => {
    const fixture = await harness('sqlite', 'voice', false, 'morning');
    const changed = structuredClone(fixture.currentSettings()); changed.provider.tts.speakerId = 'new-default';
    expect(scheduleVoicePresetVersion(changed, 'morning')).toBe(scheduleVoicePresetVersion(fixture.currentSettings(), 'morning'));
    expect(scheduleVoicePresetVersion(changed)).not.toBe(scheduleVoicePresetVersion(fixture.currentSettings()));
    await fixture.configure(changed); fixture.audioGate.resolve();
    const delivering = fixture.deliver(); const message = await fixture.posted.promise;
    expect(fixture.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ speakerId: 'morning-speaker', speechRate: 15 }));
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'suppressed' });
    expect(await delivering).toEqual({ status: 'suppressed' });
  });
  it.each(['modified', 'deleted'] as const)('suppresses an old snapshot whose independent preset was %s', async change => {
    const fixture = await harness('sqlite', 'voice', false, 'morning');
    const changed = structuredClone(fixture.currentSettings());
    if (change === 'deleted') changed.voicePresets = [];
    else changed.voicePresets[0]!.speakerId = 'changed-preset';
    await fixture.configure(changed);
    expect(await fixture.deliver()).toMatchObject({ status: 'suppressed', reason: change === 'deleted' ? 'voice_preset_unavailable' : 'voice_settings_changed' });
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled(); expect(fixture.messages).toEqual([]);
  });
  it('reports preparation only for the matching revision and clears stale state on cancellation or cache removal', async () => {
    const fixture = await harness();
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    const caching = fixture.adapter.precache(fixture.schedule); await fixture.entered.promise;
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('preparing');
    expect(fixture.adapter.preparation({ ...fixture.schedule, revision: 2 }).state).toBe('not_prepared');
    fixture.adapter.cancelAll(); await caching;
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    fixture.audioGate.resolve(); await fixture.adapter.precache(fixture.schedule);
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('ready');
    fixture.adapter.clearPreparation(); await fixture.speech.clearCache();
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    expect(fixture.references.size).toBe(0);
  });
  it('never marks a deleted schedule ready when its in-flight preparation completes', async () => {
    const fixture = await harness(); const caching = fixture.adapter.precache(fixture.schedule); await fixture.entered.promise;
    fixture.adapter.releaseSchedule(fixture.schedule.id); fixture.audioGate.resolve(); await caching;
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    expect(fixture.references.size).toBe(0);
  });
  it('does not show ready after asset expiry or LRU removal', async () => {
    const fixture = await harness(); fixture.audioGate.resolve(); await fixture.adapter.precache(fixture.schedule);
    expect((await fixture.adapter.readPreparation(fixture.schedule)).state).toBe('ready');
    fixture.references.clear();
    expect((await fixture.adapter.readPreparation(fixture.schedule)).state).toBe('not_prepared');
    await fixture.adapter.precache(fixture.schedule); expect(fixture.adapter.preparation(fixture.schedule).state).toBe('ready');
    vi.setSystemTime(time + 86_400_001);
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
  });
  it('keeps a newer revision preparation when a cancelled older revision settles', async () => {
    const fixture = await harness(); const original = fixture.adapter.precache(fixture.schedule); await fixture.entered.promise;
    const changed = { ...fixture.schedule, revision: 2, target: { kind: 'reminder' as const, text: '新的提醒内容' } };
    const updated = fixture.adapter.precache(changed); await flush();
    expect(fixture.signals[0]?.aborted).toBe(true);
    expect(fixture.adapter.preparation(changed).state).toBe('preparing');
    fixture.audioGate.resolve(); await Promise.all([original, updated]);
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    expect((await fixture.adapter.readPreparation(changed)).state).toBe('ready');
    expect([...fixture.references.values()]).toHaveLength(1);
    expect(fixture.provider.tts.synthesize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '新的提醒内容' }));
  });
  it('shows a controlled preparation failure without changing task execution or posting playback', async () => {
    const fixture = await harness();
    fixture.provider.tts.synthesize = vi.fn(async function* (request): ReturnType<SpeechProvider['tts']['synthesize']> {
      yield { type: 'audio', requestId: request.requestId, bytes: Uint8Array.of(1, 2), format: 'wav', sampleRate: 24000 };
      throw new SpeechProviderError('network_error', 'Offline provider failed.');
    });
    await fixture.adapter.precache(fixture.schedule);
    expect(fixture.adapter.preparation(fixture.schedule)).toMatchObject({ state: 'failed', reason: 'network_error' });
    expect(fixture.messages).toEqual([]); expect(fixture.references.size).toBe(0);
    expect((await fixture.store.getRun('run'))?.status).toBe('completed');
  });
  it('previews only fixed reminder text under a separate test owner and never posts automatic playback', async () => {
    const fixture = await harness('sqlite', 'voice', false, 'morning'); fixture.audioGate.resolve();
    const ready = await fixture.adapter.preview({ ...fixture.schedule, enabled: false }, 1);
    expect(ready.asset.owner).toEqual({ kind: 'test', id: expect.stringMatching(/^schedule-preview:[a-f0-9]{64}$/u) });
    expect(fixture.provider.tts.synthesize).toHaveBeenCalledWith(expect.objectContaining({ text: '该喝水了', speakerId: 'morning-speaker', speechRate: 15 }));
    expect(fixture.messages).toEqual([]);
    expect(fixture.adapter.preparation(fixture.schedule).state).toBe('not_prepared');
    const dynamic = { ...fixture.schedule, target: { kind: 'agent' as const, sessionId: 'session',
      input: { content: [{ type: 'text' as const, text: '查天气' }] }, providerId: 'provider', model: 'model' } };
    expect(fixture.adapter.preparation(dynamic).state).toBe('dynamic');
    await expect(fixture.adapter.preview(dynamic, 2)).rejects.toMatchObject({ code: 'speaker_unavailable' });
    expect(fixture.provider.tts.synthesize).toHaveBeenCalledOnce();
  });
  it.each(['fixed', 'reminder'] as const)('does not pre-cache %s speech while globally disabled even if a validation service exists', async (content) => {
    const fixture = await harness();
    await fixture.configure(SpeechSettingsSchema.parse({ enabled: false }));
    const validationService = fixture.speech.serviceForValidation;
    expect(validationService).toBeDefined();
    // A live validation service cannot grant permission for background paid synthesis.
    vi.spyOn(fixture.speech, 'service', 'get').mockReturnValue(validationService);
    fixture.audioGate.resolve();
    const schedule = content === 'fixed'
      ? { ...fixture.schedule, delivery: { ...fixture.schedule.delivery, voice: { ...fixture.schedule.delivery!.voice!, content: { kind: 'fixed' as const, text: '该喝水了' } } } }
      : fixture.schedule;
    await fixture.adapter.precache(schedule);
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled();
    expect(fixture.provider.asr.recognize).not.toHaveBeenCalled();
    expect(fixture.assets.begin).not.toHaveBeenCalled();
    expect(fixture.references.size).toBe(0);
    expect(fixture.messages).toEqual([]);
  });
  it('suppresses stale presets before making a paid provider attempt', async () => {
    const fixture = await harness();
    const changed = SpeechSettingsSchema.parse({ enabled: true, provider: { tts: { speakerId: 'changed-speaker' } } });
    await fixture.configure(changed);
    expect(await fixture.deliver()).toEqual({ status: 'suppressed', reason: 'voice_settings_changed' });
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled(); expect(fixture.messages).toEqual([]);
  });
  it('suppresses disabled speech without asking the provider or output host to do work', async () => {
    const fixture = await harness(); await fixture.configure(SpeechSettingsSchema.parse({ enabled: false }));
    expect(await fixture.deliver()).toEqual({ status: 'suppressed', reason: 'speech_disabled' });
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled(); expect(fixture.messages).toEqual([]);
  });
  it('does not pre-cache an agent result by starting a model execution', async () => {
    const fixture = await harness();
    await fixture.adapter.precache({ ...fixture.schedule, target: { kind: 'agent', sessionId: 'session',
      input: { content: [{ type: 'text', text: '查天气' }] }, providerId: 'provider', model: 'model' } });
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled(); expect(fixture.provider.asr.recognize).not.toHaveBeenCalled();
    expect(fixture.messages).toEqual([]);
  });
  it('clears request timers and resolves cancellation even when its output port rejects cancel', async () => {
    const fixture = await harness('sqlite', 'voice', true); fixture.audioGate.resolve(); const delivering = fixture.deliver();
    const message = await fixture.posted.promise; fixture.adapter.close();
    expect(await delivering).toMatchObject({ status: 'interrupted' });
    const count = fixture.messages.length;
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'played' });
    await vi.advanceTimersByTimeAsync(310_000); expect(fixture.messages).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('classifies missing Main completion as uncertain instead of implying a user interruption', async () => {
    const fixture = await harness('memory', 'notification');
    // A notification can remain leased independently of a speech content expiry.
    vi.spyOn(fixture.store, 'renewDeliveryClaim').mockImplementation(async () => fixture.item);
    const delivering = fixture.deliver(); await fixture.posted.promise;
    await vi.advanceTimersByTimeAsync(310_000);
    expect(await delivering).toEqual({ status: 'uncertain', reason: 'desktop_output_timeout' });
    expect(fixture.messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'scheduler.desktop.cancel', identity: fixture.identity })]));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves an independent pending notification when speech configuration changes', async () => {
    const fixture = await harness('sqlite', 'notification'); const delivering = fixture.deliver(); const message = await fixture.posted.promise;
    await fixture.configure();
    expect(fixture.messages.filter((entry) => entry.type === 'scheduler.desktop.cancel')).toEqual([]);
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'delivered' });
    expect(await delivering).toEqual({ status: 'delivered' }); expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled();
  });
  it('also preserves notification delivery if speech invalidation occurs during its initial lookup', async () => {
    const fixture = await harness('memory', 'notification');
    const getRun = fixture.store.getRun.bind(fixture.store); const gate = deferred<Awaited<ReturnType<ScheduleStore['getRun']>>>();
    vi.spyOn(fixture.store, 'getRun').mockImplementationOnce(() => gate.promise);
    const delivering = fixture.deliver(); await fixture.configure(); gate.resolve(await getRun('run')); await flush();
    expect(fixture.messages).toMatchObject([{ type: 'scheduler.desktop.delivery', delivery: { kind: 'notification' } }]);
    const message = await fixture.posted.promise;
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'delivered' });
    expect(await delivering).toEqual({ status: 'delivered' });
  });
  it('compares Main identity fields independently of JSON property order', async () => {
    const fixture = await harness(); fixture.audioGate.resolve();
    const identity = { generation: 1, playbackId: 'playback', claimToken: 'claim', itemId: 'item' };
    const delivering = fixture.adapter.deliver(fixture.item, { identity, signal: fixture.cancel.signal });
    const message = await fixture.posted.promise; const settled = vi.fn(); void delivering.then(settled);
    fixture.adapter.accept(message.requestId, { identity: fixture.identity, state: 'suppressed' }); await flush();
    expect(settled).toHaveBeenCalledWith({ status: 'suppressed' });
    expect(await delivering).toEqual({ status: 'suppressed' });
  });
  it('does not restart TTS when close occurs during the asynchronous initial run lookup', async () => {
    const fixture = await harness(); const getRun = fixture.store.getRun.bind(fixture.store); const gate = deferred<Awaited<ReturnType<ScheduleStore['getRun']>>>();
    vi.spyOn(fixture.store, 'getRun').mockImplementationOnce(() => gate.promise);
    const delivering = fixture.deliver(); fixture.adapter.close(); gate.resolve(await getRun('run')); await flush();
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled();
    expect(await delivering).toMatchObject({ status: 'interrupted' });
  });
  it('does not lose configuration invalidation during the initial run lookup', async () => {
    const fixture = await harness(); const getRun = fixture.store.getRun.bind(fixture.store); const gate = deferred<Awaited<ReturnType<ScheduleStore['getRun']>>>();
    vi.spyOn(fixture.store, 'getRun').mockImplementationOnce(() => gate.promise);
    const delivering = fixture.deliver(); await fixture.configure(); gate.resolve(await getRun('run')); await flush();
    expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled();
    expect(await delivering).toMatchObject({ status: 'interrupted' });
  });
  it('cancels a deleted schedule provider immediately without waiting for lease polling', async () => {
    const fixture = await harness(); const delivering = fixture.deliver(); await fixture.entered.promise;
    await fixture.store.softDelete('schedule', new Date(Date.now()).toISOString()); fixture.adapter.releaseSchedule('schedule'); await flush();
    expect(fixture.signals[0]?.aborted).toBe(true); expect(await delivering).toMatchObject({ status: 'interrupted' });
    expect(await fixture.store.getDelivery('item')).toMatchObject({ state: 'suppressed' });
    expect(fixture.assets.releaseOwner).toHaveBeenCalledWith({ kind: 'schedule', id: 'schedule' });
  });
  it('only explicitly pre-caches configured speech and cannot start a new attempt after close', async () => {
    const fixture = await harness(); expect(fixture.provider.tts.synthesize).not.toHaveBeenCalled();
    const caching = fixture.adapter.precache(fixture.schedule); await fixture.entered.promise;
    expect(fixture.provider.tts.synthesize).toHaveBeenCalledOnce(); expect(fixture.provider.asr.recognize).not.toHaveBeenCalled();
    fixture.audioGate.resolve(); await caching;
    expect([...fixture.references.values()]).toMatchObject([{ owner: { kind: 'schedule', id: 'schedule' } }]);
    fixture.adapter.close(); await fixture.adapter.precache(fixture.schedule);
    expect(fixture.provider.tts.synthesize).toHaveBeenCalledOnce();
  });
});

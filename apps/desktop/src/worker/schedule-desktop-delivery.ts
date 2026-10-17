import { createHash, randomUUID } from 'node:crypto';
import { ScheduleDesktopOutcomeSchema, SpeechProviderError, resolveSpeechPresetSettings, type ScheduleDesktopDelivery, type ScheduleDesktopOutcome,
  type SchedulePlaybackIdentity, type SpeechSettings, type WorkerMessage, type ScheduleVoicePreparation, type AudioAsset } from '@desktop-agent/contracts';
import type { Schedule, ScheduleDeliveryAdapter, ScheduleDeliveryAttemptResult, ScheduleDeliveryItem, ScheduleStore } from '@desktop-agent/scheduler';
import type { ReadySpeechAsset } from '@desktop-agent/storage';
import type { DesktopSpeechRuntime } from './speech-runtime';

export function scheduleVoicePresetVersion(settings: SpeechSettings, presetId?: string): string {
  const provider = resolveSpeechPresetSettings(settings, presetId).provider;
  return createHash('sha256').update(JSON.stringify(presetId ? provider.tts : provider)).digest('hex');
}

/** Scheduler owns durable claims; this bridge only prepares sound and asks Main to output it. */
export class DesktopScheduleDeliveryAdapter implements ScheduleDeliveryAdapter {
  private readonly requests = new Map<string, { identity: SchedulePlaybackIdentity; resolve(value: ScheduleDesktopOutcome): void }>();
  private readonly preparations = new Map<string, AbortController>();
  private readonly owners = new Map<string, string>();
  private readonly preparationStates = new Map<string, { value: ScheduleVoicePreparation; presetVersion: string; asset?: AudioAsset }>();
  private readonly unsubscribe: () => void;
  private closed = false;
  private epoch = 0;
  constructor(private readonly options: {
    speech: DesktopSpeechRuntime; store(): ScheduleStore; readSettings(): SpeechSettings;
    post(message: WorkerMessage): void;
  }) {
    this.unsubscribe = options.speech.onInvalidated(() => this.cancelAll());
  }
  accept(requestId: string, raw: ScheduleDesktopOutcome): void {
    const outcome = ScheduleDesktopOutcomeSchema.parse(raw);
    const request = this.requests.get(requestId);
    if (request && request.identity.itemId === outcome.identity.itemId && request.identity.claimToken === outcome.identity.claimToken
      && request.identity.playbackId === outcome.identity.playbackId && request.identity.generation === outcome.identity.generation) request.resolve(outcome);
  }
  async deliver(item: ScheduleDeliveryItem, context: { identity: SchedulePlaybackIdentity; signal: AbortSignal }): Promise<ScheduleDeliveryAttemptResult> {
    if (this.closed) return { status: 'uncertain', reason: 'desktop_delivery_closed' };
    const epoch = this.epoch;
    const store = this.options.store();
    const run = await store.getRun(item.scheduleRunId);
    if (this.closed || context.signal.aborted || (item.destination === 'voice' && epoch !== this.epoch)) return { status: 'interrupted', reason: 'desktop_delivery_cancelled' };
    if (!run) return { status: 'suppressed', reason: 'schedule_run_missing' };
    const abort = new AbortController();
    const cancel = () => abort.abort();
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) abort.abort();
    const preparationKey = item.destination === 'notification' ? `notice:${item.id}` : item.id;
    this.preparations.set(preparationKey, abort);
    if (item.destination === 'voice') this.owners.set(preparationKey, run.scheduleId);
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || abort.signal.aborted) return;
      renewing = true;
      void store.renewDeliveryClaim({ ...context.identity, now: Date.now(), ttlMs: 20_000 })
        .then(alive => { if (!alive) abort.abort(); }, () => abort.abort()).finally(() => { renewing = false; });
    }, 5_000);
    timer.unref?.();
    try {
      let delivery: ScheduleDesktopDelivery;
      if (item.payloadSnapshot.kind === 'notification') {
        delivery = { kind: 'notification', identity: context.identity, scheduleId: run.scheduleId,
          scheduleRunId: run.id, title: item.payloadSnapshot.title, ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) };
      } else if (item.payloadSnapshot.kind === 'voice') {
        const settings = this.options.readSettings();
        let service;
        try { service = this.options.speech.serviceForPreset(item.payloadSnapshot.presetId); }
        catch { return { status: 'suppressed', reason: 'voice_preset_unavailable' }; }
        if (!settings.enabled || !service) return { status: 'suppressed', reason: 'speech_disabled' };
        if (item.payloadSnapshot.presetVersion && item.payloadSnapshot.presetVersion !== scheduleVoicePresetVersion(settings, item.payloadSnapshot.presetId)) {
          return { status: 'suppressed', reason: 'voice_settings_changed' };
        }
        if (!(await store.ackDelivery({ ...context.identity, now: Date.now(), state: 'preparing' }))) {
          return { status: 'uncertain', reason: 'delivery_claim_lost' };
        }
        const asset = await service.synthesize({ text: item.payloadSnapshot.content,
          owner: { kind: 'schedule', id: run.scheduleId }, signal: abort.signal, maxChars: 600 });
        if (abort.signal.aborted || !await store.ackDelivery({ ...context.identity, now: Date.now(), state: 'ready' })) {
          await this.options.speech.releaseAsset(asset).catch(() => undefined);
          return { status: 'uncertain', reason: 'delivery_claim_lost' };
        }
        delivery = { kind: 'voice', identity: context.identity, scheduleId: run.scheduleId, scheduleRunId: run.id,
          assetId: asset.id, expiresAt: item.expiresAt ?? new Date(asset.expiresAt).toISOString() };
      } else return { status: 'failed', reason: 'desktop_delivery_unsupported', retryable: false };
      if (abort.signal.aborted) return { status: 'interrupted', reason: 'desktop_delivery_cancelled' };
      const outcome = await this.request(delivery, abort.signal);
      return outcome.state === 'failed'
        ? { status: 'failed', reason: outcome.errorCode ?? 'desktop_delivery_failed', retryable: false }
        : { status: outcome.state, ...(outcome.errorCode ? { reason: outcome.errorCode } : {}) };
    } catch (error) {
      if (abort.signal.aborted) return { status: 'interrupted', reason: 'desktop_delivery_cancelled' };
      const code = error instanceof SpeechProviderError ? error.code : 'desktop_delivery_failed';
      return { status: 'failed', reason: code, retryable: ['timeout', 'network_error', 'rate_limited'].includes(code) };
    } finally {
      clearInterval(timer); context.signal.removeEventListener('abort', cancel);
      if (this.preparations.get(preparationKey) === abort) this.preparations.delete(preparationKey);
      this.owners.delete(preparationKey);
    }
  }
  private request(delivery: ScheduleDesktopDelivery, signal: AbortSignal): Promise<ScheduleDesktopOutcome> {
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (value: ScheduleDesktopOutcome) => {
        signal.removeEventListener('abort', cancel); clearTimeout(timer); this.requests.delete(requestId); resolve(value);
      };
      const cancel = () => {
        try { this.options.post({ type: 'scheduler.desktop.cancel', identity: delivery.identity }); }
        catch { /* A disconnected Main cannot keep this attempt alive. */ }
        finally { finish({ identity: delivery.identity, state: 'interrupted', errorCode: 'desktop_delivery_cancelled' }); }
      };
      const timer = setTimeout(() => {
        try { this.options.post({ type: 'scheduler.desktop.cancel', identity: delivery.identity }); }
        catch { /* Stop locally even when the cancellation channel is gone. */ }
        finally { finish({ identity: delivery.identity, state: 'uncertain', errorCode: 'desktop_output_timeout' }); }
      }, 310_000); timer.unref?.();
      this.requests.set(requestId, { identity: delivery.identity, resolve: finish });
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) { cancel(); return; }
      try { this.options.post({ type: 'scheduler.desktop.delivery', requestId, delivery }); }
      catch { finish({ identity: delivery.identity, state: 'failed', errorCode: 'desktop_output_unavailable' }); }
    });
  }
  private fixedText(schedule: Schedule): string | undefined {
    const content = schedule.delivery?.voice?.content;
    return content?.kind === 'fixed' ? content.text : schedule.target.kind === 'reminder' ? schedule.target.text : undefined;
  }
  preparation(schedule: Schedule): ScheduleVoicePreparation {
    const value = (state: ScheduleVoicePreparation['state'], reason?: string): ScheduleVoicePreparation => ({
      scheduleId: schedule.id, revision: schedule.revision, state, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {})
    });
    if (this.closed || !schedule.delivery?.voice?.enabled || !this.options.readSettings().enabled) {
      return value('unavailable', 'speech_disabled');
    }
    let version: string;
    try { version = scheduleVoicePresetVersion(this.options.readSettings(), schedule.delivery.voice.presetId); }
    catch { return value('unavailable', 'voice_preset_unavailable'); }
    if (!this.options.speech.service) return value('unavailable', 'speech_unavailable');
    if (!this.fixedText(schedule)) return value('dynamic');
    const state = this.preparationStates.get(schedule.id);
    return state?.value.revision === schedule.revision && state.presetVersion === version
      && (state.value.state !== 'ready' || (state.asset && state.asset.expiresAt > Date.now())) ? state.value : value('not_prepared');
  }
  /** UI reads also verify the opaque reference: LRU eviction must not leave a false ready label. */
  async readPreparation(schedule: Schedule): Promise<ScheduleVoicePreparation> {
    const value = this.preparation(schedule);
    const state = this.preparationStates.get(schedule.id);
    if (value.state !== 'ready' || !state?.asset) return value;
    const live = await this.options.speech.resolveAsset(state.asset.id, state.asset.owner);
    if (!live && this.preparationStates.get(schedule.id) === state) this.preparationStates.delete(schedule.id);
    return this.preparation(schedule);
  }
  private recordPreparation(schedule: Schedule, presetVersion: string, state: ScheduleVoicePreparation['state'], reason?: string, asset?: AudioAsset): void {
    const previous = this.preparationStates.get(schedule.id)?.asset;
    const reference = asset ?? previous;
    this.preparationStates.delete(schedule.id);
    this.preparationStates.set(schedule.id, { presetVersion, ...(reference ? { asset: reference } : {}), value: {
      scheduleId: schedule.id, revision: schedule.revision, state, updatedAt: new Date().toISOString(), ...(reason ? { reason } : {})
    } });
    if (asset && previous && asset.id !== previous.id) void this.options.speech.releaseAsset(previous).catch(() => undefined);
    while (this.preparationStates.size > 200) {
      const oldest = this.preparationStates.keys().next().value!;
      const reference = this.preparationStates.get(oldest)?.asset;
      this.preparationStates.delete(oldest);
      if (reference) void this.options.speech.releaseAsset(reference).catch(() => undefined);
    }
  }
  async precache(schedule: Schedule): Promise<void> {
    if (!schedule.enabled) return;
    const state = this.preparation(schedule);
    if (['unavailable', 'dynamic', 'ready', 'preparing'].includes(state.state)) return;
    const settings = this.options.readSettings();
    const presetId = schedule.delivery?.voice?.presetId;
    const service = this.options.speech.serviceForPreset(presetId);
    if (!service) return;
    const text = this.fixedText(schedule)!;
    const abort = new AbortController(); const key = `precache:${schedule.id}`;
    if (this.preparations.size >= 20 && !this.preparations.has(key)) return;
    const epoch = this.epoch;
    const version = scheduleVoicePresetVersion(settings, presetId);
    this.preparations.get(key)?.abort(); this.preparations.set(key, abort);
    this.recordPreparation(schedule, version, 'preparing');
    const current = () => !this.closed && !abort.signal.aborted && epoch === this.epoch
      && this.preparations.get(key) === abort && this.preparationStates.get(schedule.id)?.value.revision === schedule.revision;
    try {
      const asset = await service.synthesize({ text, owner: { kind: 'schedule', id: schedule.id }, maxChars: 200, signal: abort.signal });
      if (current()) this.recordPreparation(schedule, version, 'ready', undefined, asset);
      else await this.options.speech.releaseAsset(asset).catch(() => undefined);
    } catch (error) {
      if (current()) this.recordPreparation(schedule, version, 'failed', error instanceof SpeechProviderError ? error.code : 'speech_preparation_failed');
    } finally { if (this.preparations.get(key) === abort) this.preparations.delete(key); }
  }
  async preview(schedule: Schedule, generation: number): Promise<ReadySpeechAsset> {
    const state = this.preparation(schedule);
    if (state.state === 'unavailable' || state.state === 'dynamic') throw new SpeechProviderError('speaker_unavailable',
      state.state === 'dynamic' ? 'A task result is only available after the task completes.' : 'Schedule voice preview is unavailable.');
    const service = this.options.speech.serviceForPreset(schedule.delivery?.voice?.presetId);
    if (!service) throw new SpeechProviderError('speaker_unavailable', 'Speech configuration is unavailable.');
    const key = `preview:${schedule.id}`;
    if (this.preparations.size >= 20 && !this.preparations.has(key)) throw new SpeechProviderError('rate_limited', 'Too many speech preparations are active.');
    if (!Number.isSafeInteger(generation) || generation < 0) throw new SpeechProviderError('protocol_error', 'Invalid preview generation.');
    const abort = new AbortController(); const epoch = this.epoch;
    this.preparations.get(key)?.abort(); this.preparations.set(key, abort);
    this.owners.set(key, schedule.id);
    const owner = { kind: 'test' as const, id: `schedule-preview:${createHash('sha256').update(schedule.id).digest('hex')}` };
    try {
      const asset = await service.synthesize({ text: this.fixedText(schedule)!, owner, maxChars: 200, signal: abort.signal });
      if (this.closed || abort.signal.aborted || epoch !== this.epoch || this.preparations.get(key) !== abort) {
        await this.options.speech.releaseAsset(asset).catch(() => undefined);
        throw new SpeechProviderError('cancelled', 'Schedule voice preview was cancelled.');
      }
      const ready = await this.options.speech.resolveAsset(asset.id, owner);
      if (!ready || this.closed || abort.signal.aborted || epoch !== this.epoch) {
        await this.options.speech.releaseAsset(asset).catch(() => undefined);
        throw new SpeechProviderError('cancelled', 'Schedule voice preview is unavailable.');
      }
      return ready;
    } finally {
      if (this.preparations.get(key) === abort) { this.preparations.delete(key); this.owners.delete(key); }
    }
  }
  clearPreparation(): void { this.preparationStates.clear(); this.cancelAll(); }
  cancelAll(): void {
    this.epoch++;
    for (const [key, abort] of this.preparations) if (!key.startsWith('notice:')) abort.abort();
    for (const [id, state] of this.preparationStates) if (state.value.state === 'preparing') this.preparationStates.delete(id);
  }
  releaseSchedule(id: string): void {
    this.preparationStates.delete(id);
    this.preparations.get(`precache:${id}`)?.abort();
    for (const [key, owner] of this.owners) if (owner === id) this.preparations.get(key)?.abort();
    void this.options.speech.releaseOwner({ kind: 'schedule', id }).catch(() => undefined);
  }
  close(): void { if (this.closed) return; this.closed = true; this.unsubscribe(); this.cancelAll(); for (const abort of this.preparations.values()) abort.abort(); }
}

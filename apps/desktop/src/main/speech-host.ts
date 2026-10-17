import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { MessageChannelMain, systemPreferences, type BrowserWindow, type MessagePortMain, type UtilityProcess } from 'electron';
import { IPC, SpeechCaptureHandleSchema, SpeechEventSchema, SpeechReadyAssetSchema, SpeechStatusSchema,
  VoiceCommitResultSchema, type BeginSpeechCaptureInput, type CommitVoiceTurnInput, type ReadSpeechMessageInput, type ReadApprovalSpeechInput,
  type SpeechCaptureHandle, type SpeechControl, type SpeechEvent, type SpeechPlaybackState,
  type SpeechSettings, type StopSpeechPlaybackInput, type TestSpeechSettingsInput } from '@desktop-agent/contracts';
import { ScheduleDesktopDeliverySchema, ScheduleVoicePreparationSchema, type PreviewScheduleVoiceInput, type ScheduleDesktopDelivery, type ScheduleDesktopOutcome, type ScheduleDeliveryControl, type SchedulePlaybackIdentity } from '@desktop-agent/contracts';
import { ElectronAudioHost } from './audio-host';
import { PlaybackBroker, type PlaybackEvent } from './playback-broker';
import { SpeechStreamBridge } from './speech-stream';

export interface DesktopSpeechHostOptions {
  dataDirectory: string; buildDirectory: string;
  window(): BrowserWindow | null; worker(): UtilityProcess | null;
  readSettings(): Promise<SpeechSettings>;
  assertSession(sessionId: string): Promise<void>;
  request(control: SpeechControl): Promise<unknown>;
  emit(event: SpeechEvent): void;
  e2e?: boolean;
  deliveryControl?(control: ScheduleDeliveryControl): Promise<boolean>;
}
interface Capture { handle: SpeechCaptureHandle; bridge: SpeechStreamBridge; port?: MessagePortMain;
  runtimePort?: MessagePortMain; attached: boolean; timer: ReturnType<typeof setTimeout> }

function sameDeliveryIdentity(a: SchedulePlaybackIdentity, b: SchedulePlaybackIdentity): boolean {
  return a.itemId === b.itemId && a.claimToken === b.claimToken && a.playbackId === b.playbackId && a.generation === b.generation;
}

export class DesktopSpeechHost {
  private readonly captures = new Map<string, Capture>();
  private readonly playbacks = new Map<string, SpeechPlaybackState>();
  private readonly epochs = new Map<string, number>();
  private readonly automaticReads = new Map<string, { sessionId: string; generation: number; epoch: number }>();
  private automaticReadEpoch = 0;
  private readonly preparingReads = new Map<string, string>();
  private readonly broker: PlaybackBroker;
  private readonly deliveries = new Map<string, { identity: SchedulePlaybackIdentity; resolve(outcome: ScheduleDesktopOutcome): void; timer: ReturnType<typeof setInterval>; failure?: string }>();
  private readonly manualDeliveries = new Map<string, number>();
  private readonly pendingDeliveries = new Map<string, SchedulePlaybackIdentity>();
  private readonly approvalBindings = new Map<string, ReadApprovalSpeechInput>();
  private readonly approvalRequests = new Map<string, Promise<{ playbackId: string; generation: number }>>();
  private settings: SpeechSettings | undefined;
  private globalEpoch = 0;
  private beginEpoch = 0;
  private configEpoch = 0;
  private playbackGeneration = 0;
  private locked = false;
  private closed = false;
  constructor(private readonly options: DesktopSpeechHostOptions) {
    this.broker = new PlaybackBroker({ host: new ElectronAudioHost({ buildDirectory: options.buildDirectory }),
      assetsDirectory: path.join(options.dataDirectory, 'runtime', 'speech-assets'),
      resolveAsset: async (assetId, owner) => SpeechReadyAssetSchema.parse(await options.request({ action: 'resolveAsset', input: { assetId, owner } })),
      onEvent: event => this.playbackEvent(event), beforePlay: async request => {
        const automatic = request.owner.kind === 'session' && !request.manual;
        if (automatic) {
          await this.configure();
          if (!this.automaticReadAllowed(request.playbackId)) return false;
        }
        const approval = this.approvalBindings.get(request.playbackId);
        if (approval) {
          const pending = await this.options.request({ action: 'approvalPending', input: approval });
          await this.configure();
          return pending === true && this.approvalBindings.get(request.playbackId) === approval
            && this.automaticReadAllowed(request.playbackId);
        }
        const delivery = this.deliveries.get(request.playbackId);
        if (!delivery) return request.owner.kind !== 'schedule';
        const allowed = await this.options.deliveryControl?.({ action: 'start', identity: delivery.identity });
        return allowed === true && this.deliveries.get(request.playbackId) === delivery;
      } });
  }
  private playbackEvent(event: PlaybackEvent): void {
    const previous = this.playbacks.get(event.playbackId);
    const state: SpeechPlaybackState = {
      playbackId: event.playbackId, generation: previous?.generation ?? event.generation,
      ...(event.owner.kind === 'session' ? { sessionId: event.owner.id } : {}),
      ...(previous?.messageId ? { messageId: previous.messageId } : {}),
      ...(previous?.nextOffset !== undefined ? { nextOffset: previous.nextOffset } : {}),
      state: event.state === 'started' ? 'playing' : event.state === 'stopped' ? 'interrupted' : event.state,
      ...(event.reason ? { reason: event.reason } : {})
    };
    this.rememberPlayback(state);
    this.options.emit({ type: 'playback', ...state });
    if (['played', 'stopped', 'suppressed', 'failed'].includes(event.state)) {
      this.approvalBindings.delete(event.playbackId);
      this.automaticReads.delete(event.playbackId);
    }
    const delivery = this.deliveries.get(event.playbackId);
    if (delivery && ['played', 'stopped', 'suppressed', 'failed'].includes(event.state)) {
      clearInterval(delivery.timer); this.deliveries.delete(event.playbackId);
      delivery.resolve({ identity: delivery.identity,
        state: delivery.failure ? 'uncertain' : event.state === 'played' ? 'played' : event.state === 'stopped' ? 'interrupted'
          : event.state === 'suppressed' ? 'suppressed' : 'uncertain',
        ...(delivery.failure ?? event.reason ? { errorCode: delivery.failure ?? event.reason } : {}) });
    }
  }
  authorizeReplay(itemId: string): void {
    if (this.manualDeliveries.size >= 100) this.manualDeliveries.delete(this.manualDeliveries.keys().next().value!);
    this.manualDeliveries.set(itemId, Date.now() + 60_000);
  }
  async playScheduled(raw: Extract<ScheduleDesktopDelivery, { kind: 'voice' }>): Promise<ScheduleDesktopOutcome> {
    const input = ScheduleDesktopDeliverySchema.parse(raw);
    if (input.kind !== 'voice') throw new Error('invalid_scheduled_voice');
    const identity = input.identity;
    if (this.closed || this.deliveries.has(identity.playbackId) || this.pendingDeliveries.has(identity.playbackId)) return { identity, state: 'uncertain', errorCode: 'desktop_output_unavailable' };
    const epoch = this.globalEpoch;
    this.pendingDeliveries.set(identity.playbackId, identity);
    try { await this.configure(); }
    catch {
      if (this.pendingDeliveries.get(identity.playbackId) === identity) this.pendingDeliveries.delete(identity.playbackId);
      return { identity, state: 'failed', errorCode: 'desktop_output_unavailable' };
    }
    const alive = this.pendingDeliveries.get(identity.playbackId) === identity;
    if (alive) this.pendingDeliveries.delete(identity.playbackId);
    if (this.closed || epoch !== this.globalEpoch || !alive) return { identity, state: 'interrupted', errorCode: 'desktop_output_cancelled' };
    const manual = (this.manualDeliveries.get(identity.itemId) ?? 0) > Date.now();
    this.manualDeliveries.delete(identity.itemId);
    if (manual) this.broker.resumeOutput();
    return new Promise(resolve => {
      let renewing = false;
      const lost = () => {
        const current = this.deliveries.get(identity.playbackId);
        if (current?.identity === identity) { current.failure = 'delivery_claim_lost'; this.broker.stop(identity.playbackId); }
      };
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void this.options.deliveryControl?.({ action: 'renew', identity }).then(alive => {
          if (!alive) lost();
        }, lost).finally(() => { renewing = false; });
      }, 5_000);
      timer.unref?.();
      this.deliveries.set(identity.playbackId, { identity, resolve, timer });
      this.rememberPlayback({ playbackId: identity.playbackId, generation: identity.generation, state: 'queued' });
      try { this.broker.enqueue({ playbackId: identity.playbackId, assetId: input.assetId,
        // Each occurrence is an independent queue item. Advancing a shared
        // schedule generation would incorrectly interrupt its previous run.
        owner: { kind: 'schedule', id: input.scheduleId }, generation: 0,
        expiresAt: Date.parse(input.expiresAt), manual }); }
      catch { clearInterval(timer); this.deliveries.delete(identity.playbackId); resolve({ identity, state: 'failed', errorCode: 'desktop_output_unavailable' }); }
    });
  }
  cancelScheduled(identity: SchedulePlaybackIdentity): void {
    const pending = this.pendingDeliveries.get(identity.playbackId);
    if (pending && sameDeliveryIdentity(pending, identity)) this.pendingDeliveries.delete(identity.playbackId);
    const current = this.deliveries.get(identity.playbackId);
    if (current && sameDeliveryIdentity(current.identity, identity)) this.broker.stop(identity.playbackId);
  }
  private rememberPlayback(state: SpeechPlaybackState): void {
    this.playbacks.set(state.playbackId, state);
    while (this.playbacks.size > 100) {
      const entries = [...this.playbacks.entries()];
      // Retain the current player/queue identities. Old completed history and
      // pending preparations can be evicted without expanding the status IPC.
      const candidate = entries.find(([id, value]) => id !== state.playbackId &&
        ['played', 'failed', 'interrupted', 'suppressed'].includes(value.state))
        ?? entries.find(([id, value]) => id !== state.playbackId && value.state === 'preparing')
        ?? entries[0]!;
      this.playbacks.delete(candidate[0]);
    }
  }
  private async prepareReadAsset(playbackId: string, control: Extract<SpeechControl, { action: 'readMessage' | 'readApproval' }>): Promise<unknown> {
    const sessionId = control.input.sessionId;
    this.preparingReads.set(sessionId, playbackId);
    try { return await this.options.request(control); }
    finally { if (this.preparingReads.get(sessionId) === playbackId) this.preparingReads.delete(sessionId); }
  }
  private automaticReadAllowed(playbackId: string): boolean {
    return Boolean(this.settings?.enabled && this.settings.autoReadReplies
      && this.automaticReads.get(playbackId)?.epoch === this.automaticReadEpoch);
  }
  private stopAutomaticReads(): void {
    this.automaticReadEpoch++;
    const cancellations = new Map<string, number>();
    for (const [playbackId, input] of [...this.automaticReads]) {
      // Worker has one read task per session. A newer manual request may already
      // have replaced this automatic preparation, even after UI generations reset.
      if (this.preparingReads.get(input.sessionId) === playbackId) {
        cancellations.set(input.sessionId, Math.max(cancellations.get(input.sessionId) ?? 0, input.generation));
      }
      this.broker.stop(playbackId);
      const state = this.playbacks.get(playbackId);
      if (state?.state === 'preparing') {
        const stopped: SpeechPlaybackState = { ...state, state: 'interrupted', reason: '自动朗读已关闭。' };
        this.rememberPlayback(stopped); this.options.emit({ type: 'playback', ...stopped });
      }
      this.automaticReads.delete(playbackId);
    }
    for (const [sessionId, generation] of cancellations) {
      void this.options.request({ action: 'stopRead', sessionId, generation }).catch(() => undefined);
    }
  }
  async configure(settings?: SpeechSettings): Promise<void> {
    const epoch = ++this.configEpoch;
    const next = settings ?? await this.options.readSettings();
    if (this.closed || epoch !== this.configEpoch) return;
    if (this.settings && (JSON.stringify(this.settings.provider) !== JSON.stringify(next.provider)
      || (this.settings.enabled && !next.enabled))) this.stop({});
    this.settings = next;
    if (!next.autoReadReplies) this.stopAutomaticReads();
    if (!this.settings.enabled) this.broker.stop();
    this.broker.setPolicy({ enabled: this.settings.enabled, recording: this.captures.size > 0, locked: this.locked,
      playback: this.settings.playback });
  }
  installPermissions(window: BrowserWindow): void {
    const allowed = (contents: Electron.WebContents | null, isMainFrame: boolean, requestingUrl?: string) =>
      Boolean(contents && contents === this.options.window()?.webContents && isMainFrame
        && this.captures.size > 0 && (!requestingUrl || requestingUrl === contents.getURL()));
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      permission === 'media' && details.mediaType === 'audio'
      && allowed(contents, details.isMainFrame, details.requestingUrl));
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const audioOnly = 'mediaTypes' in details && Array.isArray(details.mediaTypes)
        && details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio');
      callback(permission === 'media' && audioOnly && allowed(contents, details.isMainFrame, details.requestingUrl));
    });
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!inPlace && mainFrame) { this.beginEpoch++; this.cancelAll(); this.stop({}); }
    });
    window.webContents.on('render-process-gone', () => { this.beginEpoch++; this.cancelAll(); this.stop({}); });
  }
  async begin(input: BeginSpeechCaptureInput): Promise<SpeechCaptureHandle> {
    if (this.closed || this.locked) throw new Error('语音服务已关闭或设备已锁屏。');
    const epoch = ++this.beginEpoch;
    const settings = await this.options.readSettings();
    if (input.purpose === 'conversation' && !settings.enabled) throw new Error('请先测试并启用语音。');
    if (input.sessionId) await this.options.assertSession(input.sessionId);
    if (this.closed || this.locked || epoch !== this.beginEpoch) throw new Error('录音已取消。');
    if (process.platform === 'darwin' && !this.options.e2e) {
      const permission = systemPreferences.getMediaAccessStatus('microphone');
      if (permission === 'denied' || permission === 'restricted') throw new Error('麦克风权限被拒绝，请在系统设置中允许 Jojo 使用麦克风。');
      if (permission !== 'granted' && !(await systemPreferences.askForMediaAccess('microphone'))) throw new Error('麦克风权限未授予。');
    }
    if (this.closed || this.locked || epoch !== this.beginEpoch) throw new Error('录音已取消。');
    const worker = this.options.worker();
    const window = this.options.window();
    if (!worker || !window) throw new Error('语音运行环境尚未就绪。');
    this.cancelAll(); this.stop({});
    const handle = SpeechCaptureHandleSchema.parse({ ...input, captureId: randomUUID(), voiceTurnId: randomUUID() });
    const renderer = new MessageChannelMain(); const runtime = new MessageChannelMain();
    const bridge = new SpeechStreamBridge(handle, renderer.port1, runtime.port1, () => {
      this.options.emit({ type: 'capture', ...handle, state: 'failed', errorCode: 'invalid_audio',
        reason: '录音数据中断或积压，请重新录音。' });
      void this.cancel(handle).catch(() => undefined);
    });
    const timer = setTimeout(() => { void this.cancel(handle).catch(() => undefined); }, settings.provider.asr.id === 'sensevoice' ? 125_000 : 85_000);
    timer.unref?.();
    const capture: Capture = { handle, bridge, port: renderer.port2, runtimePort: runtime.port2, attached: false, timer };
    this.captures.set(handle.captureId, capture);
    try {
      await this.configure(settings);
      if (this.closed || this.locked || epoch !== this.beginEpoch || this.captures.get(handle.captureId) !== capture
        || this.options.worker() !== worker || this.options.window() !== window) throw new Error('录音已取消。');
      worker.postMessage({ type: 'speech.stream.attach', handle }, [runtime.port2]);
      delete capture.runtimePort;
      return handle;
    } catch (error) {
      this.closeCapture(handle.captureId);
      throw error;
    }
  }
  attach(handle: SpeechCaptureHandle): void {
    const capture = this.captures.get(handle.captureId);
    if (!capture || JSON.stringify(capture.handle) !== JSON.stringify(handle) || capture.attached || !capture.port) throw new Error('录音端口已过期。');
    this.options.window()!.webContents.postMessage(IPC.speechCapturePort, handle, [capture.port]);
    capture.attached = true; delete capture.port;
  }
  private closeCapture(id: string): void {
    const capture = this.captures.get(id);
    if (!capture) return;
    clearTimeout(capture.timer); capture.bridge.close(); capture.port?.close(); capture.runtimePort?.close(); this.captures.delete(id);
    void this.configure().catch(() => undefined);
  }
  accept(event: SpeechEvent): void {
    if (event.type === 'capture') {
      const capture = this.captures.get(event.captureId);
      if (!capture || capture.handle.generation !== event.generation || capture.handle.voiceTurnId !== event.voiceTurnId
        || capture.handle.sessionId !== event.sessionId || capture.handle.purpose !== event.purpose) return;
      if (['review', 'failed', 'cancelled'].includes(event.state)) this.closeCapture(event.captureId);
    }
    this.options.emit(SpeechEventSchema.parse(event));
  }
  async cancel(handle: SpeechCaptureHandle): Promise<void> {
    const current = this.captures.get(handle.captureId);
    if (current && JSON.stringify(current.handle) !== JSON.stringify(handle)) throw new Error('录音轮次不匹配。');
    this.closeCapture(handle.captureId);
    await this.options.request({ action: 'cancel', input: handle });
  }
  private cancelAll(): void {
    for (const { handle } of [...this.captures.values()]) void this.cancel(handle).catch(() => undefined);
  }
  async commit(input: CommitVoiceTurnInput) {
    await this.options.assertSession(input.sessionId);
    const result = VoiceCommitResultSchema.parse(await this.options.request({ action: 'commit', input }));
    this.options.emit({ type: 'commit', ...result }); return result;
  }
  async read(input: ReadSpeechMessageInput) {
    const automaticEpoch = this.automaticReadEpoch;
    await this.options.assertSession(input.sessionId);
    const settings = await this.options.readSettings();
    if (!settings.enabled || (input.automatic && (!settings.autoReadReplies || automaticEpoch !== this.automaticReadEpoch))) throw new Error('自动朗读已关闭。');
    const epoch = this.epochs.get(input.sessionId) ?? 0;
    this.epochs.set(input.sessionId, epoch);
    const globalEpoch = this.globalEpoch;
    const playbackId = randomUUID();
    const identity = { sessionId: input.sessionId, messageId: input.messageId, generation: input.generation };
    if (input.automatic) this.automaticReads.set(playbackId, { sessionId: input.sessionId, generation: input.generation, epoch: automaticEpoch });
    const alive = () => !this.closed && globalEpoch === this.globalEpoch && epoch === (this.epochs.get(input.sessionId) ?? 0)
      && (!input.automatic || automaticEpoch === this.automaticReadEpoch);
    this.rememberPlayback({ playbackId, ...identity, state: 'preparing' });
    this.options.emit({ type: 'playback', ...this.playbacks.get(playbackId)! });
    try {
      if (!alive()) throw new Error('朗读已停止。');
      const ready = SpeechReadyAssetSchema.parse(await this.prepareReadAsset(playbackId, { action: 'readMessage', input }));
      if (ready.asset.owner.kind !== 'session' || ready.asset.owner.id !== input.sessionId) throw new Error('语音资产归属不匹配。');
      if (!alive()) throw new Error('朗读已停止。');
      await this.configure(); if (!input.automatic) this.broker.resumeOutput();
      if (!alive() || (input.automatic && !this.automaticReadAllowed(playbackId))) throw new Error('朗读已停止。');
      // A long-running preparation may have been evicted from bounded history.
      // Restore its public identity before Broker emits its synchronous ACKs.
      this.rememberPlayback({ playbackId, ...identity, state: 'preparing', ...(ready.nextOffset !== undefined ? { nextOffset: ready.nextOffset } : {}) });
      this.broker.enqueue({ playbackId, assetId: ready.asset.id, owner: { kind: 'session', id: input.sessionId },
        generation: ++this.playbackGeneration, manual: !input.automatic });
      return { playbackId, generation: input.generation, ...(ready.nextOffset !== undefined ? { nextOffset: ready.nextOffset } : {}) };
    } catch (error) {
      this.automaticReads.delete(playbackId);
      const state: SpeechPlaybackState = { playbackId, ...identity,
        state: alive() ? 'failed' : 'interrupted',
        reason: '朗读未完成，请重试。' };
      this.rememberPlayback(state); this.options.emit({ type: 'playback', ...state }); throw error;
    }
  }
  readApproval(input: ReadApprovalSpeechInput): Promise<{ playbackId: string; generation: number }> {
    const key = JSON.stringify([input.sessionId, input.approvalId]);
    const existing = this.approvalRequests.get(key);
    if (existing) return existing;
    const operation = this.prepareApproval(input);
    this.approvalRequests.set(key, operation);
    // Keep completed identities too: repeated approval snapshots must not speak twice.
    if (this.approvalRequests.size > 100) this.approvalRequests.delete(this.approvalRequests.keys().next().value!);
    return operation;
  }
  private async prepareApproval(input: ReadApprovalSpeechInput): Promise<{ playbackId: string; generation: number }> {
    const globalEpoch = this.globalEpoch, epoch = this.epochs.get(input.sessionId) ?? 0, automaticEpoch = this.automaticReadEpoch;
    const alive = () => !this.closed && globalEpoch === this.globalEpoch && epoch === (this.epochs.get(input.sessionId) ?? 0)
      && automaticEpoch === this.automaticReadEpoch;
    await this.options.assertSession(input.sessionId);
    const settings = await this.options.readSettings();
    if (!alive() || !settings.enabled || !settings.autoReadReplies) throw new Error('自动朗读已关闭或审批已停止。');
    if (await this.options.request({ action: 'approvalPending', input }) !== true || !alive()) throw new Error('审批已结束。');
    const playbackId = randomUUID();
    const identity = { sessionId: input.sessionId, generation: input.generation };
    this.automaticReads.set(playbackId, { ...identity, epoch: automaticEpoch });
    this.rememberPlayback({ playbackId, ...identity, state: 'preparing' });
    this.options.emit({ type: 'playback', ...this.playbacks.get(playbackId)! });
    try {
      if (!alive()) throw new Error('审批朗读已停止。');
      const ready = SpeechReadyAssetSchema.parse(await this.prepareReadAsset(playbackId, { action: 'readApproval', input }));
      if (ready.asset.owner.kind !== 'session' || ready.asset.owner.id !== input.sessionId) throw new Error('语音资产归属不匹配。');
      if (!alive()) throw new Error('审批朗读已停止。');
      await this.configure();
      if (!alive() || !this.settings?.enabled || !this.settings.autoReadReplies) throw new Error('审批朗读已停止。');
      this.approvalBindings.set(playbackId, input);
      this.rememberPlayback({ playbackId, ...identity, state: 'preparing' });
      this.broker.enqueue({ playbackId, assetId: ready.asset.id, owner: ready.asset.owner,
        generation: ++this.playbackGeneration, manual: false });
      return { playbackId, generation: input.generation };
    } catch (error) {
      this.approvalBindings.delete(playbackId);
      this.automaticReads.delete(playbackId);
      const state: SpeechPlaybackState = { playbackId, ...identity, state: alive() ? 'failed' : 'interrupted', reason: '审批提示未播报。' };
      this.rememberPlayback(state); this.options.emit({ type: 'playback', ...state }); throw error;
    }
  }
  async schedulePreparation(input: { scheduleId: string }) {
    return ScheduleVoicePreparationSchema.parse(await this.options.request({ action: 'scheduleVoicePreparation', input }));
  }
  async previewSchedule(input: PreviewScheduleVoiceInput) {
    const epoch = this.globalEpoch;
    const settings = await this.options.readSettings();
    if (!settings.enabled || this.closed || epoch !== this.globalEpoch) throw new Error('请先启用语音。');
    const ready = SpeechReadyAssetSchema.parse(await this.options.request({ action: 'previewSchedule', input }));
    return this.playTestAsset(ready, input.generation, epoch, true);
  }
  async clearCache(): Promise<void> {
    this.beginEpoch++; this.cancelAll(); this.stop({});
    await this.options.request({ action: 'clearCache' });
  }
  async test(input: TestSpeechSettingsInput) {
    const epoch = this.globalEpoch;
    const ready = SpeechReadyAssetSchema.parse(await this.options.request({ action: 'test', input }));
    return this.playTestAsset(ready, input.generation, epoch, false);
  }
  private async playTestAsset(ready: ReturnType<typeof SpeechReadyAssetSchema.parse>, generation: number, epoch: number, requireEnabled: boolean) {
    if (ready.asset.owner.kind !== 'test') throw new Error('试听资产归属不匹配。');
    if (this.closed || epoch !== this.globalEpoch) throw new Error('试听已停止。');
    const playbackId = randomUUID();
    const settings = await this.options.readSettings();
    if (this.closed || epoch !== this.globalEpoch) throw new Error('试听已停止。');
    if (requireEnabled && !settings.enabled) throw new Error('请先启用语音。');
    // An explicit test is permitted while the global switch is still disabled.
    this.broker.setPolicy({ enabled: settings.enabled, recording: this.captures.size > 0, locked: this.locked, playback: settings.playback });
    this.broker.resumeOutput();
    this.rememberPlayback({ playbackId, generation, state: 'queued' });
    this.broker.enqueue({ playbackId, assetId: ready.asset.id, owner: ready.asset.owner, generation: ++this.playbackGeneration, manual: true });
    return { playbackId, generation };
  }
  stop(input: StopSpeechPlaybackInput): void {
    if (input.sessionId) this.epochs.set(input.sessionId, (this.epochs.get(input.sessionId) ?? 0) + 1);
    else this.globalEpoch++;
    if (input.playbackId) this.broker.stop(input.playbackId);
    else if (input.sessionId) {
      for (const state of this.playbacks.values()) if (state.sessionId === input.sessionId) this.broker.stop(state.playbackId);
    }
    else this.broker.stop();
    void this.options.request({ action: 'stopRead', ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}) }).catch(() => undefined);
  }
  async status() {
    const raw = await this.options.request({ action: 'status' });
    const value = raw as { captures: unknown; validation: unknown; diagnostics?: unknown };
    return SpeechStatusSchema.parse({ captures: value.captures, validation: value.validation, diagnostics: value.diagnostics, playbacks: [...this.playbacks.values()] });
  }
  async validateEnabled(settings: SpeechSettings): Promise<void> {
    const raw = await this.options.request({ action: 'status' }) as { validation?: { asr: boolean; tts: boolean }; validationSignature?: string };
    const signature = createHash('sha256').update(JSON.stringify(settings.provider)).digest('hex');
    if (!raw.validation?.asr || !raw.validation.tts || raw.validationSignature !== signature) throw new Error('语音资源与音色尚未验证，请先使用当前配置完成录音转写测试与语音试听。');
  }
  lockedState(locked: boolean): void { this.locked = locked; if (locked) { this.beginEpoch++; this.cancelAll(); this.stop({}); } void this.configure().catch(() => undefined); }
  suspend(): void { this.beginEpoch++; this.cancelAll(); this.stop({}); }
  releaseSession(sessionId: string): void {
    this.stop({ sessionId });
    for (const key of this.approvalRequests.keys()) if ((JSON.parse(key) as string[])[0] === sessionId) this.approvalRequests.delete(key);
    for (const { handle } of [...this.captures.values()]) if (handle.sessionId === sessionId) void this.cancel(handle).catch(() => undefined);
    void this.options.request({ action: 'releaseSession', sessionId }).catch(() => undefined);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.beginEpoch++; this.pendingDeliveries.clear(); this.cancelAll(); this.stop({}); this.broker.close(); this.approvalBindings.clear(); this.approvalRequests.clear(); this.automaticReads.clear(); this.preparingReads.clear();
  }
}

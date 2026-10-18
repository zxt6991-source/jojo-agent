import { isVoiceCaptureContext, sameVoiceCapture, type SidecarEvent, type SpeechSidecarClient, type VoiceCaptureContext } from './sidecar';
import { TurnController, type TurnControllerOptions, type VoiceSessionState } from './turn-controller';
export interface VoiceSessionOptions extends Omit<TurnControllerOptions, 'context'> {
  context: VoiceCaptureContext;
  sidecar: SpeechSidecarClient;
  /** Abort must also release a permission grant that resolves after cancellation. */
  acquireMicrophone(signal: AbortSignal): Promise<void>;
  releaseMicrophone(): void;
  idleTimeoutMs?: number;
}

/** Explicit start is the only microphone entry point. Lock/sleep/device change
 * are injected by the host and always close capture, including muted sessions. */
export class VoiceSession {
  private readonly turn: TurnController;
  private context: VoiceCaptureContext;
  private controller: AbortController | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private sequence = 0;
  private epoch = 0;
  private microphoneEpoch = 0;
  private running = false;
  private active = false;
  private captureReady = false;
  private muted = false;
  private startedBefore = false;
  private opening: { epoch: number; promise: Promise<void> } | undefined;
  private unmuting: { epoch: number; promise: Promise<void> } | undefined;
  private sidecarChain: Promise<void> = Promise.resolve();
  private sidecarContext: VoiceCaptureContext | undefined;
  private resetPending: Promise<void> | undefined;
  constructor(private readonly options: VoiceSessionOptions) {
    if (!isVoiceCaptureContext(options.context)) throw new Error('invalid_voice_capture_context');
    this.context = { ...options.context };
    this.turn = new TurnController({ ...options, context: this.context,
      onEndpoint: (reason) => {
        const context = this.getContext(), epoch = this.epoch;
        void this.options.sidecar.finish(context).catch(() => { if (this.isCurrent(epoch, context)) void this.fail(epoch); });
        options.onEndpoint?.(reason);
      },
      onTurnDiscarded: (context, reason) => {
        // Retain playback/TTS while throwing away candidate ASR. A new capture
        // generation rejects delayed finals from the rejected interruption.
        if (this.running) void this.resetTurn(this.advanceContext()).catch(() => undefined);
        options.onTurnDiscarded?.(context, reason);
      }
    });
    const timeout = options.idleTimeoutMs ?? 120_000;
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 3_600_000) throw new Error('invalid_voice_idle_timeout');
  }
  state(): VoiceSessionState { return this.turn.state(); }
  getContext(): VoiceCaptureContext { return { ...this.context }; }
  start(): Promise<void> {
    if (this.opening?.epoch === this.epoch) return this.opening.promise;
    if (this.running) return Promise.resolve();
    const epoch = ++this.epoch;
    this.running = true; this.muted = false;
    if (this.startedBefore) { this.context = this.advanceContext(); this.turn.reset(this.context); }
    this.startedBefore = true;
    this.turn.stop();
    const context = this.getContext();
    const promise = (async () => {
      try {
        await this.enqueueSidecar(async () => {
          if (!this.isCurrent(epoch)) return;
          this.sidecarContext = context; await this.options.sidecar.open(context);
        });
        if (!this.isCurrent(epoch)) return;
        this.active = true; this.sequence = 0;
        this.unsubscribe = this.options.sidecar.subscribe(event => this.receive(event));
        await this.resetPending;
        if (!this.isCurrent(epoch)) return;
        if (this.muted) this.turn.mute(); else await this.openMicrophone(epoch);
        if (this.isCurrent(epoch)) this.touch();
      } catch (error) {
        if (!this.isCurrent(epoch)) return;
        await this.fail(epoch); throw error;
      }
    })().finally(() => { if (this.opening?.epoch === epoch) this.opening = undefined; });
    this.opening = { epoch, promise };
    return promise;
  }
  async audio(pcm: Uint8Array): Promise<void> {
    if (!this.active || !this.captureReady || this.muted || this.resetPending) return;
    const context = this.getContext(), epoch = this.epoch;
    try { await this.options.sidecar.sendAudio(context, this.sequence++, pcm); }
    catch (error) {
      // A reset intentionally invalidates frames already awaiting their ACK.
      if (!this.isCurrent(epoch, context)) return;
      await this.fail(epoch); throw error;
    }
  }
  mute(): void {
    if (!this.running || this.muted) return;
    this.muted = true; this.captureReady = false; ++this.microphoneEpoch;
    this.controller?.abort(); this.options.releaseMicrophone();
    void this.resetTurn(this.advanceContext()).catch(() => undefined);
    this.turn.mute(); this.touch();
  }
  async unmute(): Promise<void> {
    if (!this.running || !this.muted) return this.unmuting?.promise;
    this.muted = false;
    // Startup owns its microphone acquisition, including a mute/unmute while
    // the operating system permission prompt is still pending.
    if (!this.active) return this.opening?.promise;
    const epoch = this.epoch, microphoneEpoch = this.microphoneEpoch;
    const promise = (async () => {
      try {
        await this.resetPending;
        if (this.isCurrent(epoch) && !this.muted && microphoneEpoch === this.microphoneEpoch) await this.openMicrophone(epoch);
      } catch (error) {
        if (!this.isCurrent(epoch)) return;
        await this.fail(epoch); throw error;
      }
    })().finally(() => { if (this.unmuting?.promise === promise) this.unmuting = undefined; });
    this.unmuting = { epoch, promise };
    return promise;
  }
  async nextTurn(context: VoiceCaptureContext): Promise<void> {
    if (!this.running || !isVoiceCaptureContext(context) || context.voiceSessionId !== this.context.voiceSessionId || context.generation <= this.context.generation) throw new Error('invalid_voice_turn_reset');
    await this.resetTurn(context);
  }
  manualFinish(): void { if (this.captureReady && !this.resetPending) this.turn.manualFinish(); }
  playbackStarted(): void { if (this.active) { this.turn.onPlaybackStarted(); this.touch(); } }
  playbackEnded(): void { if (this.active) { this.turn.onPlaybackEnded(); this.touch(); } }
  async stop(): Promise<void> {
    ++this.epoch; ++this.microphoneEpoch; this.running = false; this.active = false; this.captureReady = false; this.muted = false;
    this.controller?.abort(); this.controller = undefined;
    clearTimeout(this.idleTimer); this.unsubscribe?.(); this.unsubscribe = undefined;
    this.options.releaseMicrophone();
    const closing = this.enqueueSidecar(async () => {
      const context = this.sidecarContext;
      if (!context) return;
      try { await this.options.sidecar.close(context); }
      finally { if (this.sidecarContext === context) this.sidecarContext = undefined; }
    }).catch(() => undefined);
    this.turn.stop();
    await closing;
  }
  onScreenLock(): Promise<void> { return this.stop(); }
  onSleep(): Promise<void> { return this.stop(); }
  onInputDeviceChanged(): Promise<void> { return this.stop(); }
  private async openMicrophone(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch) || this.muted || this.captureReady) return;
    const microphoneEpoch = ++this.microphoneEpoch;
    const controller = new AbortController(); this.controller?.abort(); this.controller = controller;
    try { await this.options.acquireMicrophone(controller.signal); }
    catch (error) {
      if (!this.isCurrent(epoch) || controller.signal.aborted || microphoneEpoch !== this.microphoneEpoch) return;
      throw error;
    }
    if (!this.isCurrent(epoch) || this.muted || controller.signal.aborted || microphoneEpoch !== this.microphoneEpoch) {
      controller.abort();
      // Global release cannot tear down a microphone owned by a newer attempt.
      if (microphoneEpoch === this.microphoneEpoch) this.options.releaseMicrophone();
      return;
    }
    this.captureReady = true; this.turn.start(); this.turn.unmute(); this.touch();
  }
  private advanceContext(): VoiceCaptureContext {
    return { ...this.context, generation: this.context.generation + 1, turnId: crypto.randomUUID() };
  }
  private resetTurn(context: VoiceCaptureContext): Promise<void> {
    const epoch = this.epoch;
    this.context = { ...context }; this.sequence = 0; this.turn.reset(context);
    const pending = this.enqueueSidecar(async () => {
      if (!this.isCurrent(epoch)) return;
      this.sidecarContext = { ...context }; await this.options.sidecar.reset(context);
    })
      .catch(async error => { if (this.isCurrent(epoch, context)) await this.fail(epoch); throw error; })
      .finally(() => { if (this.resetPending === pending) this.resetPending = undefined; });
    this.resetPending = pending; this.touch();
    return pending;
  }
  private enqueueSidecar(action: () => Promise<void>): Promise<void> {
    const next = this.sidecarChain.then(action);
    this.sidecarChain = next.catch(() => undefined);
    return next;
  }
  private isCurrent(epoch: number, context?: VoiceCaptureContext): boolean {
    return epoch === this.epoch && this.running && (!context || sameVoiceCapture(context, this.context));
  }
  private async fail(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch)) return;
    const stopping = this.stop();
    if (this.epoch === epoch + 1 && !this.running) this.turn.fail();
    await stopping;
  }
  private receive(event: SidecarEvent): void {
    if (!this.active) return;
    if (event.type === 'error') {
      if (['voiceSessionId', 'captureId', 'turnId', 'generation'].some(key => event[key as keyof typeof event] !== undefined && event[key as keyof typeof event] !== this.context[key as keyof VoiceCaptureContext])) return;
      void this.fail(this.epoch); return;
    }
    if (this.muted) return;
    if (!('voiceSessionId' in event) || !sameVoiceCapture(event, this.context) || this.resetPending) return;
    switch (event.type) {
      case 'vad.started': this.touch(); this.turn.onVadStarted(); break;
      case 'vad.stopped': this.turn.onVadStopped(); break;
      case 'asr.partial': this.turn.onAsrPartial(event.text); break;
      case 'asr.final': this.turn.onAsrFinal(event.text); break;
      case 'turn.complete': this.turn.onSmartTurnComplete(); break;
      case 'turn.incomplete': this.turn.onSmartTurnIncomplete(); break;
      case 'audio.gap': if (event.turnReset) void this.resetTurn(this.advanceContext()).catch(() => undefined); break;
    }
  }
  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.running) this.idleTimer = setTimeout(() => { void this.stop(); }, this.options.idleTimeoutMs ?? 120_000);
  }
}

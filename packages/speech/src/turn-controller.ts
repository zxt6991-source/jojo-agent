import { classifyInterruption } from './interruption-classifier';
export type VoiceSessionState = 'idle' | 'listening' | 'user_speaking' | 'user_maybe_finished' | 'thinking' | 'assistant_speaking' | 'interruption_candidate' | 'interrupted' | 'muted' | 'error';
export interface VoiceTurnContext { voiceSessionId: string; turnId: string; generation: number }
export interface TurnControllerOptions {
  context: VoiceTurnContext;
  autoEndpointVerified?: boolean;
  /** Explicit evaluation opt-in; does not certify a release/Chinese corpus gate. */
  experimentalAutoEndpoint?: boolean;
  speakerBargeInVerified?: boolean;
  fallbackTimeoutMs?: number;
  onState?(state: VoiceSessionState): void;
  onEndpoint?(reason: 'smart_turn' | 'silence_timeout' | 'manual' | 'interruption'): void;
  onCommit?(text: string, context: VoiceTurnContext): void;
  onDuck?(): void;
  onResume?(): void;
  onInterrupt?(speechGeneration: number): void;
  onSmartTurnRequested?(): void;
  /** The host must discard ASR accumulated for a false/backchannel candidate. */
  onTurnDiscarded?(context: VoiceTurnContext, reason: 'backchannel' | 'false_interruption'): void;
}

/** Host-controlled gates default closed. Does not hold any Agent cancellation
 * callback. Final ASR, not partial subtitles, is the commit boundary. */
export class TurnController {
  private current: VoiceSessionState = 'idle';
  private context: VoiceTurnContext;
  private finalText = '';
  private endpoint = false;
  private committed = false;
  private candidate = false;
  private playbackActive = false;
  private speechGeneration: number;
  private fallback: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: TurnControllerOptions) {
    this.context = { ...options.context }; this.speechGeneration = options.context.generation;
    if (!Number.isSafeInteger(options.context.generation) || options.context.generation < 0) throw new Error('invalid_voice_generation');
    const timeout = options.fallbackTimeoutMs ?? 3000;
    if (!Number.isFinite(timeout) || timeout < 200 || timeout > 30_000) throw new Error('invalid_endpoint_timeout');
  }
  state(): VoiceSessionState { return this.current; }
  getContext(): VoiceTurnContext { return { ...this.context }; }
  start(): void { if (this.current === 'idle' || this.current === 'error') this.setState('listening'); }
  reset(context: VoiceTurnContext): void {
    if (!Number.isSafeInteger(context.generation) || context.voiceSessionId !== this.context.voiceSessionId || context.generation <= this.context.generation) throw new Error('stale_voice_generation');
    this.clearTimer(); this.context = { ...context }; this.finalText = ''; this.endpoint = false; this.committed = false; this.candidate = false;
    this.speechGeneration = Math.max(this.speechGeneration, context.generation);
    if (this.current !== 'muted') this.setState(this.playbackActive ? 'assistant_speaking' : 'listening');
  }
  accepts(context: VoiceTurnContext): boolean { return context.voiceSessionId === this.context.voiceSessionId && context.turnId === this.context.turnId && context.generation === this.context.generation; }
  onVadStarted(): void {
    if (['idle', 'muted', 'error'].includes(this.current) || this.endpoint || this.committed) return;
    this.clearTimer();
    if (this.current === 'assistant_speaking' || this.candidate) {
      if (!this.options.speakerBargeInVerified) return;
      if (!this.candidate) { this.candidate = true; this.options.onDuck?.(); }
      this.setState('interruption_candidate'); return;
    }
    if (this.current !== 'thinking') this.setState('user_speaking');
  }
  onVadStopped(): void {
    if (this.candidate) {
      this.clearTimer();
      this.fallback = setTimeout(() => this.resolveCandidate('', true), this.options.fallbackTimeoutMs ?? 3000); return;
    }
    if (this.current !== 'user_speaking' || this.endpoint || this.committed) return;
    this.setState('user_maybe_finished');
    if (this.automaticEndpointEnabled()) {
      this.options.onSmartTurnRequested?.();
      this.armEndpointFallback();
    }
  }
  onAsrPartial(text: string): void { if (this.candidate) this.resolveCandidate(text, false); }
  onAsrFinal(text: string): void {
    if (['idle', 'muted', 'error'].includes(this.current) || this.committed) return;
    const context = this.context;
    if (this.candidate) { this.resolveCandidate(text, true); if (!this.endpoint || context !== this.context) return; }
    else if (this.playbackActive) return;
    // A duplicate decoder final cannot replace the first accepted utterance.
    if (!this.finalText) this.finalText = text.trim();
    this.tryCommit();
  }
  onSmartTurnComplete(): void { if (this.automaticEndpointEnabled() && this.current === 'user_maybe_finished') this.complete('smart_turn'); }
  onSmartTurnIncomplete(): void { if (this.current === 'user_maybe_finished') this.armEndpointFallback(); }
  manualFinish(): void { if (['user_speaking', 'user_maybe_finished', 'listening', 'interrupted'].includes(this.current)) this.complete('manual'); }
  onPlaybackStarted(): void {
    if (['idle', 'error'].includes(this.current)) return;
    this.playbackActive = true;
    if (this.current !== 'muted' && !this.candidate) this.setState('assistant_speaking');
  }
  onPlaybackPaused(): void { /* Pausing does not establish an interruption. */ }
  onPlaybackEnded(): void {
    this.playbackActive = false;
    if (!this.candidate && this.current === 'assistant_speaking') this.setState('listening');
  }
  mute(): void { this.clearTimer(); this.candidate = false; this.setState('muted'); }
  unmute(): void { if (this.current === 'muted') this.setState(this.playbackActive ? 'assistant_speaking' : 'listening'); }
  stop(): void { this.clearTimer(); this.candidate = false; this.playbackActive = false; this.setState('idle'); }
  fail(): void { this.clearTimer(); this.candidate = false; this.playbackActive = false; this.setState('error'); }
  private complete(reason: 'smart_turn' | 'silence_timeout' | 'manual' | 'interruption'): void {
    if (this.endpoint || this.committed) return;
    this.clearTimer(); this.endpoint = true;
    // Fence reentrant VAD and repeated endpoint decisions while awaiting final.
    this.setState('thinking'); this.options.onEndpoint?.(reason); this.tryCommit();
  }
  private tryCommit(): void {
    if (!this.endpoint || !this.finalText || this.committed) return;
    this.committed = true; this.setState('thinking'); this.options.onCommit?.(this.finalText, { ...this.context });
  }
  private resolveCandidate(text: string, final: boolean): void {
    const decision = classifyInterruption(text, final);
    if (decision === 'pending') return;
    this.clearTimer(); this.candidate = false;
    if (decision === 'true') {
      this.playbackActive = false; this.options.onInterrupt?.(++this.speechGeneration); this.setState('interrupted');
      // A final interruption is already a completed user utterance. A partial
      // interruption keeps listening until VAD/Smart Turn establishes its end.
      if (final) this.complete('interruption'); else this.setState('user_speaking');
    } else {
      this.finalText = '';
      this.options.onResume?.(); this.setState(this.playbackActive ? 'assistant_speaking' : 'listening');
      this.options.onTurnDiscarded?.({ ...this.context }, decision === 'backchannel' ? 'backchannel' : 'false_interruption');
    }
  }
  private armEndpointFallback(): void {
    this.clearTimer(); if (!this.automaticEndpointEnabled()) return;
    this.fallback = setTimeout(() => { if (this.current === 'user_maybe_finished') this.complete('silence_timeout'); }, this.options.fallbackTimeoutMs ?? 3000);
  }
  private automaticEndpointEnabled(): boolean { return Boolean(this.options.autoEndpointVerified || this.options.experimentalAutoEndpoint); }
  private clearTimer(): void { clearTimeout(this.fallback); this.fallback = undefined; }
  private setState(state: VoiceSessionState): void { if (state !== this.current) { this.current = state; this.options.onState?.(state); } }
}

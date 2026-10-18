import type { SpeechCaptureHandle, SpeechCaptureState, SpeechEvent } from '@desktop-agent/contracts';
import type { CaptureFailure } from '../audio/capture-failure';

export type ContinuousVoiceState = 'off' | 'listening' | 'recovering' | 'review' | 'waiting' | 'muted';
interface Options {
  startCapture(): Promise<void>;
  cancelCapture(): void;
  stopPlayback(): void;
  canStart(): boolean;
  autoRead(): boolean;
  onState(state: ContinuousVoiceState): void;
  onNotice(message: string): void;
  idleTimeoutMs?: number;
  settleMs?: number;
}
type DeferredEvent = Extract<SpeechEvent, { type: 'session_run_finished' | 'reply' | 'playback' }>;
type CaptureIdentity = Pick<SpeechCaptureState, 'voiceTurnId' | 'generation'>;

/** Half duplex until the physical AEC gate passes. Capture consent, Run identity
 * and the matching speech chain each have their own lifetime. */
export class ContinuousVoiceSession {
  private current: ContinuousVoiceState = 'off';
  private epoch = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private settle: ReturnType<typeof setTimeout> | undefined;
  private speechDeadline: ReturnType<typeof setTimeout> | undefined;
  private recovery: ReturnType<typeof setTimeout> | undefined;
  private recoveryAttempts = 0;
  private activeCapture: SpeechCaptureHandle | undefined;
  private capture: CaptureIdentity | undefined;
  private runId: string | undefined;
  private runFinished = false;
  private readonly deferred: DeferredEvent[] = [];
  private readonly messages = new Set<string>();
  private readonly reads = new Map<string, 'awaiting' | 'active' | 'complete'>();
  private readonly playbacks = new Set<string>();
  constructor(private readonly options: Options) {}
  state(): ContinuousVoiceState { return this.current; }
  start(): void {
    if (this.current !== 'off') return;
    if (!this.options.canStart()) { this.options.onNotice('请先启用语音，并完成当前任务或草稿。'); return; }
    this.recoveryAttempts = 0;
    this.options.onNotice('');
    this.openCapture();
  }
  stop(): void {
    ++this.epoch; this.clearTimers(); this.clearTurn();
    const wasActive = this.current !== 'off'; this.setState('off');
    if (wasActive) { this.options.cancelCapture(); this.options.stopPlayback(); }
  }
  mute(): void {
    if (this.current === 'off' || this.current === 'muted') return;
    ++this.epoch; this.clearTimers(); this.clearTurn();
    this.setState('muted'); this.options.cancelCapture(); this.options.stopPlayback(); this.touch();
  }
  resume(): void {
    if (this.current !== 'muted') return;
    if (!this.options.canStart()) { this.options.onNotice('请先完成当前任务或发送转写草稿，再恢复收音。'); return; }
    this.recoveryAttempts = 0;
    this.options.onNotice('');
    this.openCapture();
  }
  captureStarted(handle: SpeechCaptureHandle): void {
    if (this.current !== 'listening' && this.current !== 'recovering') return;
    if (this.current === 'recovering') {
      // A user can explicitly start a capture during the retry delay. That
      // capture owns this turn; a delayed automatic retry must not replace it.
      ++this.epoch; clearTimeout(this.recovery); this.clearTurn(); this.setState('listening'); this.touch();
      this.options.onNotice('');
    }
    this.activeCapture = { ...handle };
  }
  finalReceived(capture: CaptureIdentity): void {
    if (this.current !== 'listening') return;
    if (!this.activeCapture || capture.voiceTurnId !== this.activeCapture.voiceTurnId || capture.generation !== this.activeCapture.generation) return;
    this.recoveryAttempts = 0;
    this.capture = { ...capture };
    clearTimeout(this.settle); this.setState('review'); this.touch();
  }
  runStarted(runId: string): void {
    // A global Agent event cannot establish which Run belongs to this capture.
    if (this.current !== 'waiting' || this.runId !== runId) return;
    this.touch();
  }
  runEnded(runId: string, success: boolean): void {
    if (this.current === 'review' && this.capture && !this.runId) {
      this.cache({ type: 'session_run_finished', runId, sessionId: '', outcome: success ? 'completed' : 'failed' });
      return;
    }
    if (this.current !== 'waiting' || this.runId !== runId) return;
    if (!success) { this.stop(); this.options.onNotice('本轮任务已结束；需要时重新开始连续对话。'); return; }
    this.runFinished = true; this.schedule();
  }
  speech(event: SpeechEvent): void {
    if (event.type === 'input_invalidated') { this.stop(); return; }
    if (this.current === 'off' || this.current === 'muted' || this.current === 'listening' || this.current === 'recovering') return;
    if (event.type === 'commit') {
      if (event.status !== 'committed' || !event.runId || !this.capture || event.voiceTurnId !== this.capture.voiceTurnId || event.generation !== this.capture.generation) return;
      if (this.runId) return; // A duplicate receipt cannot rewind a completed Run.
      this.runId = event.runId; this.setState('waiting'); this.touch();
      const pending = this.deferred.splice(0);
      // preparing may reach this listener before the reply receipt. Establish
      // all matching message identities before replaying the original order.
      for (const item of pending) if (item.type === 'reply' && item.runId === this.runId) this.messages.add(item.messageId);
      for (const item of pending) {
        if (this.current !== 'waiting') break;
        this.accept(item);
      }
      this.schedule(); return;
    }
    if (event.type !== 'session_run_finished' && event.type !== 'reply' && event.type !== 'playback') return;
    if (!this.runId) { if (this.current === 'review') this.cache(event); return; }
    this.accept(event);
  }
  captureFailed(failure?: CaptureFailure): void {
    if (this.current !== 'listening') return;
    if (failure?.handle && (!this.activeCapture || failure.handle.captureId !== this.activeCapture.captureId
      || failure.handle.voiceTurnId !== this.activeCapture.voiceTurnId || failure.handle.generation !== this.activeCapture.generation)) return;
    const recoverable = !!failure?.handle && (failure.code === 'invalid_audio' || failure.code === 'empty_result');
    if (!recoverable) {
      this.stop(); if (failure) this.options.onNotice(failure.message); return;
    }
    if (this.recoveryAttempts >= 2) {
      this.mute(); this.options.onNotice('连续重录仍未成功，已静音。点击“恢复收音”后可重试。'); return;
    }
    this.recoveryAttempts++;
    const epoch = ++this.epoch;
    clearTimeout(this.settle); clearTimeout(this.speechDeadline); this.clearTurn();
    this.setState('recovering'); this.options.cancelCapture();
    this.options.onNotice(failure.code === 'empty_result' ? '本轮没有识别到有效语音，即将重新收音。' : '本轮录音中断，已丢弃不完整语音，即将重新收音。');
    // Preserve the original idle deadline. Silence and repeated failures cannot
    // keep a microphone session alive indefinitely, nor commit a partial draft.
    this.recovery = setTimeout(() => {
      if (epoch !== this.epoch || this.current !== 'recovering') return;
      if (!this.options.canStart()) { this.stop(); this.options.onNotice('已有新的任务或草稿，连续对话已停止。'); return; }
      this.openCapture(true);
    }, 1000);
  }
  private accept(event: DeferredEvent): void {
    if (event.type === 'session_run_finished') { this.runEnded(event.runId, event.outcome === 'completed'); return; }
    if (event.type === 'reply') {
      if (event.runId !== this.runId) return;
      this.messages.add(event.messageId);
      const waiting = this.deferred.splice(0);
      for (const item of waiting) {
        if (item.type === 'playback' && item.messageId === event.messageId) this.accept(item);
        else this.cache(item);
      }
      if (event.requestedReadAloud || this.options.autoRead()) {
        if (!this.reads.has(event.messageId)) this.reads.set(event.messageId, 'awaiting');
        clearTimeout(this.settle); this.updateSpeechDeadline();
      }
      this.schedule(); return;
    }
    if (event.playbackId !== this.runId && (!event.messageId || !this.messages.has(event.messageId))) {
      // Legacy preparing may be emitted by another listener before reply.
      if (event.messageId) this.cache(event);
      return;
    }
    if (['preparing', 'queued', 'playing'].includes(event.state)) {
      this.playbacks.add(event.playbackId);
      if (event.messageId) this.reads.set(event.messageId, 'active');
      clearTimeout(this.settle);
    } else {
      this.playbacks.delete(event.playbackId);
      if (event.messageId) this.reads.set(event.messageId, event.state === 'played' && event.nextOffset !== undefined ? 'awaiting' : 'complete');
    }
    this.updateSpeechDeadline(); this.schedule();
  }
  private cache(event: DeferredEvent): void {
    this.deferred.push(event);
    if (this.deferred.length > 128) this.deferred.shift();
  }
  private clearTurn(): void {
    this.activeCapture = undefined;
    this.capture = undefined; this.runId = undefined; this.runFinished = false;
    this.deferred.length = 0; this.messages.clear(); this.reads.clear(); this.playbacks.clear();
  }
  private openCapture(preserveIdle = false): void {
    if (preserveIdle) { clearTimeout(this.settle); clearTimeout(this.speechDeadline); clearTimeout(this.recovery); }
    else this.clearTimers();
    this.clearTurn();
    const epoch = ++this.epoch;
    this.setState('listening'); if (!preserveIdle) this.touch();
    void this.options.startCapture().then(() => {
      if (preserveIdle && epoch === this.epoch && this.current === 'listening') this.options.onNotice('请再说一遍。');
    }, () => { if (epoch === this.epoch) this.captureFailed(); });
  }
  private awaitingRead(): boolean { return [...this.reads.values()].includes('awaiting'); }
  private updateSpeechDeadline(): void {
    clearTimeout(this.speechDeadline);
    if (this.awaitingRead()) this.speechDeadline = setTimeout(() => {
      this.stop(); this.options.onNotice('后续朗读未能开始，连续对话已停止。');
    }, 35_000);
  }
  private schedule(): void {
    clearTimeout(this.settle);
    if (this.current !== 'waiting' || !this.runFinished || this.awaitingRead() || this.playbacks.size) return;
    // Matching legacy reply and playback receipts cross independent listeners.
    this.settle = setTimeout(() => {
      if (this.current !== 'waiting' || !this.runFinished || this.awaitingRead() || this.playbacks.size) return;
      if (!this.options.canStart()) { this.stop(); this.options.onNotice('已有新的任务或草稿，连续对话已停止。'); return; }
      this.openCapture();
    }, this.options.settleMs ?? 500);
  }
  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      // Preparing/playing a complete reading or waiting for its Run is activity.
      if (this.current === 'waiting') { this.touch(); return; }
      this.stop(); this.options.onNotice('连续对话已因空闲超时结束。');
    }, this.options.idleTimeoutMs ?? 120_000);
  }
  private clearTimers(): void { clearTimeout(this.idle); clearTimeout(this.settle); clearTimeout(this.speechDeadline); clearTimeout(this.recovery); }
  private setState(state: ContinuousVoiceState): void { this.current = state; this.options.onState(state); }
}

import captureWorkletUrl from '../audio/pcm-capture.worklet.ts?worker&url';
import playbackWorkletUrl from './playback-worklet.ts?worker&url';
import { CaptureChannel } from '../audio/capture-channel';
import type { SpeechCaptureHandle, SpeechErrorCode } from '@desktop-agent/contracts';
import { evaluateSpeakerBargeInGate, type AecTopology, type AecValidationReport } from './aec-gate';
import type { PlaybackCommand, PlaybackCursor, PlaybackEvent, PlaybackFlushOptions, PlaybackReference, VoicePcmChunk } from './types';

export interface VoiceAudioGraphOptions {
  capacityMs?: number;
  onCaptureUpdate?: (update: { durationMs: number; rms: number }) => void;
  onCaptureStopped?: () => void;
  onCursor?: (cursor: PlaybackCursor) => void;
  onSegmentPlayed?: (segmentId: string, generation: number) => void;
  /** Disabled unless a caller explicitly subscribes; no microphone audio is retained here. */
  onReference?: (reference: PlaybackReference) => void;
  onError?: (message: string, code?: SpeechErrorCode) => void;
}

interface ActiveCapture {
  token: number;
  channel: CaptureChannel;
  stream?: MediaStream;
  worklet?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode;
  removeAbort: () => void;
  stopResolve?: () => void;
  stopTimer?: ReturnType<typeof setTimeout>;
}

/** Owns microphone + PCM playback in one renderer and one AudioContext.
 * Existing AudioHost asset playback remains the production fallback.
 */
export class VoiceAudioGraph {
  private context: AudioContext | undefined;
  private playback: AudioWorkletNode | undefined;
  private initialization: Promise<void> | undefined;
  private closed = false;
  private capture: ActiveCapture | undefined;
  private captureToken = 0;
  private generation = 0;
  private requestId = 0;
  private pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private currentCursor: PlaybackCursor = { generation: 0, playedFrames: 0, playedMs: 0, segmentPlayedFrames: 0, bufferedFrames: 0, sampleRate: 48_000, state: 'idle' };

  constructor(private readonly options: VoiceAudioGraphOptions = {}) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error('voice_audio_graph_closed');
    this.initialization ??= this.initialize();
    await this.initialization;
    if (this.closed) throw new Error('voice_audio_graph_closed');
    await this.context!.resume();
  }

  async startCapture(handle: SpeechCaptureHandle, port: MessagePort, signal: AbortSignal, inputDeviceId?: string): Promise<void> {
    if (this.capture) { port.close(); throw new Error('voice_capture_already_active'); }
    if (this.closed || signal.aborted) { port.close(); return; }
    const token = ++this.captureToken;
    const abort = () => this.releaseCapture(token, true);
    const active: ActiveCapture = { token, channel: new CaptureChannel(handle, port, (message, code) => {
      this.releaseCapture(token, true); this.options.onError?.(message, code);
    }), removeAbort: () => signal.removeEventListener('abort', abort) };
    this.capture = active;
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.start();
      if (this.capture?.token !== token || signal.aborted) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}), channelCount: { ideal: 1 },
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }, video: false });
      if (this.capture?.token !== token || signal.aborted || this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
      active.stream = stream;
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (this.capture?.token !== token) return;
        this.releaseCapture(token, true); this.options.onError?.('麦克风设备已断开，请重新录音。');
      }, { once: true });
      active.worklet = new AudioWorkletNode(this.context!, 'jojo-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      active.worklet.port.onmessage = (event: MessageEvent) => {
        if (this.capture?.token !== token) return;
        const value = event.data as { type: string; bytes?: Uint8Array; durationMs?: number; rms?: number };
        if (value.type === 'pcm' && value.bytes instanceof Uint8Array) active.channel.send(value.bytes);
        else if (value.type === 'level') this.options.onCaptureUpdate?.({ durationMs: value.durationMs ?? 0, rms: value.rms ?? 0 });
        else if (value.type === 'stopped') {
          active.channel.end(); this.options.onCaptureUpdate?.({ durationMs: value.durationMs ?? 0, rms: 0 });
          // CaptureChannel still owns end/ACK draining after the microphone is released.
          this.releaseCapture(token, false); this.options.onCaptureStopped?.();
        }
      };
      active.source = this.context!.createMediaStreamSource(stream);
      active.source.connect(active.worklet); active.worklet.connect(this.context!.destination);
      active.worklet.port.postMessage({ type: 'start' });
    } catch (cause) { this.releaseCapture(token, true); if (!signal.aborted && !this.closed) throw cause; }
  }

  /** Drain the capture resampler and packets before ending; leave playback/context alive. */
  async stopCapture(): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    if (!capture.worklet) { this.releaseCapture(capture.token, true); return; }
    if (capture.stopResolve) throw new Error('voice_capture_stopping');
    await new Promise<void>(resolve => {
      capture.stopResolve = resolve;
      capture.stopTimer = setTimeout(() => { this.releaseCapture(capture.token, true); this.options.onError?.('录音停止超时，请重新录音。'); }, 1_000);
      capture.worklet!.port.postMessage({ type: 'stop' });
    });
  }

  setGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < this.generation) throw new Error('stale_playback_generation');
    if (generation === this.generation) return;
    this.rejectPending('stale_playback_generation'); this.generation = generation;
    this.currentCursor = { ...this.currentCursor, generation, playedFrames: 0, playedMs: 0, segmentPlayedFrames: 0, bufferedFrames: 0, state: 'idle' };
    delete this.currentCursor.segmentId;
    this.send({ type: 'generation', generation });
  }

  async enqueuePcm(chunk: VoicePcmChunk): Promise<void> {
    await this.start();
    if (chunk.generation !== this.generation) throw new Error('stale_playback_generation');
    if (this.pending.size >= 8) throw new Error('playback_ack_window_full');
    const requestId = ++this.requestId;
    // Retain caller ownership while transferring a compact buffer to the audio thread.
    const bytes = chunk.bytes.slice();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('playback_ack_timeout')); }, 2_000);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.playback!.port.postMessage({ type: 'enqueue', requestId, chunk: { ...chunk, bytes } } satisfies PlaybackCommand, [bytes.buffer]); }
      catch (cause) { clearTimeout(timer); this.pending.delete(requestId); reject(cause instanceof Error ? cause : new Error('playback_send_failed')); }
    });
  }

  duck(reason: string): void { this.send({ type: 'duck', gain: 0.15, reason }); }
  pause(reason: string): void { this.send({ type: 'pause', reason }); }
  resume(): void { this.send({ type: 'resume' }); }
  setVolume(gain: number): void { this.send({ type: 'volume', gain }); }
  cancelCapture(): void { if (this.capture) this.releaseCapture(this.capture.token, true); }
  flush(options: PlaybackFlushOptions = {}): void { this.send({ type: 'flush', options }); }
  cursor(): PlaybackCursor { return { ...this.currentCursor }; }
  get bufferedMs(): number { return this.currentCursor.bufferedFrames / this.currentCursor.sampleRate * 1_000; }

  speakerBargeInGate(environmentKey: string, report?: AecValidationReport): ReturnType<typeof evaluateSpeakerBargeInGate> {
    const settings = this.capture?.stream?.getAudioTracks()[0]?.getSettings();
    const topology: AecTopology = { environmentKey, ownership: 'same-context', echoCancellation: settings?.echoCancellation === true };
    return evaluateSpeakerBargeInGate(topology, report);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.capture) this.releaseCapture(this.capture.token, true);
    this.rejectPending('voice_audio_graph_closed');
    this.send({ type: 'stop' }); this.playback?.disconnect();
    if (this.playback) { this.playback.port.onmessage = null; this.playback.port.close(); }
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }

  private async initialize(): Promise<void> {
    const context = new AudioContext({ latencyHint: 'interactive' }); this.context = context;
    try {
      await Promise.all([
        context.audioWorklet.addModule(new URL(captureWorkletUrl, window.location.href).href),
        context.audioWorklet.addModule(new URL(playbackWorkletUrl, window.location.href).href)
      ]);
      if (this.closed) return;
      this.playback = new AudioWorkletNode(context, 'jojo-realtime-playback', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { ...(this.options.capacityMs !== undefined ? { capacityMs: this.options.capacityMs } : {}) }
      });
      this.playback.port.onmessage = (event: MessageEvent<PlaybackEvent>) => this.receive(event.data);
      this.playback.connect(context.destination);
      this.currentCursor = { ...this.currentCursor, sampleRate: context.sampleRate };
      this.send({ type: 'generation', generation: this.generation });
      this.send({ type: 'reference', enabled: Boolean(this.options.onReference) });
    } catch (cause) { await this.close(); throw cause; }
  }

  private receive(event: PlaybackEvent): void {
    if (this.closed) return;
    if (event.type === 'enqueued' || event.type === 'rejected') {
      const pending = this.pending.get(event.requestId);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(event.requestId);
      if (event.type === 'rejected') pending.reject(new Error(event.reason)); else pending.resolve();
    }
    if (event.type === 'reference') { if (event.reference.generation === this.generation) this.options.onReference?.(event.reference); return; }
    if ('cursor' in event && event.cursor.generation === this.generation) { this.currentCursor = event.cursor; this.options.onCursor?.(this.cursor()); }
    if (event.type === 'segment-played' && event.generation === this.generation) this.options.onSegmentPlayed?.(event.segmentId, event.generation);
  }

  private send(command: PlaybackCommand): void { this.playback?.port.postMessage(command); }
  private rejectPending(reason: string): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); } this.pending.clear(); }
  private releaseCapture(token: number, cancel: boolean): void {
    const capture = this.capture;
    if (capture?.token !== token) return;
    this.capture = undefined; capture.removeAbort();
    if (capture.stopTimer) clearTimeout(capture.stopTimer);
    if (cancel) { capture.worklet?.port.postMessage({ type: 'cancel' }); capture.channel.close(); }
    capture.stream?.getTracks().forEach(track => track.stop());
    capture.source?.disconnect(); capture.worklet?.disconnect();
    if (capture.worklet) { capture.worklet.port.onmessage = null; capture.worklet.port.close(); }
    capture.stopResolve?.();
  }
}

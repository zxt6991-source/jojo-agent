import { VoiceOutputAckSchema, type AgentEvent, type SpeechEvent, type VoiceOutputHandle } from '@desktop-agent/contracts';
import { CodingProgressNarrator, VoiceChunkScheduler, VoiceDeliveryLedger, VoiceTextProjector,
  type TtsSession, type VoiceLatencyRecorder } from '@desktop-agent/speech';
import type { PcmAudioPort } from './pcm-upload-stream';

interface Output {
  handle: VoiceOutputHandle; projector: VoiceTextProjector; scheduler: VoiceChunkScheduler; narrator: CodingProgressNarrator;
  timer: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval>; port?: PcmAudioPort; tts?: TtsSession;
  pendingAck?: { sequence: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  bufferedMs: number; count: number; inFlight: number; final: boolean; finishing: boolean; audioEnded: boolean;
  completedSegments: Set<string>; playedSegments: Set<string>; closed: boolean; pumping: boolean;
  traceId: string; messageId?: string;
  firstDeltaAt?: number;
}
export interface DesktopVoiceOutputOptions {
  open(handle: VoiceOutputHandle): Promise<TtsSession>;
  emit(event: SpeechEvent): void;
  ledger: VoiceDeliveryLedger;
  latency?: VoiceLatencyRecorder;
}

/** Dedicated output ports are bound to registered runs. Cancelling this class
 * has no reference to a Run's AbortController and cannot cancel a tool. */
export class DesktopVoiceOutput {
  private readonly outputs = new Map<string, Output>();
  constructor(private readonly options: DesktopVoiceOutputOptions) {}
  begin(handle: VoiceOutputHandle, traceId = handle.runId): void {
    this.stop(handle.sessionId);
    const output: Output = { handle, projector: new VoiceTextProjector(), scheduler: new VoiceChunkScheduler(), narrator: new CodingProgressNarrator(),
      timer: setTimeout(() => this.close(output, 'interrupted'), 10_000), bufferedMs: 0, count: 0, inFlight: 0, final: false, finishing: false,
      audioEnded: false, completedSegments: new Set(), playedSegments: new Set(), closed: false, pumping: false, traceId };
    this.outputs.set(handle.runId, output);
    this.options.latency?.begin({ captureId: traceId, generation: handle.generation });
    this.options.emit({ type: 'output_available', ...handle });
  }
  event(runId: string, event: AgentEvent): void {
    const output = this.outputs.get(runId);
    if (!output || output.closed || output.final) return;
    try {
      if (event.type === 'turn.started') this.mark(output, 'run_started');
      if (event.type === 'text.delta') {
        output.firstDeltaAt ??= performance.now();
        output.scheduler.start(output.firstDeltaAt);
        this.mark(output, 'llm_first_token');
        const phrases = output.projector.append(event.text);
        if (phrases.length) this.mark(output, 'first_speakable');
        output.scheduler.append(phrases, performance.now());
      } else {
        const progress = output.narrator.onEvent(event, performance.now());
        if (progress && output.scheduler.queued === 0 && output.inFlight === 0) output.scheduler.append([{ text: progress, sourceTextRange: { start: 0, end: 0 } }], performance.now());
      }
      void this.pump(output);
    } catch { this.close(output, 'failed'); }
  }
  finish(runId: string, messageId: string | undefined, success: boolean): void {
    const output = this.outputs.get(runId);
    this.options.ledger.reconcile(runId, messageId, success);
    if (!output) return;
    if (!success) { this.close(output, 'failed'); return; }
    output.final = true;
    if (messageId) output.messageId = messageId;
    this.mark(output, 'assistant_final_commit');
    try { output.scheduler.append(output.projector.finish(), performance.now()); void this.pump(output); }
    catch { this.close(output, 'failed'); }
  }
  attach(handle: VoiceOutputHandle, port: PcmAudioPort): void {
    const output = this.outputs.get(handle.runId);
    if (!output || output.closed || output.port || output.handle.sessionId !== handle.sessionId || output.handle.generation !== handle.generation) { port.close(); return; }
    clearTimeout(output.timer); output.port = port;
    // A bounded overall lifetime also covers a hung provider or lost playback ACK.
    output.timer = setTimeout(() => this.close(output, 'failed'), 300_000);
    port.on('message', event => this.ack(output, event));
    port.on('close', () => { if (!output.closed) this.close(output, 'interrupted'); });
    port.start?.();
    void this.options.open(handle).then(tts => {
      if (output.closed) { void tts.cancel(); return; }
      output.tts = tts;
      output.tick = setInterval(() => { void this.pump(output); }, 100);
      void this.consume(output, tts); void this.pump(output);
    }, () => this.close(output, 'failed'));
  }
  private async pump(output: Output): Promise<void> {
    if (!output.tts || output.closed || output.pumping || output.finishing) return;
    output.pumping = true;
    try {
      if (output.count === 0 && !output.scheduler.queued && output.firstDeltaAt !== undefined && performance.now() - output.firstDeltaAt >= 400) {
        const phrases = output.projector.flushWeakBoundary();
        if (phrases.length) this.mark(output, 'first_speakable');
        output.scheduler.append(phrases, performance.now());
      }
      if (output.inFlight < 2) {
        const phrase = output.scheduler.take(performance.now(), output.bufferedMs + output.tts.bufferedAudioMs, false)
          ?? (output.final && output.bufferedMs < 500 ? output.scheduler.take(performance.now(), output.bufferedMs, true) : undefined);
        if (phrase) {
          const id = crypto.randomUUID(); output.count++;
          this.options.ledger.queue({ id, voiceSessionId: output.handle.sessionId, turnId: output.handle.runId, runId: output.handle.runId,
            generation: output.handle.generation, spokenText: phrase.text, sourceTextRange: phrase.sourceTextRange,
            ...(output.messageId ? { messageId: output.messageId } : {}) });
          this.options.ledger.transition(id, output.handle.generation, 'synthesizing');
          output.inFlight++; this.mark(output, 'tts_start');
          await output.tts.append(phrase.text, { segmentId: id, endSegment: true });
        }
      }
      if (output.final && !output.scheduler.queued && !output.finishing) {
        output.finishing = true;
        void output.tts.finish().catch(() => this.close(output, 'failed'));
      }
    } catch { this.close(output, 'failed'); }
    finally { output.pumping = false; }
  }
  private async consume(output: Output, tts: TtsSession): Promise<void> {
    try {
      for await (const chunk of tts.audio()) {
        if (output.closed) return;
        const ledger = this.options.ledger;
        ledger.transition(chunk.segmentId, output.handle.generation, 'ready');
        ledger.transition(chunk.segmentId, output.handle.generation, 'playing');
        this.mark(output, 'tts_first_pcm');
        if (chunk.final) output.completedSegments.add(chunk.segmentId);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('voice_output_ack_timeout')), 5000);
          output.pendingAck = { sequence: chunk.sequence, resolve, reject, timer };
          output.port!.postMessage({ type: 'pcm', ...output.handle, segmentId: chunk.segmentId, sequence: chunk.sequence,
            pcm: chunk.pcm, sampleRate: chunk.sampleRate, ...(chunk.segmentFrames === undefined ? {} : { segmentFrames: chunk.segmentFrames }), final: chunk.final });
        });
        if (chunk.final) output.inFlight--;
        void this.pump(output);
      }
      if (output.closed) return;
      output.audioEnded = true;
      output.port!.postMessage({ type: 'finished', ...output.handle });
      this.maybeComplete(output);
    } catch { if (!output.closed) this.close(output, 'failed'); }
  }
  private ack(output: Output, event: unknown): void {
    if (output.closed) return;
    const raw = event && typeof event === 'object' && 'data' in event ? event.data : event;
    const parsed = VoiceOutputAckSchema.safeParse(raw);
    if (!parsed.success || parsed.data.generation !== output.handle.generation) { this.close(output, 'failed'); return; }
    const ack = parsed.data;
    if (ack.type === 'cancel') { this.close(output, 'interrupted'); return; }
    if (ack.type === 'consumed') {
      const pending = output.pendingAck;
      if (!pending || pending.sequence !== ack.sequence) { this.close(output, 'failed'); return; }
      clearTimeout(pending.timer); delete output.pendingAck; output.bufferedMs = ack.bufferedMs;
      // This is graph acceptance, not proof of hearing; only played below commits hearing.
      pending.resolve();
    } else if (ack.type === 'started') {
      this.mark(output, 'playback_started');
      this.options.emit({ type: 'playback', playbackId: output.handle.runId, sessionId: output.handle.sessionId, generation: output.handle.generation, state: 'playing' });
    } else {
      if (!output.completedSegments.has(ack.segmentId) || output.playedSegments.has(ack.segmentId)) return;
      output.playedSegments.add(ack.segmentId);
      this.options.ledger.transition(ack.segmentId, ack.generation, 'played');
      output.bufferedMs = 0; void this.pump(output); this.maybeComplete(output);
    }
  }
  private maybeComplete(output: Output): void {
    if (output.audioEnded && output.completedSegments.size === output.playedSegments.size) {
      this.mark(output, 'playback_ended'); this.close(output, 'played');
    }
  }
  private mark(output: Output, event: Parameters<VoiceLatencyRecorder['mark']>[1]): void {
    this.options.latency?.mark({ captureId: output.traceId, generation: output.handle.generation }, event);
  }
  private close(output: Output, outcome: 'played' | 'interrupted' | 'failed'): void {
    if (output.closed) return;
    output.closed = true;
    clearTimeout(output.timer); clearInterval(output.tick);
    if (output.pendingAck) { clearTimeout(output.pendingAck.timer); output.pendingAck.reject(new Error('voice_output_closed')); delete output.pendingAck; }
    if (outcome !== 'played') {
      this.options.ledger.interrupt(output.handle.runId, output.handle.generation);
      this.options.ledger.recordUnheardBoundary({ runId: output.handle.runId, generation: output.handle.generation,
        voiceSessionId: output.handle.sessionId, turnId: output.handle.runId });
      void output.tts?.cancel();
      try { output.port?.postMessage({ type: outcome === 'failed' ? 'failed' : 'cancelled', ...output.handle }); } catch { /* The receiver may already be gone. */ }
    }
    output.port?.close(); this.outputs.delete(output.handle.runId);
    this.options.emit({ type: 'output_closed', ...output.handle, outcome });
    this.options.latency?.end({ captureId: output.traceId, generation: output.handle.generation });
  }
  stop(sessionId?: string): void { for (const output of this.outputs.values()) if (!sessionId || output.handle.sessionId === sessionId) this.close(output, 'interrupted'); }
}

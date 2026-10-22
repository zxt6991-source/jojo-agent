import { SPEECH_LIMITS, SpeechProviderError, type SpeechTtsProvider } from '@desktop-agent/contracts';

export interface TtsAudioChunk {
  sessionId: string;
  generation: number;
  segmentId: string;
  sequence: number;
  codec: 'pcm16le';
  sampleRate: 24000;
  channels: 1;
  pcm: Uint8Array;
  /** Frame position within the ledger segment, never the session. */
  segmentFrameOffset: number;
  /** Unknown until completion for native PCM streams. */
  segmentFrames?: number;
  final: boolean;
}
export interface TtsSessionOptions {
  sessionId: string;
  generation: number;
  speakerId: string;
  speechRate: number;
  signal?: AbortSignal;
  maxBufferedAudioMs?: number;
  maxQueuedTextChars?: number;
}
export interface TtsAppendOptions {
  segmentId?: string;
  /** Use for a phrase already committed by the projector/scheduler. */
  endSegment?: boolean;
}
export interface TtsSession {
  append(textDelta: string, options?: TtsAppendOptions): Promise<void>;
  /** Close input. Consume audio concurrently; resolution includes downstream backpressure. */
  finish(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  /** One consumer owns the stream. Returning early cancels synthesis. */
  audio(): AsyncIterable<TtsAudioChunk>;
  readonly bufferedAudioMs: number;
}
export interface RealtimeTtsProvider {
  readonly capabilities: { textStreaming: boolean; audioStreaming: boolean; wordTimings: boolean };
  open(options: TtsSessionOptions): Promise<TtsSession>;
}

/** A session adapter for complete-WAV providers such as macOS say. The public
 * session accepts text deltas, but each buffered segment still needs a complete
 * local synthesis before its first PCM. This is deliberately not advertised as
 * native text/audio streaming or as acoustically continuous synthesis. */
export function createBufferedRealtimeTtsProvider(provider: SpeechTtsProvider): RealtimeTtsProvider {
  return {
    capabilities: { textStreaming: false, audioStreaming: false, wordTimings: false },
    async open(options) { return new QueuedTtsSession(provider, options, false); }
  };
}

/** Native audio streaming still takes complete, safely projected text phrases. */
export function createRealtimeTtsProvider(provider: SpeechTtsProvider): RealtimeTtsProvider {
  if (!provider.synthesizePcm) return createBufferedRealtimeTtsProvider(provider);
  return {
    capabilities: { textStreaming: false, audioStreaming: true, wordTimings: false },
    async open(options) { return new QueuedTtsSession(provider, options, true); }
  };
}

interface TextSegment { id: string; text: string }
const PCM_FRAMES_PER_CHUNK = 480; // 20 ms at 24 kHz.

class QueuedTtsSession implements TtsSession {
  private readonly controller = new AbortController();
  private readonly queue: TextSegment[] = [];
  private readonly audioQueue: TtsAudioChunk[] = [];
  private readonly seenSegments = new Set<string>();
  private pending: TextSegment | undefined;
  private queuedChars = 0;
  private bufferedFrames = 0;
  private sequence = 0;
  private inputClosed = false;
  private cancelled = false;
  private audioClaimed = false;
  private failure: SpeechProviderError | undefined;
  private worker: Promise<void> | undefined;
  private readonly changed = new Set<() => void>();
  private readonly maxFrames: number;
  private readonly maxChars: number;
  private readonly externalAbort: () => void;

  constructor(private readonly provider: SpeechTtsProvider, private readonly options: TtsSessionOptions, private readonly nativeAudio: boolean) {
    if (!options.sessionId || options.sessionId.length > 256 || !Number.isSafeInteger(options.generation) || options.generation < 0
      || !options.speakerId.trim() || options.speakerId.length > 256 || !Number.isInteger(options.speechRate) || options.speechRate < -50 || options.speechRate > 100) {
      throw new SpeechProviderError('protocol_error', 'Invalid TTS session options.');
    }
    const maxAudioMs = options.maxBufferedAudioMs ?? 1500;
    this.maxChars = options.maxQueuedTextChars ?? 2400;
    if (!Number.isFinite(maxAudioMs) || maxAudioMs < 20 || maxAudioMs > 10_000
      || !Number.isSafeInteger(this.maxChars) || this.maxChars < 1 || this.maxChars > 20_000) {
      throw new SpeechProviderError('protocol_error', 'Invalid TTS session buffer limits.');
    }
    this.maxFrames = Math.floor(maxAudioMs * 24);
    this.externalAbort = () => { void this.cancel(); };
    options.signal?.addEventListener('abort', this.externalAbort, { once: true });
    if (options.signal?.aborted) void this.cancel();
  }

  get bufferedAudioMs(): number { return this.bufferedFrames / 24; }

  async append(textDelta: string, options: TtsAppendOptions = {}): Promise<void> {
    this.assertWritable();
    if (typeof textDelta !== 'string' || textDelta.includes('\0')) throw new SpeechProviderError('protocol_error', 'Invalid TTS text delta.');
    const chars = Array.from(textDelta).length;
    if (chars + this.queuedChars > this.maxChars) throw new SpeechProviderError('rate_limited', 'TTS text buffer is full.');
    if (!textDelta.length) return;
    const id = options.segmentId ?? this.pending?.id ?? crypto.randomUUID();
    if (!id || id.length > 256) throw new SpeechProviderError('protocol_error', 'Invalid TTS segment identity.');
    if ((this.pending?.id === id ? Array.from(this.pending.text).length : 0) + chars > SPEECH_LIMITS.autoReadChars) {
      throw new SpeechProviderError('protocol_error', 'TTS segment exceeds the local synthesis text limit.');
    }
    if (this.pending?.id !== id && this.seenSegments.has(id)) throw new SpeechProviderError('protocol_error', 'A completed TTS segment cannot be appended again.');
    if (this.pending && this.pending.id !== id) this.commitPending();
    if (!this.pending) {
      this.pending = { id, text: '' };
    }
    this.pending.text += textDelta;
    this.queuedChars += chars;
    // Explicit ledger segments are committed by the caller. Unlabelled deltas
    // use a sentence buffer so a number/date fragment is never synthesized alone.
    if (options.endSegment || (!options.segmentId && /[。！？!?\n][”’」』）)]*\s*$/u.test(this.pending.text))) this.commitPending();
    this.startWorker();
  }

  async finish(): Promise<void> {
    if (this.cancelled) return;
    if (this.failure) throw this.failure;
    if (!this.inputClosed) {
      this.commitPending();
      this.inputClosed = true;
      this.startWorker();
      this.wake();
    }
    while (this.worker) await this.worker;
    if (this.failure) throw this.failure;
  }

  async cancel(_reason?: string): Promise<void> {
    if (!this.cancelled) {
      this.cancelled = true;
      this.inputClosed = true;
      this.controller.abort();
      this.queue.length = 0;
      this.audioQueue.length = 0;
      this.pending = undefined;
      this.queuedChars = 0;
      this.bufferedFrames = 0;
      this.detach();
      this.wake();
    }
    await this.worker;
  }

  async *audio(): AsyncIterable<TtsAudioChunk> {
    if (this.audioClaimed) throw new SpeechProviderError('protocol_error', 'The TTS session audio stream already has a consumer.');
    this.audioClaimed = true;
    try {
      while (!this.cancelled) {
        if (this.failure) throw this.failure;
        const chunk = this.audioQueue.shift();
        if (chunk) {
          this.bufferedFrames -= chunk.pcm.byteLength / 2;
          this.wake();
          yield chunk;
          continue;
        }
        if (this.inputClosed && !this.worker) return;
        await this.waitForChange();
      }
    } finally {
      if (!this.inputClosed || this.worker || this.audioQueue.length) await this.cancel();
      else this.detach();
    }
  }

  private assertWritable(): void {
    if (this.failure) throw this.failure;
    if (this.cancelled) throw new SpeechProviderError('cancelled', 'TTS session was cancelled.');
    if (this.inputClosed) throw new SpeechProviderError('protocol_error', 'TTS session input has already finished.');
  }
  private commitPending(): void {
    if (!this.pending) return;
    const segment = this.pending;
    this.pending = undefined;
    if (segment.text.trim()) {
      if (this.seenSegments.size >= 1000) throw new SpeechProviderError('rate_limited', 'TTS session segment limit reached.');
      this.seenSegments.add(segment.id);
      this.queue.push(segment);
    } else this.queuedChars -= Array.from(segment.text).length;
  }
  private startWorker(): void {
    if (this.worker || this.cancelled || this.failure || !this.queue.length) return;
    this.worker = this.synthesizeQueued().catch((error: unknown) => {
      if (!this.cancelled) {
        this.failure = error instanceof SpeechProviderError ? error : new SpeechProviderError('local_unavailable', 'Local TTS synthesis failed.');
        this.queue.length = 0;
        this.audioQueue.length = 0;
        this.pending = undefined;
        this.queuedChars = 0;
        this.bufferedFrames = 0;
        this.controller.abort();
        this.detach();
      }
    }).finally(() => {
      this.worker = undefined;
      if (this.inputClosed) this.detach();
      this.wake();
      this.startWorker();
    });
  }
  private async synthesizeQueued(): Promise<void> {
    while (this.queue.length && !this.cancelled) {
      const segment = this.queue.shift()!;
      if (this.nativeAudio) {
        await this.synthesizeNative(segment);
        if (this.cancelled) return;
        this.queuedChars -= Array.from(segment.text).length;
        continue;
      }
      const requestId = crypto.randomUUID();
      let wav: Uint8Array | undefined;
      let completed = false;
      for await (const event of this.provider.synthesize({
        requestId, text: segment.text, speakerId: this.options.speakerId,
        speechRate: this.options.speechRate, signal: this.controller.signal
      })) {
        if (this.cancelled) return;
        if (event.requestId !== requestId || completed) throw new SpeechProviderError('protocol_error', 'Unexpected TTS event ordering.');
        if (event.type === 'completed') { completed = true; continue; }
        if (wav || event.format !== 'wav' || event.sampleRate !== 24000) throw new SpeechProviderError('invalid_audio', 'The buffered TTS adapter requires one complete PCM WAV per segment.');
        wav = event.bytes;
      }
      if (this.cancelled) return;
      if (!completed || !wav) throw new SpeechProviderError('protocol_error', 'Local TTS ended without complete audio.');
      const pcm = pcm24kFromWav(wav);
      const frames = pcm.byteLength / 2;
      for (let frame = 0; frame < frames; frame += PCM_FRAMES_PER_CHUNK) {
        const count = Math.min(PCM_FRAMES_PER_CHUNK, frames - frame);
        while (!this.cancelled && this.bufferedFrames + count > this.maxFrames) await this.waitForChange();
        if (this.cancelled) return;
        this.audioQueue.push({
          sessionId: this.options.sessionId, generation: this.options.generation, segmentId: segment.id,
          sequence: ++this.sequence, codec: 'pcm16le', sampleRate: 24000, channels: 1,
          pcm: pcm.slice(frame * 2, (frame + count) * 2), segmentFrameOffset: frame,
          segmentFrames: frames, final: frame + count === frames
        });
        this.bufferedFrames += count;
        this.wake();
      }
      this.queuedChars -= Array.from(segment.text).length;
    }
  }
  private async synthesizeNative(segment: TextSegment): Promise<void> {
    const requestId = crypto.randomUUID();
    let tail: Uint8Array | undefined, frames = 0, emittedFrames = 0, completed = false;
    for await (const event of this.provider.synthesizePcm!({
      requestId, text: segment.text, speakerId: this.options.speakerId,
      speechRate: this.options.speechRate, signal: this.controller.signal
    })) {
      if (this.cancelled) return;
      if (event.requestId !== requestId || completed) throw new SpeechProviderError('protocol_error', 'Unexpected TTS event ordering.');
      if (event.type === 'completed') { completed = true; continue; }
      if (event.sampleRate !== 24000 || !(event.bytes instanceof Uint8Array) || !event.bytes.length || event.bytes.length % 2
        || frames * 2 + event.bytes.length > SPEECH_LIMITS.ttsBytes) {
        throw new SpeechProviderError('invalid_audio', 'Expected bounded mono 24 kHz PCM16 audio.');
      }
      frames += event.bytes.length / 2;
      const pcm = new Uint8Array((tail?.length ?? 0) + event.bytes.length);
      if (tail) pcm.set(tail);
      pcm.set(event.bytes, tail?.length ?? 0);
      // Keep only one sample for the final receipt. The rest of the very first
      // provider block can play before another block or completion arrives.
      tail = pcm.slice(-2);
      for (let offset = 0; offset < pcm.length - 2; offset += PCM_FRAMES_PER_CHUNK * 2) {
        const bytes = pcm.slice(offset, Math.min(offset + PCM_FRAMES_PER_CHUNK * 2, pcm.length - 2));
        await this.enqueueNative(segment.id, bytes, emittedFrames, false);
        if (this.cancelled) return;
        emittedFrames += bytes.length / 2;
      }
    }
    if (this.cancelled) return;
    if (!completed || !tail) throw new SpeechProviderError('protocol_error', 'Local TTS ended without complete audio.');
    await this.enqueueNative(segment.id, tail, emittedFrames, true, frames);
  }
  private async enqueueNative(segmentId: string, pcm: Uint8Array, segmentFrameOffset: number, final: boolean, segmentFrames?: number): Promise<void> {
    const count = pcm.length / 2;
    while (!this.cancelled && this.bufferedFrames + count > this.maxFrames) await this.waitForChange();
    if (this.cancelled) return;
    this.audioQueue.push({
      sessionId: this.options.sessionId, generation: this.options.generation, segmentId,
      sequence: ++this.sequence, codec: 'pcm16le', sampleRate: 24000, channels: 1,
      pcm, segmentFrameOffset, ...(segmentFrames === undefined ? {} : { segmentFrames }), final
    });
    this.bufferedFrames += count;
    this.wake();
  }
  private wake(): void { for (const resolve of this.changed) resolve(); this.changed.clear(); }
  private waitForChange(): Promise<void> { return new Promise(resolve => { this.changed.add(resolve); }); }
  private detach(): void { this.options.signal?.removeEventListener('abort', this.externalAbort); }
}

/** Bounded, complete 24 kHz mono PCM16 RIFF parser. Container headers never
 * enter the playback worklet; compressed audio requires a separate decoder. */
export function pcm24kFromWav(bytes: Uint8Array): Uint8Array {
  const invalid = () => new SpeechProviderError('invalid_audio', 'Expected complete mono 24 kHz PCM16 WAV audio.');
  if (bytes.byteLength < 44 || bytes.byteLength > SPEECH_LIMITS.ttsBytes) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || view.getUint32(4, true) !== bytes.byteLength - 8 || tag(8) !== 'WAVE') throw invalid();
  let offset = 12;
  let format = false;
  let pcm: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw invalid();
    const kind = tag(offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + length % 2;
    if (paddedEnd > bytes.byteLength) throw invalid();
    if (kind === 'fmt ') {
      if (format || pcm || length < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint32(start + 4, true) !== 24000 || view.getUint32(start + 8, true) !== 48000
        || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw invalid();
      format = true;
    } else if (kind === 'data') {
      if (!format || pcm || !length || length % 2) throw invalid();
      pcm = bytes.subarray(start, end);
    }
    offset = paddedEnd;
  }
  if (!format || !pcm || offset !== bytes.byteLength) throw invalid();
  return pcm;
}

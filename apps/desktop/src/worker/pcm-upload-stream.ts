import { SPEECH_LIMITS, SpeechProviderError } from '@desktop-agent/contracts';
import { z } from 'zod';

/** The audio port is deliberately separate from JSON Worker commands. */
export interface PcmAudioPort {
  on(event: 'message' | 'close', listener: (event: unknown) => void): unknown;
  off(event: 'message' | 'close', listener: (event: unknown) => void): unknown;
  postMessage(message: unknown): void;
  start?(): void;
  close(): void;
}
const identity = { captureId: z.string().min(1).max(256), generation: z.number().int().nonnegative() };
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('audio'), ...identity, sequence: z.number().int().positive(), bytes: z.instanceof(Uint8Array) }).strict(),
  z.object({ type: z.literal('end'), ...identity, lastSequence: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('cancel'), ...identity }).strict()
]);
interface QueuedPcm { sequence: number; bytes: Uint8Array; acceptedAt: number }

/** At most eight unacknowledged chunks; ACK happens when the consumer requests
 * its next chunk, after the previous PCM has been handed to the Provider. */
export class PcmUploadStream implements AsyncIterable<Uint8Array> {
  private readonly queue: QueuedPcm[] = [];
  private current: QueuedPcm | undefined;
  private totalBytes = 0;
  private sequence = 0;
  private ended = false;
  private consumed = false;
  private disposed = false;
  private failure: SpeechProviderError | undefined;
  private active = false;
  private wake: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly port: PcmAudioPort, private readonly binding: { captureId: string; generation: number },
    private readonly callbacks: { onEnd(): void; onFailure(error: SpeechProviderError): void }, private readonly now: () => number = Date.now) {
    this.binding = { captureId: binding.captureId, generation: binding.generation };
    port.on('message', this.onMessage); port.on('close', this.onClose); port.start?.();
  }
  get finished(): boolean { return this.ended && this.consumed && !this.failure; }
  get error(): SpeechProviderError | undefined { return this.failure; }
  get bytes(): number { return this.totalBytes; }
  activate(): void { if (!this.disposed) this.active = true; }
  private notify(): void { const wake = this.wake; this.wake = undefined; wake?.(); }
  private deadline(): void {
    if (this.timer) clearTimeout(this.timer);
    const oldest = this.current ?? this.queue[0];
    if (!oldest || this.disposed) { this.timer = undefined; return; }
    const delay = Math.max(0, oldest.acceptedAt + 2_000 - this.now());
    this.timer = setTimeout(() => this.fail(new SpeechProviderError('timeout', 'Audio upload stalled; record the sentence again.')), delay);
  }
  private onClose = (): void => {
    if (!this.disposed) this.fail(new SpeechProviderError('cancelled', 'Audio capture port closed.'));
  };
  private onMessage = (event: unknown): void => {
    if (this.disposed || this.failure) return;
    const value = event && typeof event === 'object' && 'data' in event && !('type' in event)
      ? (event as { data: unknown }).data : event;
    const parsed = frameSchema.safeParse(value);
    if (!parsed.success || parsed.data.captureId !== this.binding.captureId || parsed.data.generation !== this.binding.generation) {
      this.fail(new SpeechProviderError('invalid_audio', 'Invalid audio capture binding or frame.')); return;
    }
    const frame = parsed.data;
    if (frame.type === 'cancel') { this.fail(new SpeechProviderError('cancelled', 'Audio capture cancelled.')); return; }
    if (!this.active) { this.fail(new SpeechProviderError('invalid_audio', 'Audio arrived before Provider readiness.')); return; }
    if (this.ended) { this.fail(new SpeechProviderError('invalid_audio', 'Audio arrived after the end marker.')); return; }
    if (frame.type === 'end') {
      if (frame.lastSequence !== this.sequence || !this.totalBytes) {
        this.fail(new SpeechProviderError('invalid_audio', 'Audio capture is empty or has missing chunks.')); return;
      }
      this.ended = true; this.callbacks.onEnd(); this.notify(); return;
    }
    const bytes = frame.bytes.byteLength;
    if (frame.sequence !== this.sequence + 1 || !bytes || bytes % 2 || bytes > SPEECH_LIMITS.maxChunkBytes ||
      this.totalBytes + bytes > SPEECH_LIMITS.captureBytes || this.queue.length + (this.current ? 1 : 0) >= 8) {
      this.fail(new SpeechProviderError('invalid_audio', 'Audio capture exceeded its bounds or lost a chunk.')); return;
    }
    this.sequence = frame.sequence; this.totalBytes += bytes;
    // The sender can no longer mutate an accepted chunk while it awaits an ACK.
    this.queue.push({ sequence: frame.sequence, bytes: Uint8Array.from(frame.bytes), acceptedAt: this.now() });
    this.deadline(); this.notify();
  };
  fail(error: SpeechProviderError): void {
    if (this.disposed || this.failure) return;
    this.failure = error; this.queue.length = 0; this.current = undefined;
    this.notify(); this.dispose(); this.callbacks.onFailure(error);
  }
  private acknowledge(): void {
    if (!this.current) return;
    const sequence = this.current.sequence; this.current = undefined;
    try { this.port.postMessage({ type: 'ack', ...this.binding, sequence }); }
    catch { this.fail(new SpeechProviderError('cancelled', 'Audio capture port closed.')); }
    this.deadline();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      while (true) {
        this.acknowledge();
        if (this.failure) throw this.failure;
        if (this.disposed) throw new SpeechProviderError('cancelled', 'Audio capture cancelled.');
        const next = this.queue.shift();
        if (next) { this.current = next; this.deadline(); yield next.bytes; continue; }
        if (this.ended) { this.consumed = true; return; }
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
    } finally { this.queue.length = 0; this.current = undefined; this.deadline(); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.queue.length = 0; this.current = undefined; this.notify();
    this.port.off('message', this.onMessage); this.port.off('close', this.onClose);
    this.port.close();
  }
}

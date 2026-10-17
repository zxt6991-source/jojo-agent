import { SPEECH_LIMITS, SpeechAudioAckSchema, SpeechAudioFrameSchema, type SpeechCaptureHandle } from '@desktop-agent/contracts';

export interface MainAudioPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  start(): void;
  postMessage(value: unknown): void;
  close(): void;
}

/** Main enforces a separate bounded binary channel; no PCM reaches JSON IPC. */
export class SpeechStreamBridge {
  private sequence = 0;
  private acknowledged = 0;
  private bytes = 0;
  private ended = false;
  private closed = false;
  private readonly pending = new Map<number, number>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly handle: SpeechCaptureHandle, private readonly renderer: MainAudioPort,
    private readonly worker: MainAudioPort, private readonly fail: () => void,
    private readonly now: () => number = Date.now) {
    renderer.on('message', event => this.receive(event.data));
    worker.on('message', event => this.acknowledge(event.data));
    renderer.start(); worker.start();
    this.timer = setInterval(() => {
      const first = this.pending.values().next().value;
      if (first !== undefined && this.now() - first >= 2_000) this.reject();
    }, 100);
    this.timer.unref?.();
  }
  private matches(value: { captureId: string; generation: number }): boolean {
    return value.captureId === this.handle.captureId && value.generation === this.handle.generation;
  }
  private receive(raw: unknown): void {
    if (this.closed) return;
    const parsed = SpeechAudioFrameSchema.safeParse(raw);
    if (!parsed.success || !this.matches(parsed.data) || this.ended) { this.reject(); return; }
    const frame = parsed.data;
    if (frame.type === 'cancel') { this.worker.postMessage(frame); this.close(); this.fail(); return; }
    if (frame.type === 'end') {
      if (frame.lastSequence !== this.sequence || this.bytes === 0) { this.reject(); return; }
      this.ended = true;
    } else {
      if (frame.sequence !== this.sequence + 1 || this.pending.size >= 8
        || this.bytes + frame.bytes.byteLength > SPEECH_LIMITS.captureBytes) { this.reject(); return; }
      this.sequence = frame.sequence; this.bytes += frame.bytes.byteLength;
      this.pending.set(frame.sequence, this.now());
    }
    this.worker.postMessage(frame);
  }
  private acknowledge(raw: unknown): void {
    if (this.closed) return;
    const parsed = SpeechAudioAckSchema.safeParse(raw);
    if (!parsed.success || !this.matches(parsed.data) || parsed.data.sequence !== this.acknowledged + 1
      || !this.pending.has(parsed.data.sequence)) { this.reject(); return; }
    this.acknowledged = parsed.data.sequence; this.pending.delete(parsed.data.sequence);
    this.renderer.postMessage(parsed.data);
  }
  private reject(): void { this.close(); this.fail(); }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.pending.clear();
    this.renderer.close(); this.worker.close();
  }
}

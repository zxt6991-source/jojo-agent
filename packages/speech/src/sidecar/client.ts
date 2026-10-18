import {
  encodeSidecarFrame, isVoiceCaptureContext, parseSidecarEvent, sameVoiceCapture, SidecarFrameDecoder,
  type SidecarCapabilities, type SidecarControl, type SidecarEvent, type VoiceCaptureContext
} from './protocol.js';

/** Host owns process spawning and stderr; this package remains host independent. */
export interface SpeechSidecarTransport {
  write(bytes: Uint8Array): Promise<void>;
  subscribe(listener: (bytes: Uint8Array) => void, onClose: (error?: Error) => void): () => void;
  close(): Promise<void>;
}
export interface SpeechSidecarClientOptions {
  connect(): Promise<SpeechSidecarTransport>;
  readyTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxPendingFrames?: number;
}
interface Pending {
  resolve(event: SidecarEvent): void;
  reject(error: Error): void;
  matches(event: SidecarEvent): boolean;
  timer: ReturnType<typeof setTimeout>;
}
export class SpeechSidecarClient {
  private transport: SpeechSidecarTransport | undefined;
  private unsubscribe: (() => void) | undefined;
  private connecting: Promise<SidecarCapabilities> | undefined;
  private capabilities: SidecarCapabilities | undefined;
  private context: VoiceCaptureContext | undefined;
  private readonly listeners = new Set<(event: SidecarEvent) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private readonly pending = new Set<Pending>();
  private pendingAudio = 0;
  private lastSequence = -1;
  private writeChain: Promise<void> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly options: SpeechSidecarClientOptions) {
    for (const value of [options.readyTimeoutMs ?? 30_000, options.commandTimeoutMs ?? 5_000, options.maxPendingFrames ?? 16]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Sidecar limits must be positive integers.');
    }
  }
  subscribe(listener: (event: SidecarEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  /** Reports idle process loss too, when there is no outstanding audio ACK. */
  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener); return () => { this.failureListeners.delete(listener); };
  }
  start(): Promise<SidecarCapabilities> {
    if (this.capabilities) return Promise.resolve(this.capabilities);
    if (this.connecting) return this.connecting;
    const epoch = ++this.epoch;
    this.connecting = this.connect(epoch);
    return this.connecting;
  }
  private async connect(epoch: number): Promise<SidecarCapabilities> {
    try {
      const transport = await this.options.connect();
      if (epoch !== this.epoch) { await transport.close(); throw new Error('Sidecar startup cancelled.'); }
      this.transport = transport;
      const ready = this.waitFor(event => event.type === 'ready', this.options.readyTimeoutMs ?? 30_000);
      const decoder = new SidecarFrameDecoder();
      this.unsubscribe = transport.subscribe(bytes => {
        if (epoch !== this.epoch) return;
        try {
          for (const frame of decoder.push(bytes)) {
            if (frame.body.length) throw new Error('Unexpected sidecar event body.');
            this.receive(parseSidecarEvent(frame.header));
          }
        } catch { this.fail(new Error('Invalid speech sidecar protocol.')); }
      }, () => { if (epoch === this.epoch) this.fail(new Error('Speech sidecar disconnected.')); });
      const event = await ready;
      if (event.type !== 'ready') throw new Error('Sidecar did not become ready.');
      this.capabilities = event.capabilities;
      return event.capabilities;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Speech sidecar unavailable.'));
      throw error;
    } finally { this.connecting = undefined; }
  }
  private receive(event: SidecarEvent): void {
    if (event.type !== 'ready' && event.type !== 'error' && (!this.context || !sameVoiceCapture(event, this.context))) return;
    if (event.type === 'error' && isVoiceCaptureContext(event) && (!this.context || !sameVoiceCapture(event, this.context))) return;
    if (event.type === 'error') {
      const error = new Error(`Speech sidecar: ${event.code}`);
      for (const item of this.pending) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
      if (event.fatal) { this.fail(error); return; }
    } else {
      for (const item of this.pending) if (item.matches(event)) {
        clearTimeout(item.timer); this.pending.delete(item); item.resolve(event);
      }
    }
    for (const listener of this.listeners) { try { listener(event); } catch { /* Observers do not control the process. */ } }
  }
  private waitFor(matches: Pending['matches'], timeoutMs = this.options.commandTimeoutMs ?? 5_000): Promise<SidecarEvent> {
    return new Promise((resolve, reject) => {
      const item: Pending = { resolve, reject, matches, timer: setTimeout(() => {
        this.pending.delete(item); reject(new Error('Speech sidecar response timed out.'));
      }, timeoutMs) };
      this.pending.add(item);
    });
  }
  private write(control: SidecarControl, body?: Uint8Array): Promise<void> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error('Speech sidecar is unavailable.'));
    const frame = encodeSidecarFrame(control, body);
    const next = this.writeChain.then(() => {
      if (this.transport !== transport) throw new Error('Speech sidecar disconnected.');
      return transport.write(frame);
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }
  private async request(control: SidecarControl, matches: Pending['matches'], body?: Uint8Array): Promise<SidecarEvent> {
    const response = this.waitFor(matches);
    // Attach a rejection handler before an asynchronous host write can fail.
    void response.catch(() => undefined);
    try { await this.write(control, body); return await response; }
    catch (error) { this.fail(error instanceof Error ? error : new Error('Sidecar write failed.')); throw error; }
  }
  async open(context: VoiceCaptureContext): Promise<void> {
    if (!isVoiceCaptureContext(context)) throw new Error('Invalid voice capture context.');
    const caps = await this.start();
    if (!caps.vad.available || !caps.streamingAsr.available) throw new Error('Local streaming speech models are unavailable.');
    if (this.context) throw new Error('Close the current sidecar session first.');
    this.context = { ...context }; this.lastSequence = -1;
    await this.request({ type: 'session.open', ...context }, event => event.type === 'session.opened' && sameVoiceCapture(event, context));
  }
  async reset(context: VoiceCaptureContext): Promise<void> {
    if (!isVoiceCaptureContext(context) || !this.context || context.voiceSessionId !== this.context.voiceSessionId || context.generation <= this.context.generation) throw new Error('Turn reset must advance the same voice session generation.');
    this.context = { ...context }; this.lastSequence = -1;
    await this.request({ type: 'turn.reset', ...context }, event => event.type === 'turn.reset' && sameVoiceCapture(event, context));
  }
  async sendAudio(context: VoiceCaptureContext, sequence: number, pcm: Uint8Array): Promise<void> {
    this.assertCurrent(context);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= this.lastSequence) throw new Error('Audio sequence must increase.');
    if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 32_000) throw new Error('Audio frame must contain at most one second of PCM16LE.');
    if (this.pendingAudio >= (this.options.maxPendingFrames ?? 16)) throw new Error('Speech sidecar backpressure limit reached.');
    this.lastSequence = sequence; this.pendingAudio++;
    try {
      await this.request({ type: 'audio.frame', ...context, sequence, sampleRate: 16000, channels: 1 },
        event => event.type === 'audio.ack' && event.sequence === sequence && sameVoiceCapture(event, context), pcm);
    } finally { this.pendingAudio--; }
  }
  async finish(context: VoiceCaptureContext): Promise<void> { this.assertCurrent(context); await this.write({ type: 'turn.finish', ...context }); }
  async close(context: VoiceCaptureContext): Promise<void> {
    if (!this.context || !sameVoiceCapture(context, this.context)) return;
    try { await this.request({ type: 'session.close', ...context }, event => event.type === 'session.closed' && sameVoiceCapture(event, context)); }
    finally { this.context = undefined; this.lastSequence = -1; }
  }
  private assertCurrent(context: VoiceCaptureContext): void {
    if (!this.context || !sameVoiceCapture(context, this.context)) throw new Error('Stale voice capture context.');
  }
  private fail(error: Error): void {
    const transport = this.transport;
    this.transport = undefined; this.capabilities = undefined; this.context = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    for (const item of this.pending) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const listener of this.failureListeners) { try { listener(error); } catch { /* Observers cannot control transport cleanup. */ } }
    if (transport) void transport.close().catch(() => undefined);
  }
  async dispose(): Promise<void> {
    ++this.epoch;
    const transport = this.transport;
    this.fail(new Error('Speech sidecar closed.')); this.listeners.clear(); this.failureListeners.clear();
    if (transport) await transport.close();
  }
}

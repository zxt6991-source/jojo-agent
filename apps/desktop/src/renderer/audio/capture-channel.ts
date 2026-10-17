export type CaptureIdentity = { captureId: string; generation: number };
type CapturePort = Pick<MessagePort, 'postMessage' | 'close' | 'start'> & { onmessage: ((event: MessageEvent) => void) | null };

/** No unbounded staging queue: eight outstanding chunks or an expired ACK abort capture. */
export class CaptureChannel {
  private readonly identity: CaptureIdentity;
  private sequence = 1;
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>();
  private ending = false;
  private ended = false;
  private closed = false;
  constructor(identity: CaptureIdentity, private readonly port: CapturePort, private readonly onFailure: (message: string) => void) {
    this.identity = { captureId: identity.captureId, generation: identity.generation };
    port.onmessage = (event) => this.receive(event.data);
    port.start();
  }

  send(bytes: Uint8Array): void {
    if (this.closed || this.ending || this.ended) return;
    if (!bytes.length || bytes.length > 6_400 || bytes.length % 2 !== 0) return this.fail('录音格式无效，请重新录音。');
    if (this.pending.size >= 8) return this.fail('语音上传积压，请检查连接后重新录音。');
    const sequence = this.sequence++;
    this.pending.set(sequence, setTimeout(() => this.fail('语音上传超过两秒未确认，请重新录音。'), 2_000));
    this.port.postMessage({ type: 'audio', ...this.identity, sequence, bytes });
  }

  end(): void {
    if (this.closed || this.ending || this.ended) return;
    this.ending = true;
    this.flushEnd();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); this.port.onmessage = null; this.port.close();
  }

  private receive(message: unknown): void {
    if (!message || typeof message !== 'object' || this.closed) return;
    const value = message as Record<string, unknown>;
    if (value.captureId !== this.identity.captureId || value.generation !== this.identity.generation) return;
    if (value.type === 'error') { this.fail('语音上传失败，请重新录音。'); return; }
    if (value.type !== 'ack' || typeof value.sequence !== 'number') return;
    const timer = this.pending.get(value.sequence);
    if (!timer) return;
    clearTimeout(timer); this.pending.delete(value.sequence);
    this.flushEnd();
  }

  private flushEnd(): void {
    if (this.ending && !this.closed && this.pending.size === 0) {
      this.port.postMessage({ type: 'end', ...this.identity, lastSequence: this.sequence - 1 });
      this.ending = false;
      this.ended = true;
      this.port.onmessage = null;
      // The receiver closes after final recognition. Closing here can discard the end message.
    }
  }

  private fail(message: string): void { if (!this.closed) { this.close(); this.onFailure(message); } }
}

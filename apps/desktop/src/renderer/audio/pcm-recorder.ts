import workletUrl from './pcm-capture.worklet.ts?worker&url';
import { CaptureChannel } from './capture-channel';
import type { SpeechCaptureHandle } from '@desktop-agent/contracts';

type RecorderUpdate = { durationMs: number; rms: number };

export class PcmRecorder {
  private context: AudioContext | undefined;
  private stream: MediaStream | undefined;
  private worklet: AudioWorkletNode | undefined;
  private channel: CaptureChannel | undefined;
  private closed = false;
  private stopped = false;

  constructor(private readonly onUpdate: (value: RecorderUpdate) => void, private readonly onStopped: () => void, private readonly onError: (message: string) => void) {}

  async start(handle: SpeechCaptureHandle, port: MessagePort, signal: AbortSignal, inputDeviceId?: string): Promise<void> {
    const close = () => this.close();
    signal.addEventListener('abort', close, { once: true });
    try {
      this.channel = new CaptureChannel(handle, port, this.onError);
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
        channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }, video: false });
      if (this.closed || signal.aborted) { this.stream.getTracks().forEach(track => track.stop()); return; }
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule(new URL(workletUrl, window.location.href).href);
      if (this.closed || signal.aborted) return;
      this.worklet = new AudioWorkletNode(this.context, 'jojo-pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.worklet.port.onmessage = (event: MessageEvent) => {
        if (this.closed) return;
        const value = event.data as { type: string; bytes?: Uint8Array; durationMs?: number; rms?: number };
        if (value.type === 'pcm' && value.bytes instanceof Uint8Array) this.channel?.send(value.bytes);
        else if (value.type === 'level') this.onUpdate({ durationMs: value.durationMs ?? 0, rms: value.rms ?? 0 });
        else if (value.type === 'stopped') {
          this.channel?.end();
          this.onUpdate({ durationMs: value.durationMs ?? 0, rms: 0 });
          this.releaseMicrophone(); this.onStopped();
        }
      };
      const source = this.context.createMediaStreamSource(this.stream);
      // The processor's silent output keeps the graph running without microphone monitoring.
      source.connect(this.worklet); this.worklet.connect(this.context.destination);
      await this.context.resume();
      if (this.closed || signal.aborted) return;
      this.worklet.port.postMessage({ type: 'start' });
    } catch (cause) {
      this.close();
      if (!signal.aborted) throw cause;
    }
  }

  stop(): void {
    if (this.closed || this.stopped) return;
    this.stopped = true;
    this.worklet?.port.postMessage({ type: 'stop' });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worklet?.port.postMessage({ type: 'cancel' });
    this.channel?.close();
    this.releaseMicrophone();
  }

  private releaseMicrophone(): void {
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.worklet?.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}

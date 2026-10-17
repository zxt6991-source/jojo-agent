import { PcmPacketizer, PcmResampler } from './pcm';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly packetizer = new PcmPacketizer();
  private recording = false;
  private stopped = false;
  private levelSamples = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === 'start' && !this.stopped) this.recording = true;
      else if (event.data.type === 'stop') this.stop(false);
      else if (event.data.type === 'cancel') { this.stopped = true; this.recording = false; }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!this.recording || !channels?.length) return true;
    const mono = new Float32Array(channels[0]?.length ?? 0);
    let energy = 0;
    for (let index = 0; index < mono.length; index += 1) {
      let value = 0;
      for (const channel of channels) value += channel[index] ?? 0;
      mono[index] = value / channels.length;
      energy += mono[index]! ** 2;
    }
    this.emit(this.packetizer.push(this.resampler.push(mono)));
    this.levelSamples += mono.length;
    if (this.levelSamples >= sampleRate / 10) {
      this.levelSamples = 0;
      this.port.postMessage({ type: 'level', rms: Math.sqrt(energy / Math.max(1, mono.length)), durationMs: this.packetizer.durationMs });
    }
    if (this.packetizer.atLimit) this.stop(true);
    return !this.stopped;
  }

  private emit(packets: Uint8Array[]): void {
    for (const bytes of packets) this.port.postMessage({ type: 'pcm', bytes }, [bytes.buffer]);
  }

  private stop(limit: boolean): void {
    if (this.stopped) return;
    this.recording = false; this.stopped = true;
    this.emit(this.packetizer.push(this.resampler.finish()));
    this.emit(this.packetizer.finish());
    this.port.postMessage({ type: 'stopped', durationMs: this.packetizer.durationMs, limit });
  }
}

registerProcessor('jojo-pcm-capture', PcmCaptureProcessor);

/** Streaming, band-limited resampling. The small look-ahead is drained on stop. */
export class PcmResampler {
  private readonly ratio: number;
  private readonly radius = 48;
  private readonly phases = 1024;
  private readonly kernels: Float32Array[];
  private samples: number[] = [];
  private offset = 0;
  private inputCount = 0;
  private outputCount = 0;
  private finished = false;

  constructor(readonly inputRate: number, readonly outputRate = 16_000) {
    if (!Number.isFinite(inputRate) || inputRate < 8_000 || inputRate > 192_000) throw new Error('unsupported_sample_rate');
    this.ratio = inputRate / outputRate;
    const cutoff = Math.min(1, outputRate / inputRate) * 0.45;
    this.kernels = Array.from({ length: this.phases }, (_, phase) => {
      const kernel = new Float32Array(this.radius * 2 + 1);
      let sum = 0;
      for (let tap = -this.radius; tap <= this.radius; tap += 1) {
        const distance = tap - phase / this.phases;
        const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
        const window = 0.42 + 0.5 * Math.cos(Math.PI * distance / (this.radius + 1)) + 0.08 * Math.cos(2 * Math.PI * distance / (this.radius + 1));
        const weight = sinc * window;
        kernel[tap + this.radius] = weight;
        sum += weight;
      }
      for (let index = 0; index < kernel.length; index += 1) kernel[index] = kernel[index]! / sum;
      return kernel;
    });
  }

  push(input: Float32Array): Float32Array {
    if (this.finished) throw new Error('resampler_finished');
    for (const sample of input) this.samples.push(Number.isFinite(sample) ? sample : 0);
    this.inputCount += input.length;
    return this.drain(false);
  }

  finish(): Float32Array {
    if (this.finished) return new Float32Array();
    this.finished = true;
    const output = this.drain(true);
    this.samples = [];
    return output;
  }

  private drain(final: boolean): Float32Array {
    const output: number[] = [];
    const available = Math.floor(this.inputCount / this.ratio);
    while (this.outputCount < available) {
      const position = this.outputCount * this.ratio;
      const center = Math.floor(position);
      if (!final && center + this.radius >= this.inputCount) break;
      const phase = Math.min(this.phases - 1, Math.floor((position - center) * this.phases));
      const kernel = this.kernels[phase]!;
      let sample = 0;
      for (let tap = -this.radius; tap <= this.radius; tap += 1) {
        sample += (this.samples[center + tap - this.offset] ?? 0) * kernel[tap + this.radius]!;
      }
      output.push(sample);
      this.outputCount += 1;
    }
    const remove = Math.max(0, Math.floor(this.outputCount * this.ratio) - this.radius - this.offset);
    if (remove > 0) { this.samples.splice(0, remove); this.offset += remove; }
    return Float32Array.from(output);
  }
}

/** Precisely sized PCM16 little-endian packets, with at most 60 seconds retained. */
export class PcmPacketizer {
  private buffer = new Uint8Array(6_400);
  private size = 0;
  private samples = 0;
  private finished = false;
  readonly maxSamples = 60 * 16_000;
  get durationMs(): number { return this.samples / 16; }
  get atLimit(): boolean { return this.samples >= this.maxSamples; }

  push(input: Float32Array): Uint8Array[] {
    if (this.finished) throw new Error('packetizer_finished');
    const packets: Uint8Array[] = [];
    for (const raw of input) {
      if (this.atLimit) break;
      const sample = Math.max(-1, Math.min(1, Number.isFinite(raw) ? raw : 0));
      const value = Math.round(sample < 0 ? sample * 32_768 : sample * 32_767);
      this.buffer[this.size++] = value & 255;
      this.buffer[this.size++] = (value >> 8) & 255;
      this.samples += 1;
      if (this.size === this.buffer.length) { packets.push(this.buffer); this.buffer = new Uint8Array(6_400); this.size = 0; }
    }
    return packets;
  }

  finish(): Uint8Array[] {
    if (this.finished) return [];
    this.finished = true;
    const packets = this.size ? [this.buffer.slice(0, this.size)] : [];
    this.buffer = new Uint8Array(); this.size = 0;
    return packets;
  }
}

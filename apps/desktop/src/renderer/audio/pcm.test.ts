import { describe, expect, it } from 'vitest';
import { PcmPacketizer, PcmResampler } from './pcm';

function resample(rate: number, frequency: number, blockSize = 128): Float32Array {
  const resampler = new PcmResampler(rate);
  const signal = Float32Array.from({ length: rate }, (_, index) => Math.sin(2 * Math.PI * frequency * index / rate));
  const values: number[] = [];
  for (let offset = 0; offset < signal.length; offset += blockSize) values.push(...resampler.push(signal.subarray(offset, offset + blockSize)));
  values.push(...resampler.finish());
  return Float32Array.from(values);
}
const rms = (values: Float32Array) => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);

describe('PCM capture resampling', () => {
  it.each([16_000, 44_100, 48_000, 96_000])('preserves speech band and exact one-second duration at %i Hz', (rate) => {
    const result = resample(rate, 1_000);
    expect(result.length).toBe(16_000);
    expect(rms(result.subarray(100, 15_900))).toBeCloseTo(Math.SQRT1_2, 2);
  });
  it('rejects aliasing above the output Nyquist frequency', () => {
    expect(rms(resample(48_000, 12_000).subarray(100, 15_900))).toBeLessThan(0.002);
    expect(rms(resample(44_100, 11_000).subarray(100, 15_900))).toBeLessThan(0.002);
  });
  it('keeps phase and filter state across arbitrary AudioWorklet blocks', () => {
    expect(resample(44_100, 2_123, 71)).toEqual(resample(44_100, 2_123, 512));
  });
  it('drains only the exact remaining samples and rejects input after finish', () => {
    const resampler = new PcmResampler(48_000);
    expect(resampler.push(new Float32Array(96)).length).toBe(16);
    expect(resampler.finish().length).toBe(16);
    expect(resampler.finish().length).toBe(0);
    expect(() => resampler.push(new Float32Array(1))).toThrow('resampler_finished');
  });
});

describe('PCM packets', () => {
  it('quantizes signed little-endian with clipping and finite samples', () => {
    const packets = new PcmPacketizer();
    packets.push(Float32Array.from([-1, 1, 0, -2, 2, Number.NaN]));
    const bytes = packets.finish()[0]!;
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: 6 }, (_, index) => view.getInt16(index * 2, true))).toEqual([-32_768, 32_767, 0, -32_768, 32_767, 0]);
  });
  it('makes 6400-byte standard packets and a single ordered tail', () => {
    const packets = new PcmPacketizer();
    expect(packets.push(new Float32Array(3_100))).toHaveLength(0);
    expect(packets.push(new Float32Array(3_400)).map((packet) => packet.length)).toEqual([6_400, 6_400]);
    expect(packets.finish().map((packet) => packet.length)).toEqual([200]);
    expect(packets.finish()).toEqual([]);
  });
  it('enforces the 60-second capture limit without overshooting', () => {
    const packets = new PcmPacketizer();
    expect(packets.push(new Float32Array(960_128))).toHaveLength(300);
    expect(packets.atLimit).toBe(true);
    expect(packets.durationMs).toBe(60_000);
    expect(packets.finish()).toEqual([]);
  });
});

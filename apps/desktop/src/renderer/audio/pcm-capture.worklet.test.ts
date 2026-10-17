import { afterEach, describe, expect, it, vi } from 'vitest';

type Processor = { port: { onmessage: ((event: MessageEvent) => void) | null; postMessage: ReturnType<typeof vi.fn> }; process: (inputs: Float32Array[][]) => boolean };
afterEach(() => vi.unstubAllGlobals());

describe('AudioWorklet processor', () => {
  it('records only on explicit start, downmixes the actual rate and flushes the tail before stopped', async () => {
    let create: (new () => Processor) | undefined;
    class FakeAudioWorkletProcessor { port = { onmessage: null, postMessage: vi.fn() }; }
    vi.stubGlobal('sampleRate', 48_000);
    vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
    vi.stubGlobal('registerProcessor', (name: string, processor: new () => Processor) => { expect(name).toBe('jojo-pcm-capture'); create = processor; });
    await import('./pcm-capture.worklet');
    const processor = new create!();
    processor.process([[new Float32Array(4_800).fill(0.8)]]);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    processor.port.onmessage?.({ data: { type: 'start' } } as MessageEvent);
    // A stereo 48 kHz device must become mono PCM at 16 kHz, rather than declaring its input as 16 kHz.
    processor.process([[new Float32Array(4_800).fill(0.25), new Float32Array(4_800).fill(0.75)]]);
    processor.port.onmessage?.({ data: { type: 'stop' } } as MessageEvent);
    const messages = processor.port.postMessage.mock.calls.map(([value]) => value);
    const packet = messages.find(value => value.type === 'pcm');
    expect(packet.bytes.length).toBe(3_200);
    expect(new DataView(packet.bytes.buffer).getInt16(100, true)).toBeCloseTo(16_384, 0);
    expect(messages.at(-1)).toEqual({ type: 'stopped', durationMs: 100, limit: false });
    expect(processor.process([[new Float32Array(128)]])).toBe(false);
    processor.port.onmessage?.({ data: { type: 'stop' } } as MessageEvent);
    expect(processor.port.postMessage.mock.calls.map(([value]) => value.type).filter(type => type === 'stopped')).toHaveLength(1);
  });
});

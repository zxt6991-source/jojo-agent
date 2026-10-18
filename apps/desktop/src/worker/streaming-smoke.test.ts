import { describe, expect, it, vi } from 'vitest';
import type { SpeechAsrProvider } from '@desktop-agent/contracts';
import {
  normalizeExpectedStreamingText, parseStreamingPcmFixture, runStreamingSpeechSmoke
} from '../../../../scripts/streaming-speech-smoke';

function chunk(kind: string, body: Uint8Array): Buffer {
  const result = Buffer.alloc(8 + body.length + body.length % 2);
  result.write(kind); result.writeUInt32LE(body.length, 4); result.set(body, 8);
  return result;
}
function riff(chunks: Uint8Array[]): Buffer {
  const body = Buffer.concat(chunks), result = Buffer.alloc(12 + body.length);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8); result.set(body, 12);
  return result;
}
function format(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt16LE(1, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt32LE(16_000, 4); bytes.writeUInt32LE(32_000, 8);
  bytes.writeUInt16LE(2, 12); bytes.writeUInt16LE(16, 14);
  return bytes;
}
function wav(pcm = Buffer.from([1, 2, 3, 4])): Buffer { return riff([chunk('fmt ', format()), chunk('data', pcm)]); }
const signal = () => new AbortController().signal;

describe('offline streaming smoke WAV fixture', () => {
  it('removes only the validated container and respects typed-array offsets and odd metadata padding', () => {
    const pcm = Buffer.from([0, 127, 255, 0]);
    const file = riff([chunk('JUNK', new Uint8Array([1, 2, 3])), chunk('fmt ', format()), chunk('data', pcm), chunk('LIST', new Uint8Array([9]))]);
    expect(parseStreamingPcmFixture(file)).toEqual(pcm);
    const withPrefix = Buffer.concat([Buffer.alloc(7), file, Buffer.alloc(3)]);
    expect(parseStreamingPcmFixture(withPrefix.subarray(7, -3))).toEqual(pcm);
  });
  it.each([
    ['encoding', 0, 3], ['channels', 2, 2], ['sample rate', 4, 8_000], ['byte rate', 8, 16_000], ['block align', 12, 4], ['bits', 14, 8]
  ] as const)('rejects unsupported %s before any sidecar could run', (_label, offset, value) => {
    const fmt = format();
    if (offset === 4 || offset === 8) fmt.writeUInt32LE(value, offset); else fmt.writeUInt16LE(value, offset);
    expect(() => parseStreamingPcmFixture(riff([chunk('fmt ', fmt), chunk('data', new Uint8Array([1, 2]))]))).toThrowError(expect.objectContaining({ code: 'invalid_audio' }));
  });
  it('rejects empty/odd data, duplicates, wrong order, truncation, trailing bytes and oversized declarations', () => {
    const valid = wav(), wrongSize = Buffer.from(valid), hugeChunk = Buffer.from(valid), wrongContainer = Buffer.from(valid);
    wrongSize.writeUInt32LE(999, 4); hugeChunk.writeUInt32LE(0xffff_ffff, 40); wrongContainer.write('RF64');
    const invalid = [
      riff([chunk('fmt ', format()), chunk('data', new Uint8Array())]),
      riff([chunk('fmt ', format()), chunk('data', new Uint8Array([1]))]),
      riff([chunk('data', new Uint8Array([1, 2])), chunk('fmt ', format())]),
      riff([chunk('fmt ', format()), chunk('fmt ', format()), chunk('data', new Uint8Array([1, 2]))]),
      riff([chunk('fmt ', format()), chunk('data', new Uint8Array([1, 2])), chunk('data', new Uint8Array([3, 4]))]),
      riff([chunk('fmt ', new Uint8Array(2)), chunk('data', new Uint8Array([1, 2]))]),
      valid.subarray(0, -1), Buffer.concat([valid, Buffer.from([0])]), wrongSize, hugeChunk, wrongContainer,
      riff([chunk('fmt ', format()), chunk('data', new Uint8Array(60 * 32_000 + 2))]),
      new Uint8Array(60 * 32_000 + 64 * 1024 + 1)
    ];
    for (const bytes of invalid) expect(() => parseStreamingPcmFixture(bytes)).toThrowError(expect.objectContaining({ code: 'invalid_audio' }));
  });
});

describe('streaming speech smoke reporting', () => {
  it('stops its fixture only after an automatic endpoint and records the endpoint separately from final', async () => {
    let consumed = 0;
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) {
        consumed += bytes.length;
        yield { type: 'endpoint', requestId: input.requestId, reason: 'smart_turn' };
      }
      yield { type: 'final', requestId: input.requestId, text: '最终转写' };
    } };
    const [run] = await runStreamingSpeechSmoke({ provider, pcm: new Uint8Array(12_800), signal: signal(), iterations: 1, autoEndpoint: true });
    expect(consumed).toBe(6400);
    expect(run).toMatchObject({ frames: 1, endpointReason: 'smart_turn', recognizedChars: 4 });
    expect(run!.finalMs).toBeGreaterThanOrEqual(run!.endpointMs!);
  });
  it('fails with a bounded timeout when an automatic endpoint never arrives', async () => {
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) expect(bytes.length).toBeGreaterThan(0);
    } };
    await expect(runStreamingSpeechSmoke({ provider, pcm: new Uint8Array(6400), signal: signal(), iterations: 1, autoEndpoint: true, endpointTimeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('reuses one injected provider for two ordered captures and reports only numeric/boolean summaries by default', async () => {
    const captures: Uint8Array[][] = [];
    const recognize = vi.fn(async function* (input: Parameters<SpeechAsrProvider['recognize']>[0]): ReturnType<SpeechAsrProvider['recognize']> {
      const received: Uint8Array[] = []; captures.push(received);
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) {
        received.push(bytes); yield { type: 'partial', requestId: input.requestId, revision: received.length, text: '敏感字幕' };
      }
      yield { type: 'final', requestId: input.requestId, text: '你好，JOJO！' };
    });
    const pcm = Uint8Array.from({ length: 13_000 }, (_, index) => index % 255);
    let tick = 0;
    const result = await runStreamingSpeechSmoke({ provider: { recognize }, pcm, signal: signal(), expectedText: '你好 Jojo', now: () => ++tick });
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(captures.map(capture => capture.map(bytes => bytes.length))).toEqual([[6400, 6400, 200], [6400, 6400, 200]]);
    for (const capture of captures) expect(Buffer.concat(capture)).toEqual(Buffer.from(pcm));
    expect(result.map(run => run.firstCapture)).toEqual([true, false]);
    for (const run of result) expect(run).toMatchObject({ frames: 3, partialCount: 3, expectedTextMatches: true });
    expect(result.every(run => run.readyMs >= 0 && run.firstPartialMs! >= run.readyMs && run.finalMs >= run.firstPartialMs! && run.totalMs >= run.finalMs)).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain('你好'); expect(json).not.toContain('JOJO'); expect(json).not.toContain('敏感字幕');
    expect(json).not.toContain('requestId'); expect(json).not.toContain('finalText');
  });
  it('includes final text only when explicitly requested and supports an absent first partial', async () => {
    const provider: SpeechAsrProvider = { recognize: async function* (input) {
      yield { type: 'ready', requestId: input.requestId };
      for await (const bytes of input.audio) expect(bytes.length).toBeGreaterThan(0);
      yield { type: 'final', requestId: input.requestId, text: '显式查看转写' };
    } };
    const result = await runStreamingSpeechSmoke({ provider, pcm: new Uint8Array([0, 1]), signal: signal(), iterations: 1, showText: true, expectedText: '其他句子' });
    expect(result[0]).toMatchObject({ finalText: '显式查看转写', firstPartialMs: null, expectedTextMatches: false });
  });
  it('rejects premature finals and stops before touching a provider when cancelled', async () => {
    const recognize = vi.fn(async function* (input: Parameters<SpeechAsrProvider['recognize']>[0]): ReturnType<SpeechAsrProvider['recognize']> {
      yield { type: 'ready', requestId: input.requestId };
      yield { type: 'final', requestId: input.requestId, text: '还没读取音频' };
    });
    const options = { provider: { recognize }, pcm: new Uint8Array([0, 1]), signal: signal() };
    await expect(runStreamingSpeechSmoke(options)).rejects.toMatchObject({ code: 'protocol_error' });
    const controller = new AbortController(); controller.abort();
    await expect(runStreamingSpeechSmoke({ ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(recognize).toHaveBeenCalledTimes(1);
  });
  it('compares expected text without casing, spacing, punctuation or compatibility-form differences', () => {
    expect(normalizeExpectedStreamingText(' ＪＯＪＯ，今天 １２３！')).toBe('jojo今天123');
  });
});

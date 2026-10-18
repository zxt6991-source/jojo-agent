import { type SpeechTtsProvider, type TtsEvent } from '@desktop-agent/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createBufferedRealtimeTtsProvider, pcm24kFromWav, type TtsAudioChunk } from '../src/realtime-tts.js';

function wav(frames = 1440): Uint8Array {
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.byteLength - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) bytes.writeInt16LE(i % 32000, 44 + i * 2);
  return bytes;
}
function provider(frames = 1440): SpeechTtsProvider {
  return { synthesize: vi.fn(async function* (input: Parameters<SpeechTtsProvider['synthesize']>[0]): AsyncGenerator<TtsEvent> {
    yield { type: 'audio', requestId: input.requestId, format: 'wav', sampleRate: 24000, bytes: wav(frames) };
    yield { type: 'completed', requestId: input.requestId };
  }) };
}
const options = { sessionId: 'session-1', generation: 7, speakerId: 'default', speechRate: 0 };
async function collect(stream: AsyncIterable<TtsAudioChunk>): Promise<TtsAudioChunk[]> {
  const chunks: TtsAudioChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe('complete-WAV TTS session adapter', () => {
  it('keeps the capability distinction and buffers deltas until a safe sentence', async () => {
    const legacy = provider(); const adapter = createBufferedRealtimeTtsProvider(legacy);
    expect(adapter.capabilities).toEqual({ textStreaming: false, audioStreaming: false, wordTimings: false });
    const session = await adapter.open(options);
    const audio = collect(session.audio());
    await session.append('日期是 2026');
    await session.append('年 10 月 17 日');
    expect(legacy.synthesize).not.toHaveBeenCalled();
    await session.append('。');
    await session.finish();
    const chunks = await audio;
    expect(legacy.synthesize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '日期是 2026年 10 月 17 日。' }));
    expect(chunks).toHaveLength(3);
    expect(Buffer.concat(chunks.map(chunk => chunk.pcm))).toEqual(Buffer.from(wav()).subarray(44));
    expect(chunks.map(chunk => [chunk.sequence, chunk.segmentFrameOffset, chunk.segmentFrames, chunk.final])).toEqual([
      [1, 0, 1440, false], [2, 480, 1440, false], [3, 960, 1440, true]
    ]);
  });

  it('preserves ledger identities, generations, and serial segment order', async () => {
    const session = await createBufferedRealtimeTtsProvider(provider(480)).open(options);
    const audio = collect(session.audio());
    await session.append('已完成', { segmentId: 'ledger-1', endSegment: true });
    await session.append('正在验证', { segmentId: 'ledger-2' });
    await session.append('结果', { segmentId: 'ledger-2', endSegment: true });
    await session.finish();
    const chunks = await audio;
    expect(chunks.map(chunk => [chunk.sessionId, chunk.generation, chunk.segmentId, chunk.sequence, chunk.final])).toEqual([
      ['session-1', 7, 'ledger-1', 1, true], ['session-1', 7, 'ledger-2', 2, true]
    ]);
    await expect(session.append('later')).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('bounds PCM buffering, stops the producer until consumption, and cancel drops all stale audio', async () => {
    const legacy = provider(4800);
    const session = await createBufferedRealtimeTtsProvider(legacy).open({ ...options, maxBufferedAudioMs: 20 });
    await session.append('第一句', { segmentId: 'one', endSegment: true });
    await session.append('第二句', { segmentId: 'two', endSegment: true });
    await vi.waitFor(() => expect(session.bufferedAudioMs).toBe(20));
    expect(legacy.synthesize).toHaveBeenCalledTimes(1);
    const audio = session.audio()[Symbol.asyncIterator]();
    expect((await audio.next()).value?.segmentId).toBe('one');
    await vi.waitFor(() => expect(session.bufferedAudioMs).toBe(20));
    await session.cancel('user stopped speaking');
    expect(session.bufferedAudioMs).toBe(0);
    expect(await audio.next()).toEqual({ done: true, value: undefined });
    expect(legacy.synthesize).toHaveBeenCalledTimes(1);
  });

  it('aborts an active provider, never cancels the agent, and does not retain caller abort listeners', async () => {
    let activeSignal: AbortSignal | undefined;
    const legacy: SpeechTtsProvider = { // eslint-disable-next-line require-yield
      async *synthesize(input) {
      activeSignal = input.signal;
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    } };
    const controller = new AbortController();
    const session = await createBufferedRealtimeTtsProvider(legacy).open({ ...options, signal: controller.signal });
    await session.append('工作继续', { segmentId: 'one', endSegment: true });
    controller.abort();
    await session.cancel();
    expect(activeSignal?.aborted).toBe(true);
    await expect(session.append('过期')).rejects.toMatchObject({ code: 'cancelled' });
    expect(await collect(session.audio())).toEqual([]);
  });

  it('returns provider failure to both stream and finish without exposing provider bodies', async () => {
    const legacy: SpeechTtsProvider = { // eslint-disable-next-line require-yield
      async *synthesize() { throw new Error('raw secret provider body'); } };
    const session = await createBufferedRealtimeTtsProvider(legacy).open(options);
    const audio = collect(session.audio());
    const audioFailure = expect(audio).rejects.toMatchObject({ code: 'local_unavailable', message: 'Local TTS synthesis failed.' });
    await session.append('开始。');
    await expect(session.finish()).rejects.toMatchObject({ code: 'local_unavailable' });
    await audioFailure;
  });

  it('rejects repeated segments, text overflow and invalid buffer limits', async () => {
    const session = await createBufferedRealtimeTtsProvider(provider()).open({ ...options, maxQueuedTextChars: 8 });
    await session.append('第一句', { segmentId: 'same', endSegment: true });
    await expect(session.append('第二句', { segmentId: 'same' })).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(session.append('过长的输入内容超过上限')).rejects.toMatchObject({ code: 'rate_limited' });
    await session.cancel();
    await expect(createBufferedRealtimeTtsProvider(provider()).open({ ...options, maxBufferedAudioMs: 1 })).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it('rejects missing completion, compressed audio and malformed WAV before yielding PCM', async () => {
    for (const complete of [true, false]) {
      const legacy: SpeechTtsProvider = { async *synthesize(input) {
        yield { type: 'audio', requestId: input.requestId, format: complete ? 'mp3' : 'wav', sampleRate: 24000, bytes: wav() };
        if (complete) yield { type: 'completed', requestId: input.requestId };
      } };
      const session = await createBufferedRealtimeTtsProvider(legacy).open(options);
      await session.append('结束。');
      await expect(session.finish()).rejects.toMatchObject({ code: complete ? 'invalid_audio' : 'protocol_error' });
      await expect(collect(session.audio())).rejects.toBeInstanceOf(Error);
    }
    const invalid = Buffer.from(wav()); invalid.writeUInt32LE(16000, 24);
    expect(() => pcm24kFromWav(invalid)).toThrow('Expected complete mono 24 kHz PCM16 WAV audio.');
    expect(() => pcm24kFromWav(wav().subarray(0, 45))).toThrow();
  });

  it('cancels when the audio consumer returns early', async () => {
    let activeSignal: AbortSignal | undefined;
    const legacy = provider(4800);
    const original = legacy.synthesize;
    legacy.synthesize = input => { activeSignal = input.signal; return original(input); };
    const session = await createBufferedRealtimeTtsProvider(legacy).open({ ...options, maxBufferedAudioMs: 20 });
    await session.append('继续。');
    for await (const chunk of session.audio()) { void chunk; break; }
    expect(activeSignal?.aborted).toBe(true);
    expect(session.bufferedAudioMs).toBe(0);
  });
});

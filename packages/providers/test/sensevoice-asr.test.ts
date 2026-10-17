import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { SPEECH_LIMITS } from '@desktop-agent/contracts';
import type { AsrEvent, PcmInputFormat } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSenseVoiceAsrProvider } from '../src/speech/sensevoice-asr-adapter.js';
import type { SenseVoiceAsrOptions, SenseVoiceSpawn } from '../src/speech/sensevoice-asr-adapter.js';
import { SENSEVOICE_PYTHON_HELPER } from '../src/speech/sensevoice-python-helper.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly chunks: Buffer[] = [];
  readonly writes: Array<() => void> = [];
  holdWrites = false;
  killed = 0;
  ended = false;
  onEnd: (() => void) | undefined;
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.chunks.push(Buffer.from(chunk));
      if (this.holdWrites) this.writes.push(callback);
      else callback();
    },
    final: callback => { this.ended = true; callback(); this.onEnd?.(); }
  });
  message(value: unknown): void { this.stdout.write(`${JSON.stringify(value)}\n`); }
  close(code = 0): void { this.emit('close', code, null); }
  kill(signal?: NodeJS.Signals): boolean {
    expect(signal).toBe('SIGKILL'); this.killed++; this.close(-1); return true;
  }
}

const FORMAT: PcmInputFormat = { codec: 'pcm16le', sampleRate: 16000, channels: 1 };
const REQUEST_ID = 'local-fixture-request';
async function* audio(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> { yield* chunks; }

function harness(options: Partial<SenseVoiceAsrOptions> = {}, autoReady = true) {
  const child = new FakeProcess();
  const spawn = vi.fn<SenseVoiceSpawn>(() => {
    if (autoReady) queueMicrotask(() => child.message({ type: 'ready' }));
    return child;
  });
  const provider = createSenseVoiceAsrProvider({
    pythonPath: '/local venv/bin/python3', modelDirectory: '/local models/声学模型', language: 'zh', spawn, ...options
  });
  const controller = new AbortController();
  const events = (source = audio(new Uint8Array(6400)), format = FORMAT) => provider.recognize({
    requestId: REQUEST_ID, format, audio: source, signal: controller.signal
  })[Symbol.asyncIterator]();
  const finish = (text = '今天去散步。') => {
    child.message({ type: 'final', text }); child.close();
  };
  return { child, spawn, provider, controller, events, finish };
}

async function ready(iterator: AsyncIterator<AsrEvent>): Promise<void> {
  const event = iterator.next();
  await vi.advanceTimersByTimeAsync(0);
  expect((await event).value).toEqual({ type: 'ready', requestId: REQUEST_ID });
}

afterEach(() => { vi.useRealTimers(); });

describe('local SenseVoice ASR', () => {
  it('waits for the model before ready and passes local paths as literal arguments with isolated Python', async () => {
    vi.useFakeTimers(); const h = harness({}, false);
    const pull = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator = h.events({ [Symbol.asyncIterator]: () => ({ next: pull }) });
    const pending = iterator.next(); let delivered = false;
    void pending.then(() => { delivered = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toBe(false); expect(pull).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledWith('/local venv/bin/python3', [
      '-I', '-u', '-c', SENSEVOICE_PYTHON_HELPER, '/local models/声学模型', 'zh'
    ], expect.objectContaining({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }));
    expect(h.spawn.mock.calls[0]![2].env).not.toHaveProperty('OPENAI_API_KEY');
    h.child.message({ type: 'ready' });
    expect((await pending).value).toEqual({ type: 'ready', requestId: REQUEST_ID });
    h.controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.child.killed).toBe(1);
  });

  it('consumes chunks before recording ends and waits for a successful child exit before publishing final', async () => {
    vi.useFakeTimers(); const h = harness({ finalTimeoutMs: 20 });
    const finished = deferred<IteratorResult<Uint8Array>>();
    const pull = vi.fn().mockResolvedValueOnce({ done: false, value: Uint8Array.from([0xff, 0x7f, 0, 0x80]) })
      .mockReturnValue(finished.promise);
    const iterator = h.events({ [Symbol.asyncIterator]: () => ({ next: pull }) });
    await ready(iterator);
    const pending = iterator.next();
    await vi.advanceTimersByTimeAsync(100);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(h.child.chunks).toEqual([Buffer.from([0xff, 0x7f, 0, 0x80])]);
    expect(h.child.ended).toBe(false); expect(h.child.killed).toBe(0);
    finished.resolve({ done: true, value: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.child.ended).toBe(true);
    h.child.message({ type: 'final', text: '今天去散步。' });
    let delivered = false; void pending.then(() => { delivered = true; });
    await vi.advanceTimersByTimeAsync(0); expect(delivered).toBe(false);
    h.child.close();
    expect((await pending).value).toEqual({ type: 'final', requestId: REQUEST_ID, text: '今天去散步。', durationMs: 0.125 });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(h.child.killed).toBe(0); expect(h.child.eventNames()).toEqual([]);
  });

  it('handles split UTF-8 protocol messages without changing the transcript', async () => {
    vi.useFakeTimers(); const h = harness();
    h.child.onEnd = () => {
      const bytes = Buffer.from(`${JSON.stringify({ type: 'final', text: '你好，世界。' })}\n`);
      for (const byte of bytes) h.child.stdout.write(Buffer.from([byte]));
      h.child.close();
    };
    const iterator = h.events(); await ready(iterator);
    expect((await iterator.next()).value).toMatchObject({ type: 'final', text: '你好，世界。', durationMs: 200 });
    await iterator.next();
  });

  it.each([
    { pythonPath: '' }, { pythonPath: 'bad\0path' }, { modelDirectory: '' },
    { modelDirectory: 'https://models.example/model' }, { modelDirectory: 'relative/model' },
    { modelDirectory: '/bad\0path' }, { language: 'invalid' as 'zh' }
  ])('rejects unusable local configuration before starting a process: %j', async options => {
    const h = harness(options);
    await expect(h.events().next()).rejects.toMatchObject({ code: 'local_unavailable' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects invalid format and already-cancelled work before loading a model', async () => {
    const h = harness();
    await expect(h.events(audio(new Uint8Array(2)), { ...FORMAT, sampleRate: 8000 } as unknown as PcmInputFormat).next())
      .rejects.toMatchObject({ code: 'invalid_audio' });
    h.controller.abort();
    await expect(h.events().next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each([[], [new Uint8Array(0)], [new Uint8Array(3)], [new Uint8Array(SPEECH_LIMITS.maxChunkBytes + 2)],
    Array.from({ length: 10 }, () => new Uint8Array(200_000))].map(chunks => ({ chunks })))('bounds and validates PCM input without writing a recording file', async ({ chunks }) => {
    vi.useFakeTimers(); const h = harness(); const iterator = h.events(audio(...chunks));
    await ready(iterator);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(h.child.killed).toBe(1); expect(h.child.ended).toBe(false);
  });

  it('accepts exactly 60 seconds but rejects one extra sample', async () => {
    vi.useFakeTimers(); const h = harness();
    h.child.onEnd = () => h.finish();
    const chunks = Array.from({ length: 8 }, () => new Uint8Array(240_000));
    const iterator = h.events(audio(...chunks)); await ready(iterator);
    expect((await iterator.next()).value).toMatchObject({ type: 'final', durationMs: 60_000 }); await iterator.next();
    const oversized = harness(); const other = oversized.events(audio(...chunks, new Uint8Array(2))); await ready(other);
    await expect(other.next()).rejects.toMatchObject({ code: 'invalid_audio' });
    expect(oversized.child.killed).toBe(1);
  });

  it('cancels a pending audio read promptly and requests upstream cleanup once', async () => {
    vi.useFakeTimers(); const h = harness();
    const pendingAudio = deferred<IteratorResult<Uint8Array>>();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const iterator = h.events({ [Symbol.asyncIterator]: () => ({ next: () => pendingAudio.promise, return: close }) });
    await ready(iterator); const pending = iterator.next(); await vi.advanceTimersByTimeAsync(0);
    h.controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(close).toHaveBeenCalledOnce(); expect(h.child.killed).toBe(1);
    pendingAudio.resolve({ value: new Uint8Array(6400), done: false });
    await vi.advanceTimersByTimeAsync(0); expect(h.child.chunks).toEqual([]);
  });

  it('terminates an inference process on disposal, including a paused ready iterator', async () => {
    vi.useFakeTimers(); const h = harness(); const iterator = h.events(); await ready(iterator);
    h.provider.dispose(); expect(h.child.killed).toBe(1);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'cancelled' });
    await expect(h.events().next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.spawn).toHaveBeenCalledOnce();
  });

  it('cancels model loading and ignores raw spawn and runtime diagnostics', async () => {
    vi.useFakeTimers(); const h = harness({}, false);
    const iterator = h.events(); const pending = iterator.next();
    h.child.emit('error', new Error('SECRET-LOCAL-PATH transcript')); 
    await expect(pending).rejects.toMatchObject({ code: 'local_unavailable', message: 'Could not run the local SenseVoice Python process.' });
    expect(h.child.killed).toBe(1);
    const missing = harness({ spawn: () => { throw new Error('SECRET-LOCAL-PATH'); } });
    await expect(missing.events().next()).rejects.toMatchObject({ code: 'local_unavailable', message: 'Could not start the local SenseVoice Python process.' });
  });

  it.each(['load', 'write', 'final', 'capture'] as const)('kills the child on a %s deadline', async stage => {
    vi.useFakeTimers(); const h = harness({ loadTimeoutMs: 10, writeTimeoutMs: 10, finalTimeoutMs: 10 }, stage !== 'load');
    h.child.holdWrites = stage === 'write';
    const never = deferred<IteratorResult<Uint8Array>>();
    const iterator = h.events(stage === 'capture' ? { [Symbol.asyncIterator]: () => ({ next: () => never.promise }) } : undefined);
    let pending = iterator.next();
    if (stage !== 'load') { await vi.advanceTimersByTimeAsync(0); await pending; pending = iterator.next(); }
    const failed = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(stage === 'capture' ? SPEECH_LIMITS.captureMs : 10);
    await failed; expect(h.child.killed).toBe(1);
  });

  it.each([
    { type: 'ready' }, { type: 'partial', text: 'unknown' }, { type: 'final', text: 5 },
    { type: 'error', code: 'raw diagnostic with transcript' }, null
  ])('rejects invalid helper output: %j', async output => {
    vi.useFakeTimers(); const h = harness(); const iterator = h.events(); await ready(iterator);
    h.child.onEnd = () => h.child.message(output);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.child.killed).toBe(1);
  });

  it('rejects early or duplicate finals, invalid UTF-8, and oversized protocol output', async () => {
    vi.useFakeTimers();
    const outputs = [
      Buffer.from(`${JSON.stringify({ type: 'final', text: '早到。' })}\n`),
      Buffer.from([0xff, 10]), Buffer.alloc(SPEECH_LIMITS.asrMessageBytes + 1, 32)
    ];
    for (const output of outputs) {
      const h = harness(); const iterator = h.events(); await ready(iterator);
      h.child.stdout.write(output);
      await expect(iterator.next()).rejects.toMatchObject({ code: 'protocol_error' });
      expect(h.child.killed).toBe(1);
    }
    const h = harness(); h.child.onEnd = () => {
      h.child.message({ type: 'final', text: '第一次。' }); h.child.message({ type: 'final', text: '第二次。' });
    };
    const iterator = h.events(); await ready(iterator);
    await expect(iterator.next()).rejects.toMatchObject({ code: 'protocol_error' });
  });

  it.each(['missing', 'unterminated', 'failed exit', 'empty'] as const)('handles %s terminal responses', async outcome => {
    vi.useFakeTimers(); const h = harness();
    h.child.onEnd = () => {
      if (outcome === 'unterminated') h.child.stdout.write('{"type":"final","text":"incomplete"}');
      if (outcome === 'failed exit') h.child.message({ type: 'final', text: '不可交付。' });
      if (outcome === 'empty') h.child.message({ type: 'final', text: '  ' });
      h.child.close(outcome === 'failed exit' ? 1 : 0);
    };
    const iterator = h.events(); await ready(iterator);
    await expect(iterator.next()).rejects.toMatchObject({ code: outcome === 'empty' ? 'empty_result'
      : outcome === 'failed exit' ? 'local_unavailable' : 'protocol_error' });
  });

  it('maps missing Python dependencies and models to an actionable local error without a remote fallback', async () => {
    vi.useFakeTimers(); const h = harness({}, false);
    const iterator = h.events(); const pending = iterator.next();
    h.child.message({ type: 'error', code: 'local_unavailable' });
    await expect(pending).rejects.toMatchObject({ code: 'local_unavailable', requestId: REQUEST_ID });
    expect(h.spawn).toHaveBeenCalledOnce(); expect(h.child.killed).toBe(1);
  });
});

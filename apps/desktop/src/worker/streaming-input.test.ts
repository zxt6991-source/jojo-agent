import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { type AsrEvent, type SpeechAsrProvider } from '@desktop-agent/contracts';
import { type SidecarCapabilities, type SidecarEvent, type VoiceCaptureContext } from '@desktop-agent/speech';
import { createStreamingSpeechAsr, type SpeechSidecarInputClient } from './streaming-input';
import { PcmUploadStream } from './pcm-upload-stream';

const capabilities: SidecarCapabilities = { vad: { available: true }, streamingAsr: { available: true }, smartTurn: { available: false } };
const format = { codec: 'pcm16le', sampleRate: 16000, channels: 1 } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class AudioSource implements AsyncIterable<Uint8Array>, AsyncIterator<Uint8Array> {
  private readonly queued: Uint8Array[] = [];
  private pending: ((value: IteratorResult<Uint8Array>) => void) | undefined;
  private ended = false;
  requests = 0;
  returned = 0;
  push(bytes: Uint8Array): void {
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending({ done: false, value: bytes }); }
    else this.queued.push(bytes);
  }
  finish(): void { this.ended = true; this.pending?.({ done: true, value: undefined }); this.pending = undefined; }
  async next(): Promise<IteratorResult<Uint8Array>> {
    this.requests++;
    const next = this.queued.shift();
    if (next) return { done: false, value: next };
    if (this.ended) return { done: true, value: undefined };
    return new Promise(resolve => { this.pending = resolve; });
  }
  async return(): Promise<IteratorResult<Uint8Array>> { this.returned++; this.finish(); return { done: true, value: undefined }; }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return this; }
}
class Client implements SpeechSidecarInputClient {
  readonly listeners = new Set<(event: SidecarEvent) => void>();
  readonly failures = new Set<(error: Error) => void>();
  readonly opened: VoiceCaptureContext[] = [];
  readonly closed: VoiceCaptureContext[] = [];
  readonly frames: { context: VoiceCaptureContext; sequence: number; bytes: Uint8Array }[] = [];
  caps = capabilities;
  starts = 0;
  disposed = 0;
  finishCalls = 0;
  finalText: string | undefined = '这是一整句在线识别结果。';
  beforeAck: (() => Promise<void>) | undefined;
  closeGate: Promise<void> | undefined;
  async start(): Promise<SidecarCapabilities> { this.starts++; return this.caps; }
  async open(context: VoiceCaptureContext): Promise<void> { this.opened.push({ ...context }); }
  async sendAudio(context: VoiceCaptureContext, sequence: number, bytes: Uint8Array): Promise<void> {
    this.frames.push({ context: { ...context }, sequence, bytes });
    await this.beforeAck?.();
  }
  async finish(context: VoiceCaptureContext): Promise<void> {
    this.finishCalls++;
    if (this.finalText !== undefined) this.emit({ type: 'asr.final', ...context, text: this.finalText });
  }
  async close(context: VoiceCaptureContext): Promise<void> { this.closed.push({ ...context }); await this.closeGate; }
  subscribe(listener: (event: SidecarEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onFailure(listener: (error: Error) => void): () => void { this.failures.add(listener); return () => { this.failures.delete(listener); }; }
  async dispose(): Promise<void> { this.disposed++; }
  emit(event: SidecarEvent): void { for (const listener of this.listeners) listener(event); }
  disconnect(): void { for (const listener of this.failures) listener(new Error('untrusted native error/path')); }
}
function recognize(provider: SpeechAsrProvider, source: AsyncIterable<Uint8Array>, signal = new AbortController().signal, requestId = crypto.randomUUID()) {
  return provider.recognize({ requestId, format, audio: source, signal })[Symbol.asyncIterator]();
}
async function collect(iterator: AsyncIterator<AsrEvent>): Promise<AsrEvent[]> {
  const events: AsrEvent[] = [];
  for (let item = await iterator.next(); !item.done; item = await iterator.next()) events.push(item.value);
  return events;
}
async function* audio(bytes = new Uint8Array([1, 2])) { yield bytes; }

describe('persistent streaming speech input', () => {
  it('requires Smart Turn availability for explicit automatic endpoint mode', async () => {
    const client = new Client(), source = new AudioSource();
    const provider = createStreamingSpeechAsr({ createClient: () => client, autoEndpoint: true });
    await expect(collect(recognize(provider, source))).rejects.toMatchObject({ code: 'local_unavailable' });
    expect(source.requests).toBe(0); expect(client.opened).toHaveLength(0); await provider.dispose();
  });
  it('emits one scoped endpoint and still waits for capture EOF before finalizing', async () => {
    const client = new Client(), source = new AudioSource(); client.caps = { ...capabilities, smartTurn: { available: true } };
    const provider = createStreamingSpeechAsr({ createClient: () => client, autoEndpoint: true });
    const iterator = recognize(provider, source); await iterator.next();
    let received = false; const decision = iterator.next().then(value => { received = true; return value; });
    source.push(new Uint8Array(6400)); await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    const context = client.opened[0]!;
    client.emit({ type: 'vad.started', ...context, generation: 0, atMs: 20 });
    client.emit({ type: 'vad.stopped', ...context, generation: 0, atMs: 200 });
    client.emit({ type: 'turn.complete', ...context, generation: 0, score: 0.9, inferenceMs: 10 });
    await Promise.resolve(); expect(received).toBe(false);
    client.emit({ type: 'vad.started', ...context, atMs: 20 });
    client.emit({ type: 'vad.stopped', ...context, atMs: 200 });
    client.emit({ type: 'turn.complete', ...context, score: 0.9, inferenceMs: 10 });
    expect((await decision).value).toMatchObject({ type: 'endpoint', reason: 'smart_turn' });
    client.emit({ type: 'turn.complete', ...context, score: 0.99, inferenceMs: 10 });
    expect(client.finishCalls).toBe(0);
    source.finish();
    const rest = await collect(iterator);
    expect(rest.map(event => event.type)).toEqual(['final']); expect(client.finishCalls).toBe(1); await provider.dispose();
  });
  it('cancels fallback when speech resumes and uses a single fallback after model failure', async () => {
    vi.useFakeTimers();
    const client = new Client(), source = new AudioSource(); client.caps = { ...capabilities, smartTurn: { available: true } };
    const provider = createStreamingSpeechAsr({ createClient: () => client, autoEndpoint: true, fallbackTimeoutMs: 500 });
    try {
      const iterator = recognize(provider, source); await iterator.next();
      let received = false; const decision = iterator.next().then(value => { received = true; return value; });
      source.push(new Uint8Array(6400));
      const context = client.opened[0]!;
      client.emit({ type: 'vad.started', ...context, atMs: 20 });
      client.emit({ type: 'vad.stopped', ...context, atMs: 200 });
      client.emit({ type: 'turn.incomplete', ...context, score: 0.1, inferenceMs: 10 });
      await vi.advanceTimersByTimeAsync(400);
      client.emit({ type: 'vad.started', ...context, atMs: 600 });
      await vi.advanceTimersByTimeAsync(1000); expect(received).toBe(false);
      client.emit({ type: 'vad.stopped', ...context, atMs: 1800 });
      client.emit({ type: 'turn.unavailable', ...context, code: 'inference_failed' });
      await vi.advanceTimersByTimeAsync(500);
      expect((await decision).value).toMatchObject({ type: 'endpoint', reason: 'silence_timeout' });
      source.finish(); expect((await collect(iterator)).map(event => event.type)).toEqual(['final']);
      expect(vi.getTimerCount()).toBe(0);
    } finally { await provider.dispose(); vi.useRealTimers(); }
  });
  it('stays lazy, keeps one client warm across captures, and returns the online final directly', async () => {
    const client = new Client(), createClient = vi.fn(() => client);
    const provider = createStreamingSpeechAsr({ createClient });
    expect(createClient).not.toHaveBeenCalled();
    const first = await collect(recognize(provider, audio()));
    const second = await collect(recognize(provider, audio()));
    expect(first.map(event => event.type)).toEqual(['ready', 'final']);
    expect(first[1]).toMatchObject({ text: client.finalText, durationMs: 0.0625 });
    expect(second[1]).toMatchObject({ text: client.finalText });
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.opened).toHaveLength(2); expect(client.closed).toHaveLength(2);
    expect(client.opened[1]!.voiceSessionId).toBe(client.opened[0]!.voiceSessionId);
    expect(client.opened[1]!.generation).toBe(client.opened[0]!.generation + 1);
    expect(client.opened[1]!.captureId).not.toBe(client.opened[0]!.captureId);
    expect(client.disposed).toBe(0);
    await provider.dispose(); expect(client.disposed).toBe(1);
  });
  it('coalesces caption bursts, ignores stale context and observes turn events without ending capture', async () => {
    const client = new Client(), source = new AudioSource(), observed: SidecarEvent[] = [];
    const provider = createStreamingSpeechAsr({ createClient: () => client, onEvent: event => observed.push(event) });
    const iterator = recognize(provider, source);
    expect((await iterator.next()).value?.type).toBe('ready');
    const next = iterator.next();
    source.push(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    const context = client.opened[0]!;
    client.emit({ type: 'asr.partial', ...context, generation: 0, text: '旧轮文字' });
    client.emit({ type: 'asr.partial', ...context, text: '今' });
    client.emit({ type: 'asr.partial', ...context, text: '今天跑步' });
    client.emit({ type: 'turn.complete', ...context, score: 0.9, inferenceMs: 12 });
    expect((await next).value).toMatchObject({ type: 'partial', text: '今天跑步', revision: 1 });
    expect(client.finishCalls).toBe(0);
    source.finish();
    expect((await iterator.next()).value).toMatchObject({ type: 'final', text: client.finalText });
    expect((await iterator.next()).done).toBe(true);
    expect(observed.some(event => event.type === 'turn.complete')).toBe(true);
    expect(observed.some(event => 'generation' in event && event.generation === 0)).toBe(false);
    await provider.dispose();
  });
  it('waits for each sidecar ACK before requesting upstream credit and splits bounded frames', async () => {
    const client = new Client(), source = new AudioSource(), firstAck = deferred<void>();
    client.beforeAck = () => client.frames.length === 1 ? firstAck.promise : Promise.resolve();
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    const iterator = recognize(provider, source);
    await iterator.next();
    const result = iterator.next();
    source.push(new Uint8Array(70_000)); source.finish();
    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    expect(source.requests).toBe(1); expect(client.finishCalls).toBe(0);
    firstAck.resolve();
    expect((await result).value).toMatchObject({ type: 'final', durationMs: 2187.5 });
    expect(client.frames.map(frame => [frame.sequence, frame.bytes.length])).toEqual([[0, 32_000], [1, 32_000], [2, 6_000]]);
    expect(source.requests).toBe(2);
    await iterator.next(); await provider.dispose();
  });
  it('holds renderer upload credit until online ASR accepts audio and finals only after the upload end', async () => {
    class Port extends EventEmitter {
      readonly sent: unknown[] = [];
      postMessage(message: unknown): void { this.sent.push(message); }
      close(): void { this.emit('close'); }
    }
    const client = new Client(), port = new Port(), ack = deferred<void>(), controller = new AbortController();
    const binding = { captureId: 'renderer-capture', generation: 19 };
    const stream = new PcmUploadStream(port, binding, { onEnd: () => undefined, onFailure: () => controller.abort() });
    client.beforeAck = () => ack.promise;
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    const iterator = recognize(provider, stream, controller.signal);
    await iterator.next(); stream.activate();
    const partial = iterator.next();
    port.emit('message', { type: 'audio', ...binding, sequence: 1, bytes: new Uint8Array(6400) });
    port.emit('message', { type: 'end', ...binding, lastSequence: 1 });
    await vi.waitFor(() => expect(client.frames).toHaveLength(1));
    expect(port.sent).toEqual([]); expect(stream.finished).toBe(false); expect(client.finishCalls).toBe(0);
    client.emit({ type: 'asr.partial', ...client.opened[0]!, text: '一段在线字幕' });
    expect((await partial).value).toMatchObject({ type: 'partial', text: '一段在线字幕' });
    const final = iterator.next(); ack.resolve();
    expect((await final).value).toMatchObject({ type: 'final', text: client.finalText });
    expect(stream.finished).toBe(true);
    expect(port.sent).toEqual([{ type: 'ack', ...binding, sequence: 1 }]);
    await iterator.next(); stream.dispose(); await provider.dispose();
  });
  it('cancels a pending upstream read immediately and leaves only a closed capture session', async () => {
    const client = new Client(), source = new AudioSource(), controller = new AbortController();
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    const iterator = recognize(provider, source, controller.signal);
    await iterator.next();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(source.returned).toBe(1); expect(client.closed).toHaveLength(1); expect(client.disposed).toBe(0);
    expect(client.listeners.size).toBe(0); expect(client.failures.size).toBe(0);
    client.emit({ type: 'asr.final', ...client.opened[0]!, text: '取消之后' });
    expect((await collect(recognize(provider, audio()))).filter(event => event.type === 'final')).toHaveLength(1);
    await provider.dispose();
  });
  it('rejects premature finals and severe gaps rather than submitting a partial user sentence', async () => {
    for (const kind of ['final', 'gap'] as const) {
      const client = new Client(), source = new AudioSource();
      const provider = createStreamingSpeechAsr({ createClient: () => client });
      const iterator = recognize(provider, source); await iterator.next();
      const pending = iterator.next();
      const context = client.opened[0]!;
      client.emit(kind === 'final' ? { type: 'asr.final', ...context, text: '过早完成' } : { type: 'audio.gap', ...context, missingFrames: 7, turnReset: true });
      await expect(pending).rejects.toMatchObject({ code: kind === 'final' ? 'protocol_error' : 'invalid_audio' });
      expect(client.finishCalls).toBe(0); expect(source.returned).toBe(1);
      await provider.dispose();
    }
  });
  it('reports missing models without consuming audio or silently choosing another recognizer', async () => {
    const client = new Client(), source = new AudioSource();
    client.caps = { ...capabilities, streamingAsr: { available: false, reason: 'model_missing' } };
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    expect(await provider.probe()).toMatchObject({ streamingAsr: { available: false } });
    await expect(collect(recognize(provider, source))).rejects.toMatchObject({ code: 'local_unavailable' });
    expect(source.requests).toBe(0); expect(client.opened).toHaveLength(0); expect(client.frames).toHaveLength(0);
    await provider.dispose();
  });
  it('requires a nonempty final within its deadline', async () => {
    for (const text of [undefined, '   ']) {
      const client = new Client(); client.finalText = text;
      const provider = createStreamingSpeechAsr({ createClient: () => client, finalTimeoutMs: 15 });
      await expect(collect(recognize(provider, audio()))).rejects.toMatchObject({ code: text === undefined ? 'timeout' : 'empty_result' });
      expect(client.closed).toHaveLength(1);
      await provider.dispose();
    }
  });
  it('rejects duplicate finals and bounds a final whose finish write never completes', async () => {
    const client = new Client();
    client.finish = async context => {
      client.emit({ type: 'asr.final', ...context, text: '第一句' });
      client.emit({ type: 'asr.final', ...context, text: '第二句' });
    };
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    await expect(collect(recognize(provider, audio()))).rejects.toMatchObject({ code: 'protocol_error' });
    await provider.dispose();
    const blocked = new Client();
    blocked.finish = async context => {
      blocked.emit({ type: 'asr.final', ...context, text: '已经计算完成' });
      return new Promise(() => undefined);
    };
    const bounded = createStreamingSpeechAsr({ createClient: () => blocked, finalTimeoutMs: 15 });
    await expect(collect(recognize(bounded, audio()))).rejects.toMatchObject({ code: 'timeout' });
    await bounded.dispose();
  });
  it('reacts to idle process loss and rejects concurrent captures with controlled errors', async () => {
    const client = new Client(), source = new AudioSource();
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    const iterator = recognize(provider, source); await iterator.next();
    const pending = iterator.next();
    await expect(collect(recognize(provider, audio()))).rejects.toMatchObject({ code: 'resource_denied' });
    client.disconnect();
    await expect(pending).rejects.toMatchObject({ code: 'protocol_error', message: 'Local streaming speech process disconnected.' });
    expect(source.returned).toBe(1);
    await provider.dispose();
  });
  it('disposes an ambiguous close before creating a new client', async () => {
    const first = new Client(), second = new Client();
    first.closeGate = new Promise(() => undefined);
    const createClient = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const provider = createStreamingSpeechAsr({ createClient, closeTimeoutMs: 10 });
    expect((await collect(recognize(provider, audio()))).at(-1)?.type).toBe('final');
    expect(first.disposed).toBe(1);
    expect((await collect(recognize(provider, audio()))).at(-1)?.type).toBe('final');
    expect(createClient).toHaveBeenCalledTimes(2);
    await provider.dispose();
  });
  it('bounds and validates PCM and aborts on runtime disposal', async () => {
    const invalid = [new Uint8Array(0), new Uint8Array(3), new Uint8Array(256 * 1024 + 2)];
    for (const bytes of invalid) {
      const client = new Client(), provider = createStreamingSpeechAsr({ createClient: () => client });
      await expect(collect(recognize(provider, audio(bytes)))).rejects.toMatchObject({ code: 'invalid_audio' });
      expect(client.frames).toHaveLength(0); await provider.dispose();
    }
    const client = new Client(), source = new AudioSource();
    const provider = createStreamingSpeechAsr({ createClient: () => client });
    const iterator = recognize(provider, source); await iterator.next();
    const pending = iterator.next(); await provider.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.disposed).toBe(1);
    await expect(collect(recognize(provider, audio()))).rejects.toMatchObject({ code: 'cancelled' });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBufferedRealtimeTtsProvider, encodeSidecarFrame, pcm24kFromWav, SidecarFrameDecoder } from '@desktop-agent/speech';
import type { SpeechTtsProvider } from '@desktop-agent/contracts';
import { LocalTtsCandidateProcess, SherpaTtsCandidate, type TtsCandidateObservation } from './sherpa-tts-candidate';

function fixture(options: { cooperativeCancel?: boolean; cancelMode?: 'hold' | 'bad-id'; timeoutMs?: number; hold?: boolean; ready?: boolean; delayedClose?: boolean; engine?: 'cosyvoice3' | 'mlx-qwen3'; errorCode?: string; onObservation?(event: TtsCandidateObservation): void; bad?: 'sequence' | 'identity' | 'frames' | 'format' | 'duplicate' } = {}) {
  const children: Array<ReturnType<typeof makeChild>> = [];
  function makeChild() {
    const child = Object.assign(new EventEmitter(), { requests: [] as unknown[], stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn((_signal: string) => {
      if (!options.delayedClose) queueMicrotask(() => child.emit('close', null)); return true;
    }) });
    const decoder = new SidecarFrameDecoder();
    const send = (header: Record<string, unknown>, body = new Uint8Array()) => child.stdout.write(encodeSidecarFrame(header, body));
    child.stdin.on('data', (bytes: Buffer) => {
      for (const frame of decoder.push(bytes)) {
        if (frame.header.type === 'tts.cancel') {
          if (options.cancelMode !== 'hold') send({ type: 'tts.cancelled', requestId: options.cancelMode === 'bad-id' ? 'stale' : frame.header.requestId });
          continue;
        }
        child.requests.push(frame.header.requestId);
        const id = options.bad === 'identity' ? 'stale' : frame.header.requestId;
        send({ type: 'tts.started', requestId: id });
        if (options.hold) continue;
        if (options.errorCode) { send({ type: 'tts.error', requestId: id, code: options.errorCode }); continue; }
        send({ type: 'tts.callback', requestId: id, callback: 1, samples: 441, atMs: 5 });
        const pcm = { type: 'tts.pcm', requestId: id, sequence: options.bad === 'sequence' ? 2 : 1, sampleRate: options.bad === 'format' ? 44100 : 24000 };
        send(pcm, Uint8Array.of(1, 0, 2, 0));
        if (options.bad === 'duplicate') send(pcm, Uint8Array.of(1, 0));
        send({ type: 'tts.completed', requestId: id, frames: options.bad === 'frames' ? 3 : 2 });
      }
    });
    if (options.ready !== false) queueMicrotask(() => send({ type: 'tts.ready', protocolVersion: 1, sampleRate: options.engine ? 24000 : 44100, runtimeVersion: '1.13.8', loadMs: 10, ...(options.cooperativeCancel ? { cooperativeCancel: true } : {}) }));
    return child;
  }
  const spawnImpl = vi.fn((..._args: Parameters<typeof spawn>) => { const child = makeChild(); children.push(child); return child as unknown as ChildProcessWithoutNullStreams; });
  const provider = new LocalTtsCandidateProcess({ pythonPath: '/local/python3', scriptPath: '/local/tts_candidate.py', modelDirectory: '/local/models', spawn: spawnImpl as unknown as typeof spawn, timeoutMs: options.timeoutMs ?? 500,
    ...(options.engine ? { engine: options.engine, sourceDirectory: '/local/source', referenceWav: '/local/reference.wav' } : {}),
    ...(options.onObservation ? { onObservation: options.onObservation } : {}) });
  return { provider, children, spawnImpl };
}
const input = (signal = new AbortController().signal): Parameters<SpeechTtsProvider['synthesize']>[0] => ({ requestId: 'request', text: '你好。', speechRate: 0, speakerId: 'default', signal });
async function collect(provider: SpeechTtsProvider, request = input()) { const events = []; for await (const event of provider.synthesize(request)) events.push(event); return events; }

describe('experimental warm sherpa TTS candidate', () => {
  it('publishes native PCM before completion and retains the complete WAV entry point', async () => {
    const observations: TtsCandidateObservation[] = [];
    const f = fixture({ engine: 'mlx-qwen3', hold: true, onObservation: event => observations.push(event) });
    const stream = f.provider.synthesizePcm!(input())[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(observations.some(event => event.type === 'started')).toBe(true));
    const send = (header: Record<string, unknown>, body = new Uint8Array()) => f.children[0]!.stdout.write(encodeSidecarFrame({ requestId: 'request', ...header }, body));
    send({ type: 'tts.pcm', sequence: 1, sampleRate: 24000 }, Uint8Array.of(1, 0, 2, 0));
    expect(await first).toEqual({ done: false, value: { type: 'pcm', requestId: 'request', sampleRate: 24000, bytes: Uint8Array.of(1, 0, 2, 0) } });
    expect(observations.some(event => event.type === 'completed')).toBe(false);
    send({ type: 'tts.completed', frames: 2 });
    expect(await stream.next()).toEqual({ done: false, value: { type: 'completed', requestId: 'request' } });
    expect((await stream.next()).done).toBe(true);
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
    await f.provider.dispose();
  });
  it('stops reading native output while the consumer is slow and resumes without losing PCM', async () => {
    const observations: TtsCandidateObservation[] = [];
    const f = fixture({ engine: 'mlx-qwen3', hold: true, onObservation: event => observations.push(event) });
    const stream = f.provider.synthesizePcm!(input())[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(observations.some(event => event.type === 'started')).toBe(true));
    for (let sequence = 1; sequence <= 12; sequence++) {
      f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.pcm', requestId: 'request', sequence, sampleRate: 24000 }, new Uint8Array(32768).fill(sequence)));
    }
    f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.completed', requestId: 'request', frames: 12 * 16384 }));
    const received = [await first];
    await new Promise(resolve => setImmediate(resolve));
    expect(observations.filter(event => event.type === 'native_pcm').length).toBeLessThan(12);
    expect(f.children[0]!.stdout.readableLength).toBeGreaterThan(0);
    while (true) { const event = await stream.next(); if (event.done) break; received.push(event); }
    const pcm = received.flatMap(event => !event.done && event.value.type === 'pcm' ? [event.value.bytes] : []);
    expect(pcm.map(bytes => bytes[0])).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(pcm.reduce((sum, bytes) => sum + bytes.length, 0)).toBe(12 * 32768);
    expect(received.at(-1)?.value?.type).toBe('completed');
    await f.provider.dispose();
  });
  it('cancels partially streamed audio, awaits child exit, and reloads without stale frames', async () => {
    const observations: TtsCandidateObservation[] = [];
    const options = { engine: 'mlx-qwen3' as const, hold: true, delayedClose: true, onObservation: (event: TtsCandidateObservation) => observations.push(event) };
    const f = fixture(options);
    const abort = new AbortController(), stream = f.provider.synthesizePcm!(input(abort.signal))[Symbol.asyncIterator]();
    const first = stream.next();
    await vi.waitFor(() => expect(observations.some(event => event.type === 'started')).toBe(true));
    f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.pcm', requestId: 'request', sequence: 1, sampleRate: 24000 }, Uint8Array.of(1, 0)));
    expect((await first).value?.type).toBe('pcm');
    abort.abort();
    const next = stream.next(); const rejected = expect(next).rejects.toMatchObject({ code: 'cancelled' });
    let settled = false; void next.catch(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    f.children[0]!.emit('close', null); await rejected;
    options.hold = false; options.delayedClose = false;
    const recovered = await collect(f.provider, { ...input(), requestId: 'recovered' });
    const audio = recovered[0]!; if (audio.type !== 'audio') throw new Error('missing recovery audio');
    expect([...pcm24kFromWav(audio.bytes)]).toEqual([1, 0, 2, 0]);
    expect(recovered[1]).toEqual({ type: 'completed', requestId: 'recovered' });
    const native = [];
    for await (const event of f.provider.synthesizePcm!({ ...input(), requestId: 'next-native' })) native.push(event);
    expect(native.map(event => event.requestId)).toEqual(['next-native', 'next-native']);
    expect(f.provider.processesStarted).toBe(2);
    await f.provider.dispose();
  });
  it('terminates when a native consumer returns before completion', async () => {
    const observations: TtsCandidateObservation[] = [];
    const f = fixture({ engine: 'mlx-qwen3', hold: true, onObservation: event => observations.push(event) });
    const stream = f.provider.synthesizePcm!(input())[Symbol.asyncIterator](), first = stream.next();
    await vi.waitFor(() => expect(observations.some(event => event.type === 'started')).toBe(true));
    f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.pcm', requestId: 'request', sequence: 1, sampleRate: 24000 }, Uint8Array.of(1, 0)));
    await first; await stream.return?.();
    expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM');
    await f.provider.dispose();
  });
  it('warms once per live model, shares concurrent warmups, and retries after cancellation', async () => {
    const observations: TtsCandidateObservation[] = [];
    const options = { engine: 'mlx-qwen3' as const, hold: true, onObservation: (event: TtsCandidateObservation) => observations.push(event) };
    const f = fixture(options), abort = new AbortController();
    const warming = f.provider.warmup(abort.signal), cancelled = expect(warming).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(observations.some(event => event.type === 'started')).toBe(true));
    abort.abort(); await cancelled;
    options.hold = false;
    const signal = new AbortController().signal;
    await Promise.all([f.provider.warmup(signal), f.provider.warmup(signal)]);
    await f.provider.warmup(signal);
    expect(observations.filter(event => event.type === 'started')).toHaveLength(2);
    await collect(f.provider); await f.provider.warmup(signal);
    expect(observations.filter(event => event.type === 'started')).toHaveLength(3);
    expect(f.provider.processesStarted).toBe(2);
    await f.provider.dispose();
  });
  it('keeps a cooperating model warm after cancelling partially streamed audio', async () => {
    const options = { engine: 'mlx-qwen3' as const, hold: true, cooperativeCancel: true };
    const f = fixture(options), abort = new AbortController();
    const stream = f.provider.synthesizePcm!(input(abort.signal))[Symbol.asyncIterator](), first = stream.next();
    await vi.waitFor(() => expect(f.children[0]?.requests).toContain('request'));
    f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.pcm', requestId: 'request', sequence: 1, sampleRate: 24000 }, Uint8Array.of(9, 0)));
    expect((await first).value?.type).toBe('pcm'); abort.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
    options.hold = false;
    const events = await collect(f.provider, { ...input(), requestId: 'after-cancel' });
    expect(events.map(event => event.requestId)).toEqual(['after-cancel', 'after-cancel']);
    expect(f.provider.processesStarted).toBe(1); await f.provider.dispose();
  });
  it('drains a full pipe on early consumer return so cancellation can reach a blocked producer', async () => {
    const f = fixture({ engine: 'mlx-qwen3', hold: true, cooperativeCancel: true });
    const stream = f.provider.synthesizePcm!(input())[Symbol.asyncIterator](), first = stream.next();
    await vi.waitFor(() => expect(f.children[0]?.requests).toContain('request'));
    for (let sequence = 1; sequence <= 12; sequence++) f.children[0]!.stdout.write(encodeSidecarFrame({ type: 'tts.pcm', requestId: 'request', sequence, sampleRate: 24000 }, new Uint8Array(32768)));
    await first; await stream.return?.();
    expect(f.children[0]!.stdout.readableLength).toBe(0);
    expect(f.children[0]!.kill).not.toHaveBeenCalled(); await f.provider.dispose();
  });
  it('waits for the cancel barrier when normal completion crosses cancellation', async () => {
    const f = fixture({ engine: 'mlx-qwen3', hold: true, cooperativeCancel: true, cancelMode: 'hold' });
    const abort = new AbortController(), stream = f.provider.synthesizePcm!(input(abort.signal))[Symbol.asyncIterator](), first = stream.next();
    await vi.waitFor(() => expect(f.children[0]?.requests).toContain('request'));
    const send = (header: Record<string, unknown>, body = new Uint8Array()) => f.children[0]!.stdout.write(encodeSidecarFrame({ requestId: 'request', ...header }, body));
    send({ type: 'tts.pcm', sequence: 1, sampleRate: 24000 }, Uint8Array.of(1, 0)); await first;
    abort.abort(); const next = stream.next(); const assertion = expect(next).rejects.toMatchObject({ code: 'cancelled' });
    let settled = false; void next.catch(() => { settled = true; });
    send({ type: 'tts.completed', frames: 1 });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    send({ type: 'tts.cancelled' }); await assertion;
    expect(f.children[0]!.kill).not.toHaveBeenCalled(); await f.provider.dispose();
  });
  it.each(['hold', 'bad-id'] as const)('evicts a cooperating model on %s cancellation acknowledgement', async cancelMode => {
    const f = fixture({ engine: 'mlx-qwen3', hold: true, cooperativeCancel: true, cancelMode, timeoutMs: 2_000 });
    const abort = new AbortController(), attempt = collect(f.provider, input(abort.signal));
    const assertion = expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.children[0]?.requests).toContain('request')); abort.abort(); await assertion;
    expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM'); await f.provider.dispose();
  });
  it('does not evict a model when cancellation only discards audio already fully generated', async () => {
    const f = fixture({ engine: 'mlx-qwen3', cooperativeCancel: true });
    const abort = new AbortController(), stream = f.provider.synthesizePcm!(input(abort.signal))[Symbol.asyncIterator]();
    expect((await stream.next()).value?.type).toBe('pcm'); abort.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: 'cancelled' });
    expect(f.children[0]!.kill).not.toHaveBeenCalled();
    await collect(f.provider); expect(f.provider.processesStarted).toBe(1); await f.provider.dispose();
  });
  it('does not advertise native PCM for sentence-buffered candidate engines', async () => {
    for (const engine of [undefined, 'cosyvoice3'] as const) {
      const f = fixture({ ...(engine ? { engine } : {}) });
      expect(f.provider.synthesizePcm).toBeUndefined();
      await f.provider.dispose();
    }
  });
  it.each(['synthesis_limit', 'synthesis_failed', 'local_unavailable'])('preserves a controlled %s instead of reporting every error as missing system voices', async code => {
    const f = fixture({ engine: 'mlx-qwen3', errorCode: code });
    await expect(collect(f.provider)).rejects.toMatchObject({ code });
    expect(f.children[0]!.kill).toHaveBeenCalled(); await f.provider.dispose();
  });
  it('sends a neural preset through private framed stdin and reuses the model across different voices', async () => {
    const f = fixture({ engine: 'mlx-qwen3' });
    try {
      await collect(f.provider, { ...input(), speakerId: 'Serena' });
      await collect(f.provider, { ...input(), requestId: 'second', speakerId: 'Vivian' });
      expect(f.provider.processesStarted).toBe(1);
      const call = f.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(call[2].env.USE_TORCH).toBe('0'); expect(call[2].env.HF_HUB_OFFLINE).toBe('1');
      expect(call[1]).not.toContain('Serena'); expect(call[1]).not.toContain('/local/reference.wav');
      await expect(collect(f.provider, { ...input(), speechRate: 10 })).rejects.toMatchObject({ code: 'protocol_error' });
      await expect(collect(f.provider, { ...input(), speakerId: 'Tingting' })).rejects.toMatchObject({ code: 'protocol_error' });
    } finally { await f.provider.dispose(); }
  });
  it('opts in to isolated CosyVoice arguments and Torch, never changing the parent environment', async () => {
    const previous = process.env.USE_TORCH, events: TtsCandidateObservation[] = [];
    const f = fixture({ engine: 'cosyvoice3', onObservation: event => { events.push(event); } });
    try {
      await collect(f.provider);
      const call = f.spawnImpl.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(call[1]).toContain('/local/source'); expect(call[1]).toContain('/local/reference.wav');
      expect(call[2].env.USE_TORCH).toBe('1'); expect(call[2].env.TRANSFORMERS_OFFLINE).toBe('1'); expect(process.env.USE_TORCH).toBe(previous);
      expect(events.map(event => event.type)).toEqual(['started', 'native_callback', 'native_pcm', 'completed']);
      expect(events.find(event => event.type === 'native_pcm')?.samples).toBe(2);
    } finally { await f.provider.dispose(); }
  });
  it('requires explicit local source and reference paths and rejects unsupported streaming speed', async () => {
    expect(() => new LocalTtsCandidateProcess({ pythonPath: '/python', scriptPath: '/script.py', modelDirectory: '/models', engine: 'cosyvoice3' })).toThrow();
    const f = fixture({ engine: 'cosyvoice3' });
    await expect(collect(f.provider, { ...input(), speechRate: 10 })).rejects.toMatchObject({ code: 'protocol_error' });
    expect(f.spawnImpl).not.toHaveBeenCalled(); await f.provider.dispose();
  });
  it('reuses one process for complete 24k WAVs; text travels only in framed stdin', async () => {
    const f = fixture();
    try {
      const events = await collect(f.provider); await collect(f.provider, { ...input(), requestId: 'next' });
      expect(events.map(e => e.type)).toEqual(['audio', 'completed']);
      const audio = events[0]!; if (audio.type !== 'audio') throw new Error('missing audio');
      expect([...pcm24kFromWav(audio.bytes)]).toEqual([1, 0, 2, 0]);
      expect(f.provider.processesStarted).toBe(1);
      expect(f.spawnImpl).toHaveBeenCalledOnce();
      const call = f.spawnImpl.mock.calls[0] as unknown as [string, string[], { shell: boolean; env: Record<string, string> }];
      expect(call[1]).not.toContain('你好。'); expect(call[2].shell).toBe(false);
      expect(call[2].env.HF_HUB_OFFLINE).toBe('1'); expect(call[2].env.USE_TORCH).toBe('0');
      expect(Object.keys(call[2].env).sort()).toEqual(expect.arrayContaining(['PATH', 'HF_HUB_OFFLINE']));
      expect(await f.provider.probe()).toEqual({ nativeSampleRate: 44100, runtimeVersion: '1.13.8', loadMs: 10 });
    } finally { await f.provider.dispose(); }
  });
  it('awaits child exit on cancellation, discards PCM and reloads on the next request', async () => {
    const f = fixture({ hold: true, delayedClose: true }); const abort = new AbortController();
    const attempt = collect(f.provider, input(abort.signal)); const rejected = expect(attempt).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.children[0]?.stdin.readableLength).toBe(0));
    abort.abort(); let settled = false; void attempt.catch(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM'); f.children[0]!.emit('close', null); await rejected;
    const probe = f.provider.probe(); await probe; expect(f.provider.processesStarted).toBe(2);
    const closing = f.provider.dispose(); f.children[1]!.emit('close', null); await closing;
  });
  it.each(['sequence', 'identity', 'frames', 'format', 'duplicate'] as const)('rejects %s protocol corruption and releases the process', async bad => {
    const f = fixture({ bad });
    await expect(collect(f.provider)).rejects.toMatchObject({ code: 'protocol_error' });
    expect(f.children[0]!.kill).toHaveBeenCalledWith('SIGTERM'); await f.provider.dispose();
  });
  it('times out startup and supports cancellation before ready', async () => {
    for (const cancel of [false, true]) {
      const f = fixture({ ready: false }); const abort = new AbortController();
      const result = collect(f.provider, input(abort.signal));
      const rejected = expect(result).rejects.toMatchObject({ code: cancel ? 'cancelled' : 'timeout' });
      if (cancel) abort.abort(); await rejected; await f.provider.dispose();
    }
  });
  it('reports missing runtime through a controlled error', async () => {
    const provider = new SherpaTtsCandidate({ pythonPath: '/jojo-no-such-python', scriptPath: path.resolve('apps/desktop/src/worker/speech-sidecar/tts_candidate.py'), modelDirectory: '/models' });
    await expect(collect(provider)).rejects.toMatchObject({ code: 'local_unavailable' }); await provider.dispose();
  });
  it('retains honest buffered capabilities and rejects invalid input before launching', async () => {
    const f = fixture(); expect(createBufferedRealtimeTtsProvider(f.provider).capabilities).toEqual({ textStreaming: false, audioStreaming: false, wordTimings: false });
    for (const change of [{ text: 'x'.repeat(601) }, { text: '\0' }, { speechRate: 101 }, { speakerId: 'other' }]) {
      await expect(collect(f.provider, { ...input(), ...change })).rejects.toMatchObject({ code: 'protocol_error' });
    }
    expect(f.spawnImpl).not.toHaveBeenCalled(); await f.provider.dispose();
  });
});

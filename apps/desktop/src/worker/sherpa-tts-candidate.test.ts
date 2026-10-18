import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBufferedRealtimeTtsProvider, encodeSidecarFrame, pcm24kFromWav, SidecarFrameDecoder } from '@desktop-agent/speech';
import type { SpeechTtsProvider } from '@desktop-agent/contracts';
import { LocalTtsCandidateProcess, SherpaTtsCandidate, type TtsCandidateObservation } from './sherpa-tts-candidate';

function fixture(options: { hold?: boolean; ready?: boolean; delayedClose?: boolean; engine?: 'cosyvoice3' | 'mlx-qwen3'; errorCode?: string; onObservation?(event: TtsCandidateObservation): void; bad?: 'sequence' | 'identity' | 'frames' | 'format' | 'duplicate' } = {}) {
  const children: Array<ReturnType<typeof makeChild>> = [];
  function makeChild() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn((_signal: string) => {
      if (!options.delayedClose) queueMicrotask(() => child.emit('close', null)); return true;
    }) });
    const decoder = new SidecarFrameDecoder();
    const send = (header: Record<string, unknown>, body = new Uint8Array()) => child.stdout.write(encodeSidecarFrame(header, body));
    child.stdin.on('data', (bytes: Buffer) => {
      for (const frame of decoder.push(bytes)) {
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
    if (options.ready !== false) queueMicrotask(() => send({ type: 'tts.ready', protocolVersion: 1, sampleRate: options.engine ? 24000 : 44100, runtimeVersion: '1.13.8', loadMs: 10 }));
    return child;
  }
  const spawnImpl = vi.fn((..._args: Parameters<typeof spawn>) => { const child = makeChild(); children.push(child); return child as unknown as ChildProcessWithoutNullStreams; });
  const provider = new LocalTtsCandidateProcess({ pythonPath: '/local/python3', scriptPath: '/local/tts_candidate.py', modelDirectory: '/local/models', spawn: spawnImpl as unknown as typeof spawn, timeoutMs: 500,
    ...(options.engine ? { engine: options.engine, sourceDirectory: '/local/source', referenceWav: '/local/reference.wav' } : {}),
    ...(options.onObservation ? { onObservation: options.onObservation } : {}) });
  return { provider, children, spawnImpl };
}
const input = (signal = new AbortController().signal): Parameters<SpeechTtsProvider['synthesize']>[0] => ({ requestId: 'request', text: '你好。', speechRate: 0, speakerId: 'default', signal });
async function collect(provider: SpeechTtsProvider, request = input()) { const events = []; for await (const event of provider.synthesize(request)) events.push(event); return events; }

describe('experimental warm sherpa TTS candidate', () => {
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

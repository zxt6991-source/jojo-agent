import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechProviderError, SpeechSettingsSchema, type SpeechTtsProvider } from '@desktop-agent/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createBundledNeuralTts } from './bundled-neural-tts';
import type { SherpaTtsCandidateOptions } from './sherpa-tts-candidate';

const settings = SpeechSettingsSchema.parse({ provider: { tts: { id: 'mlx-qwen3', local: { pythonPath: '/local/python3', modelDirectory: '/local/model' } } } });
const request = (speakerId: string, signal = new AbortController().signal) => ({ requestId: crypto.randomUUID(), text: '你好。', speakerId, speechRate: 0, signal });
async function consume(provider: SpeechTtsProvider, input = request('default')) { const events = []; for await (const event of provider.synthesize(input)) events.push(event); return events; }
async function consumePcm(provider: SpeechTtsProvider, input = request('default')) { const events = []; for await (const event of provider.synthesizePcm!(input)) events.push(event); return events; }

describe('bundled offline neural voice', () => {
  it('materializes audited sources only for explicit synthesis and releases its shared runtime', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-bundled-neural-'));
    const fake = { synthesize: vi.fn<SpeechTtsProvider['synthesize']>(async function* (input) { yield { type: 'completed', requestId: input.requestId }; }), dispose: vi.fn(async () => undefined) };
    const createProcess = vi.fn((_options: SherpaTtsCandidateOptions) => fake), provider = createBundledNeuralTts(directory, settings, { createProcess });
    try {
      expect(await readdir(directory)).toEqual([]);
      expect(fake.synthesize).not.toHaveBeenCalled();
      await consume(provider); await consume(provider, request('Vivian'));
      expect(createProcess).toHaveBeenCalledOnce();
      const sources = createProcess.mock.calls[0]![0];
      expect(await readFile(sources.scriptPath, 'utf8')).toContain('trust_remote_code=False');
      expect(await readdir(path.dirname(sources.scriptPath))).toEqual(['mlx_tts.py', 'protocol.py']);
      await provider.dispose(); expect(fake.dispose).toHaveBeenCalledOnce();
      await expect(consume(provider)).rejects.toMatchObject({ code: 'cancelled' });
    } finally { await provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('cancels queued speech promptly without interrupting another utterance or letting the next one overtake it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-queued-neural-'));
    let release!: () => void;
    const firstGate = new Promise<void>(resolve => { release = resolve; });
    const fake = { synthesize: vi.fn<SpeechTtsProvider['synthesize']>(async function* (input) {
      if (input.speakerId === 'Serena') await firstGate;
      yield { type: 'completed', requestId: input.requestId };
    }), dispose: vi.fn(async () => undefined) };
    const provider = createBundledNeuralTts(directory, settings, { createProcess: () => fake });
    try {
      const first = consume(provider, request('Serena'));
      await vi.waitFor(() => expect(fake.synthesize).toHaveBeenCalledOnce());
      const controller = new AbortController();
      const queued = consume(provider, request('Vivian', controller.signal));
      const cancelled = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
      const third = consume(provider, request('Uncle_Fu'));
      controller.abort(); await cancelled;
      expect(fake.synthesize).toHaveBeenCalledOnce(); expect(fake.dispose).not.toHaveBeenCalled();
      release(); await Promise.all([first, third]);
      expect(fake.synthesize.mock.calls.map(([input]) => input.speakerId)).toEqual(['Serena', 'Uncle_Fu']);
    } finally { release(); await provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('shares one FIFO across WAV, native PCM, and deduplicated warmup, skipping cancelled work', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-mixed-neural-'));
    const calls: string[] = [];
    let releaseWav!: () => void, releaseWarmup!: () => void;
    const wavGate = new Promise<void>(resolve => { releaseWav = resolve; });
    const warmupGate = new Promise<void>(resolve => { releaseWarmup = resolve; });
    const fake = {
      synthesize: vi.fn<SpeechTtsProvider['synthesize']>(async function* (input) {
        calls.push('wav'); await wavGate; yield { type: 'completed', requestId: input.requestId };
      }),
      synthesizePcm: vi.fn<NonNullable<SpeechTtsProvider['synthesizePcm']>>(async function* (input) {
        calls.push(`pcm:${input.speakerId}`);
        yield { type: 'pcm', requestId: input.requestId, sampleRate: 24000, bytes: Uint8Array.of(1, 0) };
        yield { type: 'completed', requestId: input.requestId };
      }),
      warmup: vi.fn(async (_signal: AbortSignal) => { calls.push('warmup'); await warmupGate; }),
      dispose: vi.fn(async () => undefined)
    };
    const provider = createBundledNeuralTts(directory, settings, { createProcess: () => fake });
    try {
      const first = consume(provider);
      await vi.waitFor(() => expect(calls).toEqual(['wav']));
      const abort = new AbortController();
      const queued = consumePcm(provider, request('Vivian', abort.signal));
      const cancelled = expect(queued).rejects.toMatchObject({ code: 'cancelled' });
      const signal = new AbortController().signal;
      const warming = provider.warmup!(signal), joined = provider.warmup!(signal);
      const last = consumePcm(provider, request('Serena'));
      abort.abort(); await cancelled;
      expect(calls).toEqual(['wav']); expect(fake.dispose).not.toHaveBeenCalled();
      releaseWav(); await first;
      await vi.waitFor(() => expect(calls).toEqual(['wav', 'warmup']));
      releaseWarmup(); await Promise.all([warming, joined]);
      expect((await last).map(event => event.type)).toEqual(['pcm', 'completed']);
      expect(calls).toEqual(['wav', 'warmup', 'pcm:Serena']);
      expect(fake.warmup).toHaveBeenCalledOnce();
    } finally { releaseWav(); releaseWarmup(); await provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('cancels a queued warmup without cancelling active native audio and permits a later warmup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-cancel-warmup-'));
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = {
      synthesize: vi.fn<SpeechTtsProvider['synthesize']>(async function* (input) { calls.push('wav'); yield { type: 'completed', requestId: input.requestId }; }),
      synthesizePcm: vi.fn<NonNullable<SpeechTtsProvider['synthesizePcm']>>(async function* (input) {
        calls.push('pcm'); await gate;
        if (input.signal.aborted) throw new SpeechProviderError('cancelled', 'cancelled');
        yield { type: 'completed', requestId: input.requestId };
      }),
      warmup: vi.fn(async (_signal: AbortSignal) => { calls.push('warmup'); }),
      dispose: vi.fn(async () => undefined)
    };
    const provider = createBundledNeuralTts(directory, settings, { createProcess: () => fake });
    try {
      const first = consumePcm(provider);
      await vi.waitFor(() => expect(calls).toEqual(['pcm']));
      const controller = new AbortController(), warming = provider.warmup!(controller.signal);
      const cancelled = expect(warming).rejects.toMatchObject({ code: 'cancelled' });
      const next = consume(provider);
      controller.abort(); await cancelled;
      const retry = provider.warmup!(new AbortController().signal);
      expect(calls).toEqual(['pcm']); expect(fake.warmup).not.toHaveBeenCalled();
      release(); await Promise.all([first, next, retry]);
      expect(calls).toEqual(['pcm', 'wav', 'warmup']);
    } finally { release(); await provider.dispose(); await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects relative neural model paths before starting a process', () => {
    const createProcess = vi.fn();
    expect(() => createBundledNeuralTts('/unused', { ...settings, provider: { ...settings.provider, tts: { ...settings.provider.tts, local: { ...settings.provider.tts.local!, modelDirectory: 'relative/model' } } } }, { createProcess })).toThrow('路径');
    expect(createProcess).not.toHaveBeenCalled();
  });
});

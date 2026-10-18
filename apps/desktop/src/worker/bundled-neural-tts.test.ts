import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SpeechSettingsSchema, type SpeechTtsProvider } from '@desktop-agent/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createBundledNeuralTts } from './bundled-neural-tts';
import type { SherpaTtsCandidateOptions } from './sherpa-tts-candidate';

const settings = SpeechSettingsSchema.parse({ provider: { tts: { id: 'mlx-qwen3', local: { pythonPath: '/local/python3', modelDirectory: '/local/model' } } } });
const request = (speakerId: string, signal = new AbortController().signal) => ({ requestId: crypto.randomUUID(), text: '你好。', speakerId, speechRate: 0, signal });
async function consume(provider: SpeechTtsProvider, input = request('default')) { const events = []; for await (const event of provider.synthesize(input)) events.push(event); return events; }

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

  it('rejects relative neural model paths before starting a process', () => {
    const createProcess = vi.fn();
    expect(() => createBundledNeuralTts('/unused', { ...settings, provider: { ...settings.provider, tts: { ...settings.provider.tts, local: { ...settings.provider.tts.local!, modelDirectory: 'relative/model' } } } }, { createProcess })).toThrow('路径');
    expect(createProcess).not.toHaveBeenCalled();
  });
});

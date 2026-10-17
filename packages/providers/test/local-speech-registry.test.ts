import { randomUUID } from 'node:crypto';
import { createLocalSpeechSettings, SpeechSettingsSchema } from '@desktop-agent/contracts';
import { expect, it, vi } from 'vitest';
import { createSpeechProvider } from '../src/speech/registry';

it('never sends audio or text to cloud services when a selected local provider is unavailable', async () => {
  const network = vi.fn(() => { throw new Error('Cloud fallback must be explicit'); });
  vi.stubGlobal('fetch', network);
  const provider = createSpeechProvider(createLocalSpeechSettings(), { macos: { platform: 'linux' } });
  const audio = async function* () { yield Uint8Array.of(0, 0); };
  await expect(async () => {
    for await (const _event of provider.asr.recognize({ requestId: randomUUID(), audio: audio(),
      format: { codec: 'pcm16le', sampleRate: 16000, channels: 1 }, signal: new AbortController().signal })) { void _event; }
  }).rejects.toMatchObject({ code: 'local_unavailable' });
  await expect(async () => {
    for await (const _event of provider.tts.synthesize({ requestId: randomUUID(), text: '本地测试',
      speakerId: 'default', speechRate: 0, signal: new AbortController().signal })) { void _event; }
  }).rejects.toMatchObject({ code: 'local_unavailable' });
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it('rejects removed cloud providers at the runtime boundary', () => {
  const local = createLocalSpeechSettings();
  for (const kind of ['asr', 'tts'] as const) {
    const settings = { ...local, provider: { ...local.provider, [kind]: { ...local.provider[kind], id: 'doubao' } } };
    expect(SpeechSettingsSchema.safeParse(settings).success).toBe(false);
    expect(() => createSpeechProvider(settings as unknown as ReturnType<typeof createLocalSpeechSettings>)).toThrow();
  }
});

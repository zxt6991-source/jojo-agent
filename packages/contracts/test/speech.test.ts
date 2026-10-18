import {
  SpeechSettingsSchema, SpeechSettingsSnapshotSchema,
  SaveSpeechSettingsInputSchema, resolveSpeechPresetSettings, createLocalSpeechSettings, ProviderSettingsSchema, SpeechEventSchema
} from '../src';
import { describe, expect, it } from 'vitest';

describe('speech configuration boundary', () => {
  it('requires the exact Run identity on continuous-session terminal receipts', () => {
    const receipt = { type: 'session_run_finished', sessionId: 'session', outcome: 'completed' };
    expect(SpeechEventSchema.safeParse(receipt).success).toBe(false);
    expect(SpeechEventSchema.safeParse({ ...receipt, runId: 'run' }).success).toBe(true);
  });
  it('defaults every new configuration to local speech', () => {
    const local = createLocalSpeechSettings();
    expect(ProviderSettingsSchema.parse({}).speech).toEqual(local);
    expect(local).toMatchObject({ enabled: false, provider: { asr: { id: 'sensevoice' }, tts: { id: 'macos', format: 'wav', speakerId: 'default' } } });
    expect(SpeechSettingsSchema.parse({})).toEqual(local);
    expect(local.provider).not.toHaveProperty('secretRef');
  });
  it('requires the selected output provider format and keeps local configuration credential free', () => {
    const local = createLocalSpeechSettings();
    expect(SpeechSettingsSchema.safeParse({ ...local, provider: { ...local.provider, tts: { ...local.provider.tts, format: 'mp3' } } }).success).toBe(false);
    expect(SpeechSettingsSchema.safeParse({ ...local, provider: { ...local.provider, asr: { ...local.provider.asr, local: { ...local.provider.asr.local, apiKey: 'no' } } } }).success).toBe(false);
  });
  it('defaults to disabled review mode and fixed local PCM / WAV formats', () => {
    const settings = SpeechSettingsSchema.parse({});
    expect(settings).toMatchObject({
      enabled: false, inputMode: 'review', autoReadReplies: false,
      provider: {
        asr: { id: 'sensevoice', mode: 'utterance', audio: { format: 'pcm', sampleRate: 16000, channels: 1, bits: 16 } },
        tts: { id: 'macos', speakerId: 'default', format: 'wav', sampleRate: 24000, speechRate: 0 }
      }
    });
    expect(settings.provider.tts.speakerId).not.toBe('');
  });

  it.each([
    { apiKey: 'private-key' },
    { endpoint: 'https://untrusted.example' },
    { provider: { apiKey: 'private-key' } },
    { provider: { baseUrl: 'https://untrusted.example' } },
    { provider: { asr: { endpoint: 'wss://untrusted.example' } } },
    { provider: { tts: { endpoint: 'https://untrusted.example' } } },
    { provider: { asr: { id: 'doubao' } } },
    { provider: { tts: { id: 'doubao' } } },
    { provider: { id: 'doubao', protocol: 'doubao_speech_v3', secretRef: 'speech.doubao.apiKey' } },
    { provider: { asr: { resourceId: 'volc.seedasr.sauc.duration' } } },
    { provider: { tts: { mode: 'http_complete', resourceId: 'seed-tts-2.0' } } },
    { provider: { secretRef: 'terminal.apiKey' } },
    { provider: { secretRef: 'openai.apiKey' } }
  ])('rejects plaintext credentials, arbitrary endpoints and foreign secret namespaces: %j', (input) => {
    expect(SpeechSettingsSchema.safeParse(input).success).toBe(false);
  });

  it.each([-51, 101, 0.5, NaN, Infinity])('rejects unsupported speech rate %s', (speechRate) => {
    expect(SpeechSettingsSchema.safeParse({ provider: { tts: { speechRate } } }).success).toBe(false);
  });
  it.each([-50, 0, 100])('accepts supported integer speech rate %s', (speechRate) => {
    expect(SpeechSettingsSchema.parse({ provider: { tts: { speechRate } } }).provider.tts.speechRate).toBe(speechRate);
  });

  it('requires an explicit local neural runtime and supported voice with its real speed capabilities', () => {
    const tts = { id: 'mlx-qwen3', local: { pythonPath: '/local/python3', modelDirectory: '/local/model' } };
    expect(SpeechSettingsSchema.parse({ provider: { tts } }).provider.tts).toMatchObject({ ...tts, speakerId: 'default', speechRate: 0 });
    for (const change of [{ local: undefined }, { speakerId: 'Tingting' }, { speechRate: 10 }]) {
      expect(SpeechSettingsSchema.safeParse({ provider: { tts: { ...tts, ...change } } }).success).toBe(false);
    }
    expect(SpeechSettingsSchema.safeParse({ provider: { tts: { ...tts, speakerId: 'Serena' } } }).success).toBe(true);
  });

  it.each([
    { provider: { asr: { audio: { format: 'wav' } } } },
    { provider: { asr: { audio: { sampleRate: 48000 } } } },
    { provider: { asr: { audio: { channels: 2 } } } },
    { provider: { asr: { audio: { bits: 32 } } } },
    { provider: { tts: { format: 'pcm' } } },
    { provider: { tts: { sampleRate: 16000 } } },
    { playback: { quietHours: { start: '24:00', end: '07:00', timezone: 'Asia/Shanghai' } } },
    { playback: { quietHours: { start: '22:00', end: '07:00', timezone: 'Not/A_Timezone' } } }
  ])('rejects unsupported formats and quiet-hours values: %j', (input) => {
    expect(SpeechSettingsSchema.safeParse(input).success).toBe(false);
  });
  it('accepts a valid IANA quiet-hours timezone', () => {
    expect(SpeechSettingsSchema.parse({
      playback: { quietHours: { start: '22:30', end: '07:00', timezone: 'Asia/Shanghai' } }
    }).playback.quietHours?.timezone).toBe('Asia/Shanghai');
  });

  it('exposes only settings in renderer snapshots', () => {
    const settings = SpeechSettingsSchema.parse({});
    const snapshot = { settings };
    expect(SpeechSettingsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(SpeechSettingsSnapshotSchema.safeParse({ ...snapshot, apiKey: 'private-key' }).success).toBe(false);
    expect(SpeechSettingsSnapshotSchema.safeParse({ ...snapshot, hasKey: true }).success).toBe(false);
    expect(SpeechSettingsSnapshotSchema.safeParse({ settings: { ...settings, apiKey: 'private-key' }, hasKey: true }).success).toBe(false);
  });

  it('accepts only settings updates and rejects obsolete key update fields', () => {
    const settings = SpeechSettingsSchema.parse({});
    expect(SaveSpeechSettingsInputSchema.parse({ settings })).toEqual({ settings });
    expect(SaveSpeechSettingsInputSchema.safeParse({ settings, apiKey: 'new-key' }).success).toBe(false);
    expect(SaveSpeechSettingsInputSchema.safeParse({ settings, removeKey: true }).success).toBe(false);
    expect(SaveSpeechSettingsInputSchema.safeParse({ settings, apiKey: 'new-key', removeKey: true }).success).toBe(false);
    expect(SaveSpeechSettingsInputSchema.safeParse({ settings, apiKey: '   ' }).success).toBe(false);
  });

  it('keeps bounded independent voice presets with unique stable ids and no credential fields', () => {
    const preset = { id: 'morning', name: '早间提醒', speakerId: 'morning-speaker', speechRate: 15 };
    expect(SpeechSettingsSchema.parse({}).voicePresets).toEqual([]);
    expect(SpeechSettingsSchema.parse({ voicePresets: [preset] }).voicePresets).toEqual([preset]);
    for (const voicePresets of [[preset, preset], [{ ...preset, apiKey: 'secret' }], [{ ...preset, id: '../bad' }],
      [{ ...preset, speechRate: 0.5 }], Array.from({ length: 21 }, (_, index) => ({ ...preset, id: `preset-${index}` }))]) {
      expect(SpeechSettingsSchema.safeParse({ voicePresets }).success).toBe(false);
    }
  });

  it('resolves only the selected voice parameters and refuses deleted presets instead of falling back', () => {
    const settings = SpeechSettingsSchema.parse({ voicePresets: [{ id: 'morning', name: '早间', speakerId: 'morning-speaker', speechRate: -10 }] });
    const resolved = resolveSpeechPresetSettings(settings, 'morning');
    expect(resolved.provider.tts).toEqual({ ...settings.provider.tts, speakerId: 'morning-speaker', speechRate: -10 });
    expect(resolved.provider.asr).toBe(settings.provider.asr);
    expect(settings.provider.tts.speakerId).not.toBe('morning-speaker');
    expect(resolveSpeechPresetSettings(settings)).toBe(settings);
    expect(() => resolveSpeechPresetSettings(settings, 'deleted')).toThrowError(expect.objectContaining({ code: 'speaker_unavailable' }));
  });
});

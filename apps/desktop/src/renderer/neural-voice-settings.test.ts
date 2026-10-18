import { describe, expect, it } from 'vitest';
import { SpeechSettingsSchema } from '@desktop-agent/contracts';
import { changeSpeechEngine, neuralVoiceLocation } from './neural-voice-settings';

describe('offline neural voice selection', () => {
  const system = SpeechSettingsSchema.parse({ enabled: true, provider: { asr: { local: { pythonPath: '/my speech/venv/bin/python3' } }, tts: { speakerId: 'Tingting', speechRate: 10 } } });
  it('suggests the isolated runtime beside an existing installation without file access', () => {
    expect(neuralVoiceLocation(system)).toEqual({ pythonPath: '/my speech/venv-mlx-tts/bin/python3', modelDirectory: '/my speech/models/Qwen3-TTS-0.6B-4bit' });
  });
  it('keeps speech enabled when switching engines, resets incompatible voice/rate, and preserves independent presets', () => {
    const configured = { ...system, voicePresets: [{ id: 'work', name: '工作', speakerId: 'Tingting', speechRate: 20 }] };
    const neural = changeSpeechEngine(configured, 'mlx-qwen3');
    expect(neural.enabled).toBe(true);
    expect(neural.provider.tts).toMatchObject({ id: 'mlx-qwen3', speakerId: 'default', speechRate: 0 });
    expect(SpeechSettingsSchema.safeParse(neural).success).toBe(true);
    expect(neural.voicePresets).toEqual(configured.voicePresets);
    expect(configured.provider.tts.speakerId).toBe('Tingting');
    expect(changeSpeechEngine(neural, 'macos').provider.tts).toMatchObject({ id: 'macos', speakerId: 'default' });
  });
  it('retains a manually configured installation when switching engines', () => {
    const saved = SpeechSettingsSchema.parse({ provider: { tts: { local: { pythonPath: '/custom/python3', modelDirectory: '/custom/voice' } } } });
    expect(changeSpeechEngine(saved, 'mlx-qwen3').provider.tts.local).toEqual(saved.provider.tts.local);
  });
});

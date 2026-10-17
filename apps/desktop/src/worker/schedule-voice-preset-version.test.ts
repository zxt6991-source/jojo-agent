import { createHash } from 'node:crypto';
import { createLocalSpeechSettings, SpeechSettingsSchema } from '@desktop-agent/contracts';
import { describe, expect, it } from 'vitest';
import { scheduleVoicePresetVersion } from './schedule-desktop-delivery';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('schedule voice snapshot versions', () => {
  it('versions the default local recognition and voice configuration', () => {
    const settings = createLocalSpeechSettings();
    expect(scheduleVoicePresetVersion(settings)).toBe(hash(settings.provider));
    const version = scheduleVoicePresetVersion(settings);
    settings.provider.asr.local.modelDirectory = '/another/local/model';
    expect(scheduleVoicePresetVersion(settings)).not.toBe(version);
  });

  it('versions a named preset using its resolved synthesis configuration', () => {
    const settings = SpeechSettingsSchema.parse({ voicePresets: [
      { id: 'morning', name: 'Morning', speakerId: 'another-system-voice', speechRate: 15 }
    ] });
    const tts = { ...settings.provider.tts, speakerId: 'another-system-voice', speechRate: 15 };
    expect(scheduleVoicePresetVersion(settings, 'morning')).toBe(hash(tts));
    settings.voicePresets[0]!.speechRate = 20;
    expect(scheduleVoicePresetVersion(settings, 'morning')).not.toBe(hash(tts));
  });

  it('keeps a named preset stable when only default voice or local ASR changes', () => {
    const settings = SpeechSettingsSchema.parse({ voicePresets: [{ id: 'morning', name: 'Morning', speakerId: 'system-voice' }] });
    const version = scheduleVoicePresetVersion(settings, 'morning');
    settings.provider.tts.speechRate = 35;
    settings.provider.asr.local.modelDirectory = '/another/model';
    expect(scheduleVoicePresetVersion(settings, 'morning')).toBe(version);
    expect(() => scheduleVoicePresetVersion(settings, 'missing')).toThrow();
  });
});

import { SpeechSettingsSchema, type SpeechSettings } from '@desktop-agent/contracts';
import { createSenseVoiceAsrProvider, type SenseVoiceAsrOptions } from './sensevoice-asr-adapter.js';
import { createMacosTtsProvider, type MacosTtsOptions } from './macos-tts.js';

export interface SpeechProviderOptions {
  sensevoice?: Omit<SenseVoiceAsrOptions, 'pythonPath' | 'modelDirectory' | 'language'>;
  macos?: MacosTtsOptions;
}

/** Recognition and synthesis execute locally without service credentials. */
export function createSpeechProvider(settings: SpeechSettings, options: SpeechProviderOptions = {}) {
  const parsed = SpeechSettingsSchema.parse(settings);
  return {
    asr: createSenseVoiceAsrProvider({ ...options.sensevoice, ...parsed.provider.asr.local }),
    tts: createMacosTtsProvider(options.macos)
  };
}

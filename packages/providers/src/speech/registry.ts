import { SpeechProviderError, SpeechSettingsSchema, type SpeechSettings, type SpeechTtsProvider } from '@desktop-agent/contracts';
import { createSenseVoiceAsrProvider, type SenseVoiceAsrOptions } from './sensevoice-asr-adapter.js';
import { createMacosTtsProvider, type MacosTtsOptions } from './macos-tts.js';

export interface SpeechProviderOptions {
  sensevoice?: Omit<SenseVoiceAsrOptions, 'pythonPath' | 'modelDirectory' | 'language'>;
  macos?: MacosTtsOptions;
  /** Host-owned offline neural runtime. It must never fall back to a different voice. */
  neuralTts?: SpeechTtsProvider;
}

/** Recognition and synthesis execute locally without service credentials. */
export function createSpeechProvider(settings: SpeechSettings, options: SpeechProviderOptions = {}) {
  const parsed = SpeechSettingsSchema.parse(settings);
  return {
    asr: createSenseVoiceAsrProvider({ ...options.sensevoice, ...parsed.provider.asr.local }),
    tts: parsed.provider.tts.id === 'macos' ? createMacosTtsProvider(options.macos) : options.neuralTts ?? {
      async *synthesize() { // eslint-disable-line require-yield
        throw new SpeechProviderError('local_unavailable', '本机自然声音尚未安装，请检查离线模型与运行环境。');
      }
    }
  };
}

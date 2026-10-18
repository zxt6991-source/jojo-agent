import type { SpeechSettings } from '@desktop-agent/contracts';

export const NEURAL_VOICE_LABELS: Record<string, string> = {
  Serena: 'Serena · 温柔女声', Vivian: 'Vivian · 明亮女声', Uncle_Fu: 'Uncle Fu · 沉稳男声',
  Dylan: 'Dylan · 北京男声', Eric: 'Eric · 四川男声', Ryan: 'Ryan · 英语男声',
  Aiden: 'Aiden · 英语男声', Ono_Anna: 'Anna · 日语女声', Sohee: 'Sohee · 韩语女声'
};

/** Reuse the user's existing local-speech installation layout when recognizable.
 * These are editable suggestions; the Renderer never discovers or accesses files. */
export function neuralVoiceLocation(settings: SpeechSettings): NonNullable<SpeechSettings['provider']['tts']['local']> {
  if (settings.provider.tts.local) return settings.provider.tts.local;
  const asr = settings.provider.asr.local;
  const root = asr.pythonPath.match(/^(.*)\/venv\/bin\/python(?:3(?:\.\d+)?)?$/u)?.[1]
    ?? asr.modelDirectory.match(/^(.*)\/models\/[^/]+\/?$/u)?.[1];
  return { pythonPath: root ? `${root}/venv-mlx-tts/bin/python3` : 'python3', modelDirectory: root ? `${root}/models/Qwen3-TTS-0.6B-4bit` : '' };
}

export function changeSpeechEngine(settings: SpeechSettings, id: SpeechSettings['provider']['tts']['id']): SpeechSettings {
  if (id === settings.provider.tts.id) return settings;
  return { ...settings, provider: { ...settings.provider, tts: {
    ...settings.provider.tts, id, speakerId: 'default', speechRate: 0,
    ...(id === 'mlx-qwen3' ? { local: neuralVoiceLocation(settings) } : {})
  } } };
}

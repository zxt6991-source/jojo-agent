function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Compatibility applies only when reading persisted settings, never to new API input. */
export function migrateStoredSpeechSettings(value: unknown): unknown {
  const settings = record(value);
  const provider = record(settings?.provider);
  if (!settings || !provider) return value;
  const asr = record(provider.asr);
  const tts = record(provider.tts);
  const legacy = provider.id === 'doubao' || provider.protocol === 'doubao_speech_v3'
    || provider.secretRef === 'speech.doubao.apiKey' || asr?.id === 'doubao' || tts?.id === 'doubao';
  if (!legacy) return value;

  // Unsupported or malformed legacy fields still reach the strict schema unchanged.
  if ((provider.id !== undefined && provider.id !== 'doubao')
    || (provider.protocol !== undefined && provider.protocol !== 'doubao_speech_v3')
    || (provider.secretRef !== undefined && provider.secretRef !== 'speech.doubao.apiKey')
    || (asr?.resourceId !== undefined && asr.resourceId !== 'volc.seedasr.sauc.duration')
    || (tts?.mode !== undefined && tts.mode !== 'http_complete')
    || (tts?.resourceId !== undefined && tts.resourceId !== 'seed-tts-2.0')) return value;
  const localProvider = { ...provider };
  delete localProvider.id; delete localProvider.protocol; delete localProvider.secretRef;
  const localAsr = { ...asr };
  delete localAsr.resourceId;
  const localTts = { ...tts };
  delete localTts.resourceId; delete localTts.mode;
  const cloudAsr = !asr?.id || asr.id === 'doubao';
  const cloudTts = !tts?.id || tts.id === 'doubao';
  return {
    ...settings,
    enabled: cloudAsr || cloudTts ? false : settings.enabled,
    ...(cloudTts && Array.isArray(settings.voicePresets) ? {
      voicePresets: settings.voicePresets.map(preset => {
        const saved = record(preset);
        return saved ? { ...saved, speakerId: 'default' } : preset;
      })
    } : {}),
    provider: {
      ...localProvider,
      asr: { ...localAsr, ...(cloudAsr ? { id: 'sensevoice' } : {}) },
      tts: { ...localTts, ...(cloudTts ? { id: 'macos', speakerId: 'default', format: 'wav' } : {}) }
    }
  };
}

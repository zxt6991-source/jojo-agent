import {
  SaveSpeechSettingsInputSchema, SpeechSettingsSnapshotSchema,
  type SpeechSettings, type SpeechSettingsSnapshot
} from '@desktop-agent/contracts';
import type { JsonConfigStore } from '@desktop-agent/storage';

export interface SpeechSettingsContext {
  configStore: JsonConfigStore;
  readApiKeys: () => Promise<Record<string, string>>;
  pushConfig: () => Promise<void>;
  /** Host-owned verification of local recognition and the selected voice. */
  validateEnabled?: (settings: SpeechSettings) => Promise<void>;
}

function settingsError(message: string): Error {
  return Object.assign(new Error(message), { code: 'speech_settings_error' });
}

export function createSpeechSettingsController(ctx: SpeechSettingsContext) {
  let mutation: Promise<unknown> = Promise.resolve();
  async function get(): Promise<SpeechSettingsSnapshot> {
    const settings = await ctx.configStore.get(await ctx.readApiKeys());
    return SpeechSettingsSnapshotSchema.parse({ settings: settings.speech });
  }

  function save(raw: unknown): Promise<SpeechSettingsSnapshot> {
    const input = SaveSpeechSettingsInputSchema.parse(raw);
    const result = mutation.then(async () => {
      const previous = await ctx.configStore.get(await ctx.readApiKeys());
      const unchangedEnabledResource = previous.speech.enabled
        && JSON.stringify(previous.speech.provider) === JSON.stringify(input.settings.provider);
      if (input.settings.enabled) {
        if (!unchangedEnabledResource) {
          if (!ctx.validateEnabled) throw settingsError('语音资源与音色尚未验证，暂时无法启用语音。');
          await ctx.validateEnabled(input.settings);
        }
      }

      // Only this controller owns speech settings writes, after local validation.
      const current = await ctx.configStore.get(await ctx.readApiKeys());
      await ctx.configStore.save({ ...current, speech: input.settings });
      await ctx.pushConfig();
      return get();
    });
    mutation = result.catch(() => undefined);
    return result;
  }
  return { get, save };
}

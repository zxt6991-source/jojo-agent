import {
  SaveSpeechSettingsInputSchema, SpeechSettingsSnapshotSchema,
  type SpeechSettingsSnapshot
} from '@desktop-agent/contracts';
import type { JsonConfigStore } from '@desktop-agent/storage';

export interface SpeechSettingsContext {
  configStore: JsonConfigStore;
  readApiKeys: () => Promise<Record<string, string>>;
  pushConfig: () => Promise<void>;
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
      // Saving the selected preferences is sufficient. Runtime availability is
      // checked when recognition or synthesis is actually requested.
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

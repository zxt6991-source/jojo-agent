import { SpeechSettingsSchema, createLocalSpeechSettings } from '@desktop-agent/contracts';
import { JsonConfigStore } from '@desktop-agent/storage';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSpeechSettingsController } from './speech-settings';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup(validateEnabled?: (settings: ReturnType<typeof SpeechSettingsSchema.parse>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-settings-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const configStore = new JsonConfigStore(file);
  const pushConfig = vi.fn(async () => undefined);
  const controller = createSpeechSettingsController({
    configStore, pushConfig, readApiKeys: async () => ({ openai: 'text-provider-key' }),
    ...(validateEnabled ? { validateEnabled } : {})
  });
  return { file, controller, configStore, pushConfig };
}

it('saves local settings and preserves unrelated text provider configuration', async () => {
  const { controller, file, configStore, pushConfig } = await setup();
  const before = await configStore.get({ openai: 'text-provider-key' });
  const settings = SpeechSettingsSchema.parse({ provider: { tts: { speechRate: 20 } }, playback: { volume: 0.7 } });
  const snapshot = await controller.save({ settings });
  expect(snapshot).toEqual({ settings });
  expect(await controller.get()).toEqual(snapshot);
  expect(JSON.parse(await readFile(file, 'utf8')).speech).toEqual(settings);
  expect(await configStore.get({ openai: 'text-provider-key' })).toEqual({ ...before, speech: settings });
  expect(pushConfig).toHaveBeenCalledTimes(1);
});

it('enables local speech only after explicit recognition and synthesis tests', async () => {
  const validate = vi.fn(async () => undefined);
  const { controller, file } = await setup(validate);
  const local = createLocalSpeechSettings();
  local.provider.asr.local.modelDirectory = '/local/SenseVoiceSmall';
  await expect(controller.save({ settings: local })).resolves.toEqual({ settings: local });
  expect(validate).not.toHaveBeenCalled();
  const enabled = { ...local, enabled: true };
  await expect(controller.save({ settings: enabled })).resolves.toEqual({ settings: enabled });
  expect(validate).toHaveBeenCalledWith(enabled);
  expect(JSON.parse(await readFile(file, 'utf8')).speech).toEqual(enabled);
  const unverified = await setup();
  await expect(unverified.controller.save({ settings: enabled })).rejects.toThrow('尚未验证');
});

it('rejects unverified local resources without changing files or pushing configuration', async () => {
  const { controller, pushConfig, file } = await setup();
  const settings = SpeechSettingsSchema.parse({ enabled: true });
  await expect(controller.save({ settings })).rejects.toMatchObject({ code: 'speech_settings_error' });
  expect(pushConfig).not.toHaveBeenCalled();
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not save or publish a failed local validation', async () => {
  const validate = vi.fn(async () => { throw new Error('Local model unavailable'); });
  const { controller, pushConfig, file } = await setup(validate);
  await expect(controller.save({ settings: SpeechSettingsSchema.parse({ enabled: true }) })).rejects.toThrow('Local model unavailable');
  expect(pushConfig).not.toHaveBeenCalled();
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects unexpected credentials rather than storing them inside speech settings', async () => {
  const { controller, pushConfig } = await setup();
  const settings = SpeechSettingsSchema.parse({});
  expect(() => controller.save({ settings: { ...settings, apiKey: 'leaked' } })).toThrow();
  expect(() => controller.save({ settings, apiKey: 'obsolete-key' })).toThrow();
  expect(() => controller.save({ settings, removeKey: true })).toThrow();
  expect(pushConfig).not.toHaveBeenCalled();
});

it('preserves an enabled local provider across restart when saving playback preferences', async () => {
  const { controller, configStore } = await setup();
  const existing = await configStore.get({});
  const enabled = SpeechSettingsSchema.parse({ enabled: true });
  await configStore.save({ ...existing, speech: enabled });
  const preferences = { ...enabled, inputMode: 'auto_send' as const, autoReadReplies: true,
    playback: { ...enabled.playback, volume: 0.5 } };
  await expect(controller.save({ settings: preferences })).resolves.toEqual({ settings: preferences });
  await expect(controller.save({ settings: { ...preferences, provider: { ...preferences.provider,
    tts: { ...preferences.provider.tts, speechRate: 15 } } } })).rejects.toThrow('尚未验证');
  expect((await controller.get()).settings).toEqual(preferences);
});

import { SpeechSettingsSchema, createLocalSpeechSettings } from '@desktop-agent/contracts';
import { JsonConfigStore } from '@desktop-agent/storage';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSpeechSettingsController } from './speech-settings';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-settings-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const configStore = new JsonConfigStore(file);
  const pushConfig = vi.fn(async () => undefined);
  const controller = createSpeechSettingsController({
    configStore, pushConfig, readApiKeys: async () => ({ openai: 'text-provider-key' })
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

it('enables speech on save without prior recording or listening tests', async () => {
  const { controller, file, pushConfig } = await setup();
  const local = createLocalSpeechSettings();
  local.provider.asr.local.modelDirectory = '/local/SenseVoiceSmall';
  await expect(controller.save({ settings: local })).resolves.toEqual({ settings: local });
  const enabled = { ...local, enabled: true };
  await expect(controller.save({ settings: enabled })).resolves.toEqual({ settings: enabled });
  expect(JSON.parse(await readFile(file, 'utf8')).speech).toEqual(enabled);
  expect(pushConfig).toHaveBeenCalledTimes(2);
});

it('saves selected resource locations without starting recognition or synthesis', async () => {
  const { controller, pushConfig, file } = await setup();
  const settings = SpeechSettingsSchema.parse({ enabled: true, provider: { asr: { local: { pythonPath: '/not-installed/python3', modelDirectory: '/not-installed/model' } } } });
  await expect(controller.save({ settings })).resolves.toEqual({ settings });
  expect(pushConfig).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(file, 'utf8')).speech).toEqual(settings);
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
  const changedVoice = { ...preferences, provider: { ...preferences.provider, tts: { ...preferences.provider.tts, speechRate: 15 } } };
  await expect(controller.save({ settings: changedVoice })).resolves.toEqual({ settings: changedVoice });
  expect((await controller.get()).settings.enabled).toBe(true);
  const streaming = { ...changedVoice, streamingInput: { enabled: true, vadModel: '/vad.onnx', paraformerDirectory: '/online' } };
  await expect(controller.save({ settings: streaming })).resolves.toEqual({ settings: streaming });
});

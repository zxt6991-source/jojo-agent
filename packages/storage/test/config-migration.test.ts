import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProviderSettingsSchema, SpeechSettingsSchema, createLocalSpeechSettings } from '@desktop-agent/contracts';
import { JsonConfigStore } from '../src/index.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
it.each([1, 2, 3])('migrates v%i to v5 without freezing legacy limits or losing selections', async (version) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-migration-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const stored = version < 3 ? { schemaVersion: version, provider: { baseUrl: 'https://example.test/v1', model: 'a', models: ['a', 'b'] } } : {
    schemaVersion: 3, activeProviderId: 'custom', providers: [{ id: 'custom', name: 'Custom', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', model: 'a', models: ['a', 'b'], contextWindowTokens: 64_000, maxOutputTokens: 4_096 }], utilityModel: { providerId: 'custom', model: 'b' }, permissions: { mode: 'auto' }
  };
  await writeFile(file, JSON.stringify(stored));
  const store = new JsonConfigStore(file);
  const migrated = await store.get({ openai: 'sensitive-key-value', custom: 'sensitive-key-value' });
  expect(migrated.speech).toEqual(createLocalSpeechSettings());
  expect(migrated.speech.enabled).toBe(false);
  expect(migrated.providers[0]?.hasApiKey).toBe(true);
  expect(migrated.providers[0]?.model).toBe('a');
  expect(migrated.providers[0]?.models[0]).toMatchObject({ id: 'a', discovered: { contextSource: 'fallback', maxOutputSource: 'fallback' } });
  expect(migrated.providers[0]?.models[0]?.override).toBeUndefined();
  if (version === 3) {
    expect(migrated.utilityModel).toEqual({ providerId: 'custom', model: 'b' });
    expect(migrated.providers[0]?.models[1]?.discovered.contextWindowTokens).toBe(64_000);
    expect(migrated.permissions.mode).toBe('auto');
  }
  await store.save(migrated);
  const serialized = await readFile(file, 'utf8');
  expect(JSON.parse(serialized).schemaVersion).toBe(5);
  expect(serialized).not.toContain('sensitive-key-value');
  expect(serialized).not.toContain('hasApiKey');
  expect(await store.get({ openai: 'sensitive-key-value', custom: 'sensitive-key-value' })).toEqual(migrated);
});

it('migrates literal v4 while retaining model metadata, permissions, memory and extensions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-v4-migration-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const original = ProviderSettingsSchema.parse({});
  original.providers[0]!.models[0]!.override = { contextWindowTokens: 96_000, maxOutputTokens: 2_000 };
  original.permissions.mode = 'yolo';
  original.memory.enabled = false;
  original.extensions.skills.directories = ['/custom/skills'];
  const legacy = { ...original, speech: undefined };
  await writeFile(file, JSON.stringify({ ...legacy, schemaVersion: 4 }));
  const store = new JsonConfigStore(file);
  const migrated = await store.get();
  expect(migrated).toEqual(original);
  await store.save(migrated);
  const serialized = JSON.parse(await readFile(file, 'utf8'));
  expect(serialized.schemaVersion).toBe(5);
  expect(serialized.speech).toEqual(createLocalSpeechSettings());
  expect(await store.get()).toEqual(original);
});

it('round trips v5 speech settings and keeps the ordinary config credential free', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-v5-config-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const store = new JsonConfigStore(file);
  const original = await store.get();
  original.speech = SpeechSettingsSchema.parse({
    enabled: true, inputMode: 'auto_send', autoReadReplies: true,
    provider: { tts: { speakerId: 'custom-speaker', speechRate: 15 } },
    playback: { volume: 0.4, quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Shanghai' } }
  });
  await store.save(original);
  expect(await store.get()).toEqual(original);
  const serialized = await readFile(file, 'utf8');
  expect(serialized).not.toContain('speech.doubao.apiKey');
  expect(serialized).not.toContain('"apiKey":');
  expect(serialized).not.toContain('hasKey');
});

it.each(['local', 'cloud', 'cloud-asr', 'cloud-tts'] as const)('migrates the removed speech configuration for %s providers without resetting other settings', async mode => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-local-migration-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const original = ProviderSettingsSchema.parse({});
  original.permissions.mode = 'yolo';
  original.extensions.skills.directories = ['/saved/skills'];
  original.speech = SpeechSettingsSchema.parse({
    enabled: true, inputMode: 'auto_send', autoReadReplies: true, backgroundRunning: true,
    inputDeviceId: 'saved-input',
    voicePresets: [{ id: 'morning', name: 'Morning', speakerId: 'Tingting', speechRate: 20 }],
    provider: {
      asr: { local: { pythonPath: '/saved/python3', modelDirectory: '/saved/models', language: 'zh' } },
      tts: { speakerId: 'Tingting', speechRate: 15 }
    },
    playback: { volume: 0.4, muteWhenLocked: false, quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Shanghai' } }
  });
  const legacy = {
    ...original.speech,
    provider: {
      id: 'doubao', protocol: 'doubao_speech_v3', secretRef: 'speech.doubao.apiKey',
      asr: { ...original.speech.provider.asr, id: mode === 'cloud' || mode === 'cloud-asr' ? 'doubao' : 'sensevoice', resourceId: 'volc.seedasr.sauc.duration' },
      tts: { ...original.speech.provider.tts, ...(mode === 'cloud' || mode === 'cloud-tts' ? { id: 'doubao', format: 'mp3', speakerId: 'cloud-voice' } : {}), mode: 'http_complete', resourceId: 'seed-tts-2.0' }
    }
  };
  await writeFile(file, JSON.stringify({ ...original, schemaVersion: 5, speech: legacy }));
  const store = new JsonConfigStore(file);
  const migrated = await store.get();
  const expected = structuredClone(original);
  if (mode !== 'local') expected.speech.enabled = false;
  if (mode === 'cloud' || mode === 'cloud-tts') {
    expected.speech.provider.tts.speakerId = 'default';
    expected.speech.voicePresets[0]!.speakerId = 'default';
  }
  expect(migrated).toEqual(expected);
  await store.save(migrated);
  expect(await store.get()).toEqual(expected);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  expect(persisted.schemaVersion).toBe(5);
  expect(JSON.stringify(persisted.speech)).not.toMatch(/doubao|secretRef|resourceId|http_complete/u);
});

it('migrates old implicit cloud defaults only at the persisted configuration boundary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'speech-implicit-migration-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const original = ProviderSettingsSchema.parse({});
  const speech = { enabled: true, provider: { id: 'doubao', tts: { speakerId: 'old-cloud-voice' } } };
  expect(SpeechSettingsSchema.safeParse(speech).success).toBe(false);
  await writeFile(file, JSON.stringify({ ...original, schemaVersion: 5, speech }));
  expect(await new JsonConfigStore(file).get()).toEqual(original);
});

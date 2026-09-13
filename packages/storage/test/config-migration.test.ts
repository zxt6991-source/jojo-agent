import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { JsonConfigStore } from '../src/index.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
it.each([1, 2, 3])('migrates v%i to v4 without freezing legacy limits or losing selections', async (version) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-migration-')); directories.push(directory);
  const file = path.join(directory, 'config.json');
  const stored = version < 3 ? { schemaVersion: version, provider: { baseUrl: 'https://example.test/v1', model: 'a', models: ['a', 'b'] } } : {
    schemaVersion: 3, activeProviderId: 'custom', providers: [{ id: 'custom', name: 'Custom', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', model: 'a', models: ['a', 'b'], contextWindowTokens: 64_000, maxOutputTokens: 4_096 }], utilityModel: { providerId: 'custom', model: 'b' }, permissions: { mode: 'auto' }
  };
  await writeFile(file, JSON.stringify(stored));
  const store = new JsonConfigStore(file);
  const migrated = await store.get({ openai: 'secret', custom: 'secret' });
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
  expect(JSON.parse(serialized).schemaVersion).toBe(4);
  expect(serialized).not.toContain('secret');
  expect(serialized).not.toContain('hasApiKey');
  expect(await store.get({ openai: 'secret', custom: 'secret' })).toEqual(migrated);
});

import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonConfigStore, JsonlSessionStore } from '../src/index.js';

describe('JsonlSessionStore', () => {
  it('recovers complete records before a damaged tail', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-store-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create('Test', directory);
    await store.appendMessage(session.id, {
      id: 'm1', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text: 'hello' }]
    });
    await appendFile(path.join(directory, `${session.id}.jsonl`), '{"broken":');
    const loaded = await store.load(session.id);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.warnings).toHaveLength(1);
  });

  it('prevents concurrent turns for one session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-lock-'));
    const store = new JsonlSessionStore(directory);
    const release = store.acquire('one');
    expect(() => store.acquire('one')).toThrow(/already running/);
    release();
    expect(() => store.acquire('one')).not.toThrow();
  });

  it('uses the first prompt as the displayed title until the user renames the session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-title-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create(path.basename(directory), directory);
    await store.appendMessage(session.id, {
      id: 'm1', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text: '  分析这个项目\n并给出建议  ' }]
    });

    expect((await store.list())[0]?.title).toBe('分析这个项目 并给出建议');
    await store.rename(session.id, '手动标题');
    expect((await store.list())[0]?.title).toBe('手动标题');
  });
});

describe('JsonConfigStore', () => {
  it('migrates a single-model v1 config to the model list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-'));
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      provider: { baseUrl: 'https://provider.example/v1', model: 'legacy-model' }
    }));

    await expect(new JsonConfigStore(file).get(true)).resolves.toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'legacy-model',
      models: ['legacy-model'],
      hasApiKey: true
    });
  });

  it('persists multiple models in the v2 config format', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-'));
    const file = path.join(directory, 'config.json');
    const store = new JsonConfigStore(file);
    await store.save({ baseUrl: 'https://provider.example/v1', model: 'model-b', models: ['model-a', 'model-b'] });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      schemaVersion: 2,
      provider: { baseUrl: 'https://provider.example/v1', model: 'model-b', models: ['model-a', 'model-b'] }
    });
    await expect(store.get()).resolves.toEqual({
      baseUrl: 'https://provider.example/v1',
      model: 'model-b',
      models: ['model-a', 'model-b'],
      hasApiKey: false
    });
  });
});

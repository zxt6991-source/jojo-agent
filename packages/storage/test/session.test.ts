import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BROWSER_SETTINGS, DEFAULT_MEMORY_SETTINGS } from '@desktop-agent/contracts';
import { JsonConfigStore, JsonlSessionStore } from '../src/index.js';

describe('JsonlSessionStore', () => {
  it('persists whether a session is not bound to a project', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-general-session-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create('General', directory, undefined, false);

    expect(session.projectBound).toBe(false);
    await expect(store.get(session.id)).resolves.toMatchObject({ projectBound: false });

    const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-selected-project-'));
    const projectIdentity = {
      id: `prj_${'a'.repeat(64)}`,
      displayName: path.basename(projectDirectory),
      canonicalPath: projectDirectory
    } as const;
    await expect(store.bindProject(session.id, projectDirectory, projectIdentity)).resolves.toMatchObject({
      workingDirectory: projectDirectory,
      projectBound: true,
      projectIdentity
    });
    await expect(store.get(session.id)).resolves.toMatchObject({ workingDirectory: projectDirectory, projectBound: true });
  });

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
  it('uses 128k context and 8192 output as the model settings defaults', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-defaults-'));
    const settings = await new JsonConfigStore(path.join(directory, 'config.json')).get();

    expect(settings.providers[0]).toMatchObject({
      contextWindowTokens: 128_000,
      maxOutputTokens: 8_192
    });
  });

  it('migrates a single-model v1 config to the model list', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-'));
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      provider: { baseUrl: 'https://provider.example/v1', model: 'legacy-model' }
    }));

    await expect(new JsonConfigStore(file).get(true)).resolves.toEqual({
      activeProviderId: 'openai',
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: 'openai', baseUrl: 'https://provider.example/v1', model: 'legacy-model',
          models: ['legacy-model'], hasApiKey: true
        })
      ]),
      utilityModel: { providerId: 'openai', model: 'legacy-model' },
      permissions: { mode: 'ask' },
      memory: DEFAULT_MEMORY_SETTINGS,
      extensions: { mcpServers: [], skills: { directories: [], disabled: [] }, browser: { ...DEFAULT_BROWSER_SETTINGS } }
    });
  });

  it('drops unsupported providers from existing v3 config without losing compatible entries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-'));
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify({
      schemaVersion: 3,
      activeProviderId: 'unsupported',
      providers: [
        {
          id: 'openai', name: 'Compatible', protocol: 'openai_chat_completions',
          baseUrl: 'https://provider.example/v1', model: 'model-a', models: ['model-a'],
          contextWindowTokens: 32_000, maxOutputTokens: 2_000
        },
        {
          id: 'unsupported', name: 'Removed protocol', protocol: 'removed_protocol',
          baseUrl: 'https://removed.example', model: 'removed-model', models: ['removed-model'],
          contextWindowTokens: 32_000, maxOutputTokens: 2_000
        }
      ],
      utilityModel: { providerId: 'unsupported', model: 'removed-model' }
    }));

    await expect(new JsonConfigStore(file).get({ openai: 'secret' })).resolves.toMatchObject({
      activeProviderId: 'openai',
      providers: [{ id: 'openai', protocol: 'openai_chat_completions', hasApiKey: true }],
      utilityModel: { providerId: 'openai', model: 'model-a' }
    });
  });

  it('persists multiple providers in the v3 config format without API keys', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-config-'));
    const file = path.join(directory, 'config.json');
    const store = new JsonConfigStore(file);
    const settings = await store.get({ openai: 'secret' });
    settings.providers[0] = {
      ...settings.providers[0]!, baseUrl: 'https://provider.example/v1', model: 'model-b',
      models: ['model-a', 'model-b'], hasApiKey: true
    };
    settings.utilityModel = { providerId: 'openai', model: 'model-a' };
    settings.permissions = { mode: 'yolo' };
    settings.memory = { ...settings.memory, enabled: false, recoveryRetentionDays: 14 };
    settings.extensions = {
      mcpServers: [{ id: 'files', name: 'Files', enabled: true, transport: 'stdio', command: 'node', args: ['server.js'] }],
      skills: { directories: ['/skills'], disabled: ['disabled-skill'] },
      browser: { ...DEFAULT_BROWSER_SETTINGS, allowedDomains: ['example.com'] }
    };
    await store.save(settings);

    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(stored).toMatchObject({
      schemaVersion: 3, activeProviderId: 'openai',
      providers: expect.arrayContaining([expect.objectContaining({ id: 'openai', model: 'model-b', models: ['model-a', 'model-b'] })]),
      utilityModel: { providerId: 'openai', model: 'model-a' }
    });
    expect(stored.extensions).toEqual(settings.extensions);
    expect(stored.memory).toEqual(settings.memory);
    expect(stored.permissions).toEqual({ mode: 'yolo' });
    expect(JSON.stringify(stored)).not.toContain('hasApiKey');
    await expect(store.get()).resolves.toMatchObject({
      permissions: { mode: 'yolo' },
      providers: expect.arrayContaining([expect.objectContaining({ id: 'openai', hasApiKey: false })])
    });
  });
});

import { IPC, SpeechSettingsSchema } from '@desktop-agent/contracts';
import { JsonConfigStore, SqlitePermissionGovernanceStore } from '@desktop-agent/storage';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerSettingsIpc } from './settings-ipc';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it.each(['endpoint', 'protocol'] as const)('does not merge or persist metadata from another %s', async (change) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-discovery-connection-')); directories.push(directory);
  const configStore = new JsonConfigStore(path.join(directory, 'config.json'));
  const current = await configStore.get();
  const provider = current.providers[0]!;
  provider.models[0]!.override = { defaultOutputTokens: 1_024 };
  await configStore.save(current);
  const permissionGovernanceStore = new SqlitePermissionGovernanceStore(path.join(directory, 'permissions.sqlite'));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'deepseek-flash', context_window: 1_048_576 },
    { id: provider.model, context_window: 64_000 }
  ] }))));
  const pushConfig = vi.fn();
  try {
    registerSettingsIpc({
      configStore, permissionGovernanceStore, assertTrusted: () => undefined,
      readApiKeys: async () => ({ [provider.id]: 'test-key' }), saveApiKey: async () => undefined,
      pushConfig, permissionGovernanceSnapshot: () => { throw new Error('Not used.'); }
    });
    const list = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC.listModels)![1];
    const models = await list({} as IpcMainInvokeEvent, {
      providerId: provider.id,
      protocol: change === 'protocol' ? 'openai_responses' : provider.protocol,
      baseUrl: change === 'endpoint' ? 'https://api.deepseek.com' : provider.baseUrl
    });
    expect(models.map((model: { id: string }) => model.id)).toEqual(['deepseek-flash', provider.model]);
    expect(models.every((model: { override?: unknown }) => !model.override)).toBe(true);
    expect(pushConfig).not.toHaveBeenCalled();
    expect(await configStore.get()).toEqual(current);
  } finally { permissionGovernanceStore.close(); }
});

it('keeps persisted metadata untouched when discovery returns no models', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'model-discovery-empty-')); directories.push(directory);
  const configStore = new JsonConfigStore(path.join(directory, 'config.json'));
  const current = await configStore.get();
  await configStore.save(current);
  const permissionGovernanceStore = new SqlitePermissionGovernanceStore(path.join(directory, 'permissions.sqlite'));
  const provider = current.providers[0]!;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }))));
  try {
    registerSettingsIpc({
      configStore, permissionGovernanceStore, assertTrusted: () => undefined,
      readApiKeys: async () => ({ [provider.id]: 'test-key' }), saveApiKey: async () => undefined,
      pushConfig: async () => undefined, permissionGovernanceSnapshot: () => { throw new Error('Not used.'); }
    });
    const list = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC.listModels)![1];
    await expect(list({} as IpcMainInvokeEvent, { providerId: provider.id, protocol: provider.protocol, baseUrl: provider.baseUrl })).rejects.toThrow('no available models');
    expect(await configStore.get()).toEqual(current);
  } finally { permissionGovernanceStore.close(); }
});

it('preserves configured speech when the ordinary text model settings are saved', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'text-settings-speech-')); directories.push(directory);
  const configStore = new JsonConfigStore(path.join(directory, 'config.json'));
  const current = await configStore.get();
  current.speech = SpeechSettingsSchema.parse({ inputMode: 'auto_send', autoReadReplies: true, playback: { volume: 0.3 } });
  await configStore.save(current);
  const permissionGovernanceStore = new SqlitePermissionGovernanceStore(path.join(directory, 'permissions.sqlite'));
  try {
    registerSettingsIpc({
      configStore, permissionGovernanceStore, assertTrusted: () => undefined,
      readApiKeys: async () => ({}), saveApiKey: async () => undefined,
      pushConfig: async () => undefined, permissionGovernanceSnapshot: () => { throw new Error('Not used.'); }
    });
    const save = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC.saveSettings)![1];
    const updated = { ...current.providers[0]!, name: 'Renamed text provider' };
    await save({} as IpcMainInvokeEvent, { activeProviderId: 'openai', provider: updated, utilityModel: current.utilityModel });
    const saved = await configStore.get();
    expect(saved.providers[0]!.name).toBe('Renamed text provider');
    expect(saved.speech).toEqual(current.speech);
  } finally { permissionGovernanceStore.close(); }
});

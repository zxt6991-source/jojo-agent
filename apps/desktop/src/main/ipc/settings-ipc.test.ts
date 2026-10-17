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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

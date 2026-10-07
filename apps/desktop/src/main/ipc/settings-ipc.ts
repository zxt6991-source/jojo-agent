import type { ModelConfig } from '@desktop-agent/contracts';
import {
  GetPermissionGovernanceInputSchema,
  IPC, ListModelsInputSchema,
  ResetWorkspacePermissionPolicyInputSchema, SavePermissionPolicyInputSchema, SaveSettingsInputSchema,
  type PermissionGovernanceSnapshot
} from '@desktop-agent/contracts';
import { createProvider, mergeRefreshedModels, ModelDiscoveryRefresh } from '@desktop-agent/providers';
import { JsonConfigStore, SqlitePermissionGovernanceStore } from '@desktop-agent/storage';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  configStore: JsonConfigStore;
  readApiKeys: () => Promise<Record<string, string>>;
  permissionGovernanceSnapshot: (input: {
    workingDirectory?: string;
    sessionId?: string;
    limit?: number;
  }) => PermissionGovernanceSnapshot;
  permissionGovernanceStore: SqlitePermissionGovernanceStore;
  pushConfig: () => Promise<void>;
  saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
}

export function registerSettingsIpc(ctx: Context): void {
  ipcMain.handle(IPC.getSettings, async (event) => { ctx.assertTrusted(event); return ctx.configStore.get(await ctx.readApiKeys()); });
  ipcMain.handle(IPC.getPermissionGovernance, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = GetPermissionGovernanceInputSchema.parse(raw ?? {});
    return ctx.permissionGovernanceSnapshot({
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      limit: input.limit
    });
  });
  ipcMain.handle(IPC.resetWorkspacePermissionPolicy, (event, raw) => {
    ctx.assertTrusted(event);
    const input = ResetWorkspacePermissionPolicyInputSchema.parse(raw);
    ctx.permissionGovernanceStore.deleteWorkspaceProfile(input.workingDirectory);
    return ctx.permissionGovernanceSnapshot(input);
  });
  ipcMain.handle(IPC.savePermissionPolicy, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SavePermissionPolicyInputSchema.parse(raw);
    ctx.permissionGovernanceStore.saveProfile({
      scope: input.scope,
      ...(input.workingDirectory ? { scopeKey: input.workingDirectory } : {}),
      mode: input.mode,
      document: input.document
    });
    if (input.scope === 'global') {
      const apiKeys = await ctx.readApiKeys();
      const current = await ctx.configStore.get(apiKeys);
      await ctx.configStore.save({ ...current, permissions: { mode: input.mode } });
      await ctx.pushConfig();
    }
    return ctx.permissionGovernanceSnapshot({
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });
  const modelRefresh = new ModelDiscoveryRefresh<ModelConfig[]>();
  ipcMain.handle(IPC.cancelModelRefresh, (event, providerId) => {
    ctx.assertTrusted(event);
    if (typeof providerId === 'string') modelRefresh.cancel(providerId);
  });
  ipcMain.handle(IPC.listModels, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ListModelsInputSchema.parse(raw);
    const settings = await ctx.configStore.get(await ctx.readApiKeys());
    const configured = settings.providers.find((provider) => provider.id === input.providerId);
    const apiKey = input.apiKey || (configured ? (await ctx.readApiKeys())[configured.id] : undefined);
    if (!apiKey) throw new Error('请先填写模型 API Key。');
    return modelRefresh.refresh(input.providerId, JSON.stringify([input.baseUrl, apiKey]), async (signal) => {
      const remote = await createProvider({ baseUrl: input.baseUrl }, apiKey, 15_000).listModels(signal);
      const keys = await ctx.readApiKeys();
      const latest = await ctx.configStore.get(keys);
      const current = latest.providers.find((provider) => provider.id === input.providerId);
      signal.throwIfAborted();
      const models = mergeRefreshedModels(current?.models ?? [], remote);
      if (current && current.baseUrl === input.baseUrl && keys[current.id] === apiKey) {
        await ctx.configStore.save({ ...latest, providers: latest.providers.map((provider) => provider.id === current.id ? { ...provider, models } : provider) });
        await ctx.pushConfig();
      }
      return mergeRefreshedModels((current?.models ?? []).map((model) => {
        const automatic = { ...model }; delete automatic.override; return automatic;
      }), remote);
    });
  });
  ipcMain.handle(IPC.saveSettings, async (event, raw) => {
    ctx.assertTrusted(event); const input = SaveSettingsInputSchema.parse(raw);
    if (input.apiKey) await ctx.saveApiKey(input.provider.id, input.apiKey);
    const apiKeys = await ctx.readApiKeys();
    const current = await ctx.configStore.get(apiKeys);
    const provider = { ...input.provider, hasApiKey: Boolean(apiKeys[input.provider.id]) };
    const providers = current.providers.some((item) => item.id === provider.id)
      ? current.providers.map((item) => item.id === provider.id ? provider : item)
      : [...current.providers, provider];
    const settings = {
      activeProviderId: input.activeProviderId, providers, utilityModel: input.utilityModel,
      permissions: input.permissions ?? current.permissions,
      memory: current.memory, extensions: current.extensions
    };
    await ctx.configStore.save(settings);
    await ctx.pushConfig(); return ctx.configStore.get(apiKeys);
  });

}

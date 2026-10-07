import type { HookSettingsSnapshot } from '@desktop-agent/contracts';
import {
  GetHookStatusInputSchema,
  HookProjectActionInputSchema,
  IPC,
  OpenHookConfigInputSchema
} from '@desktop-agent/contracts';
import { EMPTY_HOOK_CONFIG, FileHookTrustStore } from '@desktop-agent/hooks';
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  readHookSnapshot: (workingDirectory?: string) => Promise<HookSettingsSnapshot>;
  refreshHookSnapshot: (workingDirectory?: string) => Promise<HookSettingsSnapshot>;
  hookTrustStore: FileHookTrustStore;
  userHookConfigPath: () => string;
  projectHookConfigPath: (workingDirectory: string) => string;
  pathExists: (filePath: string) => Promise<boolean>;
}

export function registerHooksIpc(ctx: Context): void {
  ipcMain.handle(IPC.getHookStatus, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = GetHookStatusInputSchema.parse(raw ?? {});
    return ctx.readHookSnapshot(input.workingDirectory);
  });
  ipcMain.handle(IPC.reloadHooks, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = GetHookStatusInputSchema.parse(raw ?? {});
    return ctx.refreshHookSnapshot(input.workingDirectory);
  });
  ipcMain.handle(IPC.trustProjectHooks, async (event, raw) => {
    ctx.assertTrusted(event);
    const { workingDirectory } = HookProjectActionInputSchema.parse(raw);
    const snapshot = await ctx.readHookSnapshot(workingDirectory);
    const project = snapshot.project;
    if (!project?.fingerprint) throw new Error('当前项目没有可信任的 Hooks 配置。');
    if (project.state === 'invalid') throw new Error(project.error ?? '项目 Hooks 配置无效。');
    await ctx.hookTrustStore.trust(project.path, project.fingerprint);
    return ctx.refreshHookSnapshot(workingDirectory);
  });
  ipcMain.handle(IPC.disableProjectHooks, async (event, raw) => {
    ctx.assertTrusted(event);
    const { workingDirectory } = HookProjectActionInputSchema.parse(raw);
    const snapshot = await ctx.readHookSnapshot(workingDirectory);
    const project = snapshot.project;
    if (!project || project.state === 'missing') throw new Error('当前项目尚未配置 Hooks。');
    await ctx.hookTrustStore.disable(project.path);
    return ctx.refreshHookSnapshot(workingDirectory);
  });
  ipcMain.handle(IPC.openHookConfig, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = OpenHookConfigInputSchema.parse(raw);
    const file = input.source === 'user'
      ? ctx.userHookConfigPath()
      : ctx.projectHookConfigPath(input.workingDirectory!);
    await mkdir(path.dirname(file), { recursive: true });
    if (!(await ctx.pathExists(file))) await writeFile(file, EMPTY_HOOK_CONFIG, { encoding: 'utf8', flag: 'wx' });
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
}

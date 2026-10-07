import {
  BrowserDockActionSchema, BrowserDockLayoutSchema, BrowserRecordingRegistryActionInputSchema, BrowserRecordingRegistryInputSchema, BrowserRecordingStudioInputSchema,
  DuplicateBrowserRecordingInputSchema,
  IPC,
  SaveBrowserRecordingInputSchema
} from '@desktop-agent/contracts';
import { JsonConfigStore } from '@desktop-agent/storage';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { probeChromeCdp } from '../browser-backends/chrome-cdp-client';
import { BrowserRuntime } from '../browser-runtime';
import { SessionLifecycleManager } from '../session-lifecycle';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  sessionLifecycle: SessionLifecycleManager;
  browserRuntime: BrowserRuntime | null;
  configStore: JsonConfigStore;
  readApiKeys: () => Promise<Record<string, string>>;
}

export function registerBrowserIpc(ctx: Context): void {
  ipcMain.handle(IPC.browserDockLayout, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserDockLayoutSchema.parse(raw);
    ctx.sessionLifecycle.assertMutable(input.sessionId);
    ctx.browserRuntime?.setDockLayout(input);
  });
  ipcMain.handle(IPC.browserDockAction, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserDockActionSchema.parse(raw);
    ctx.sessionLifecycle.assertMutable(input.sessionId);
    await ctx.browserRuntime?.handleDockAction(input);
  });
  ipcMain.handle(IPC.listBrowserRecordings, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserRecordingRegistryInputSchema.parse(raw ?? {});
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.recordingRegistrySnapshot(input.workingDirectory);
  });
  ipcMain.handle(IPC.trustProjectBrowserRecording, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserRecordingRegistryActionInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.trustProjectRecording(input.recordingId, input.workingDirectory);
  });
  ipcMain.handle(IPC.revokeProjectBrowserRecordingTrust, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserRecordingRegistryActionInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.revokeProjectRecordingTrust(input.recordingId, input.workingDirectory);
  });
  ipcMain.handle(IPC.deleteBrowserRecording, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserRecordingRegistryActionInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.deleteManagedRecording(input.recordingId, input.workingDirectory);
  });
  ipcMain.handle(IPC.getBrowserRecordingStudio, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = BrowserRecordingStudioInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.recordingStudioDetail(input.recordingId, input.workingDirectory);
  });
  ipcMain.handle(IPC.saveBrowserRecording, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SaveBrowserRecordingInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.saveManagedRecording(
      input.recordingId,
      input.document,
      { expectedRevision: input.expectedRevision, expectedHash: input.expectedHash },
      input.workingDirectory
    );
  });
  ipcMain.handle(IPC.duplicateBrowserRecording, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = DuplicateBrowserRecordingInputSchema.parse(raw);
    if (!ctx.browserRuntime) throw new Error('Browser runtime is not available.');
    return ctx.browserRuntime.duplicateManagedRecording(input.recordingId, input.name, input.workingDirectory);
  });
  ipcMain.handle(IPC.probeChromeBrowser, async (event, raw) => {
    ctx.assertTrusted(event);
    const settings = await ctx.configStore.get(await ctx.readApiKeys());
    const port = z.number().int().min(1).max(65_535).optional().parse(raw) ?? settings.extensions.browser.chromeDebugPort;
    try {
      const info = await probeChromeCdp(port);
      return { ok: true, browser: info.browser };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

}

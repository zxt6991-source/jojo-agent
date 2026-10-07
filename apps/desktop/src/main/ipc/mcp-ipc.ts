import type { WorkerCommand } from '@desktop-agent/contracts';
import {
  IPC,
  McpServerIdInputSchema
} from '@desktop-agent/contracts';
import { ipcMain, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  beginMcpOAuth: (serverId: string) => Promise<void>;
  worker: UtilityProcess | null;
  waitForWorker: (requestId: string, timeoutMs?: number) => Promise<void>;
  postWorkerCommand: (command: WorkerCommand) => boolean;
}

export function registerMcpIpc(ctx: Context): void {
  ipcMain.handle(IPC.connectMcpOAuth, async (event, raw) => {
    ctx.assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    await ctx.beginMcpOAuth(serverId);
  });
  ipcMain.handle(IPC.disconnectMcpOAuth, async (event, raw) => {
    ctx.assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = ctx.waitForWorker(requestId);
    ctx.postWorkerCommand({ type: 'mcp.oauth.disconnect', requestId, serverId });
    await completion;
  });
  ipcMain.handle(IPC.reconnectMcp, async (event, raw) => {
    ctx.assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = ctx.waitForWorker(requestId);
    ctx.postWorkerCommand({ type: 'mcp.reconnect', requestId, serverId });
    await completion;
  });
  ipcMain.handle(IPC.trustMcpServer, async (event, raw) => {
    ctx.assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = ctx.waitForWorker(requestId);
    ctx.postWorkerCommand({ type: 'mcp.trust', requestId, serverId });
    await completion;
  });
  ipcMain.handle(IPC.revokeMcpServerTrust, async (event, raw) => {
    ctx.assertTrusted(event);
    const { serverId } = McpServerIdInputSchema.parse(raw);
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = ctx.waitForWorker(requestId);
    ctx.postWorkerCommand({ type: 'mcp.trust.revoke', requestId, serverId });
    await completion;
  });

}

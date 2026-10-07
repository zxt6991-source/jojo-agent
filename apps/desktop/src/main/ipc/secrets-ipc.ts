import type { WorkerCommand } from '@desktop-agent/contracts';
import {
  IPC,
  ResolveTerminalSecretInputSchema
} from '@desktop-agent/contracts';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  browserSecretPrompts: Map<string, { resolve: (value: string | undefined) => void; }>;
  terminalSecretRequests: Map<string, { sessionId: string; name: string; }>;
  importTerminalSecretFromShell: (name: string) => Promise<string>;
  saveTerminalSecret: (name: string, value: string) => Promise<void>;
  postWorkerCommand: (command: WorkerCommand) => boolean;
  pushConfig: () => Promise<void>;
}

export function registerSecretsIpc(ctx: Context): void {
  ipcMain.handle(IPC.browserSecretResolve, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = z.object({ requestId: z.string().min(1), value: z.string().max(4_000).optional() }).parse(raw);
    const pending = ctx.browserSecretPrompts.get(input.requestId);
    if (!pending) return;
    ctx.browserSecretPrompts.delete(input.requestId);
    pending.resolve(input.value?.trim() || undefined);
  });
  ipcMain.handle(IPC.terminalSecretResolve, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = ResolveTerminalSecretInputSchema.parse(raw);
    const pending = ctx.terminalSecretRequests.get(input.requestId);
    if (!pending) return;
    let value: string | undefined;
    if (input.action === 'submit') value = input.value;
    else if (input.action === 'import') value = await ctx.importTerminalSecretFromShell(pending.name);
    ctx.terminalSecretRequests.delete(input.requestId);
    if (value && input.remember) await ctx.saveTerminalSecret(pending.name, value);
    ctx.postWorkerCommand({
      type: 'terminal.secret.resolve',
      requestId: input.requestId,
      ...(value ? { value } : {})
    });
    if (value && input.remember) await ctx.pushConfig();
  });

}

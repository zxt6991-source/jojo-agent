import {
  DesktopChannelMutationSchema,
  IPC,
  SaveChannelSecretsInputSchema,
  type ChannelDeliveryReceipt, type ChannelSettingsSnapshot,
  type WorkerCommand
} from '@desktop-agent/contracts';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  requestChannel: (command: Extract<WorkerCommand, { type: 'channel.snapshot' | 'channel.mutate' }>) => Promise<ChannelResponse>;
  persistChannelSecrets: (input: ReturnType<typeof SaveChannelSecretsInputSchema.parse>) => Promise<Record<string, string>>;
  pushConfig: () => Promise<void>;
}

export function registerChannelIpc(ctx: Context): void {
  ipcMain.handle(IPC.getChannelSettings, async (event) => {
    ctx.assertTrusted(event);
    const response = await ctx.requestChannel({ type: 'channel.snapshot', requestId: crypto.randomUUID() });
    if (!response.snapshot) throw new Error('Channel runtime returned no snapshot.');
    return response.snapshot;
  });
  ipcMain.handle(IPC.saveChannelSecrets, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = SaveChannelSecretsInputSchema.parse(raw);
    const references = await ctx.persistChannelSecrets(input);
    await ctx.pushConfig();
    return references;
  });
  ipcMain.handle(IPC.mutateChannel, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = DesktopChannelMutationSchema.parse(raw);
    const response = await ctx.requestChannel({ type: 'channel.mutate', requestId: crypto.randomUUID(), input });
    if (input.action === 'channel.test') {
      if (!response.receipt) throw new Error('Channel test returned no receipt.');
      return response.receipt;
    }
    if (!response.snapshot) throw new Error('Channel mutation returned no snapshot.');
    return response.snapshot;
  });

}

type ChannelResponse = { snapshot?: ChannelSettingsSnapshot; receipt?: ChannelDeliveryReceipt };

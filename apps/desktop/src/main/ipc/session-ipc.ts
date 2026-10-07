import { BindSessionProjectInputSchema, CreateSessionInputSchema, IPC, RenameSessionInputSchema, SessionIdInputSchema } from '@desktop-agent/contracts';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { SessionLifecycleManager } from '../session-lifecycle';
import type { SessionMetadataClient } from './session-client';

export function registerSessionMetadataIpc(options: {
  ipc: Pick<IpcMain, 'handle'>;
  assertTrusted(event: IpcMainInvokeEvent): void;
  client: SessionMetadataClient;
  lifecycle: SessionLifecycleManager;
  changed(): void;
  deleted(sessionId: string): void;
}): void {
  const { ipc, client, lifecycle } = options;
  ipc.handle(IPC.listSessions, async event => { options.assertTrusted(event); return client.list(); });
  ipc.handle(IPC.createSession, async (event, raw) => {
    options.assertTrusted(event);
    const result = await client.request({ action: 'create', ...CreateSessionInputSchema.parse(raw) });
    if (!result || Array.isArray(result)) throw new Error('Invalid session creation response.');
    lifecycle.markActive(result.id); options.changed(); return result;
  });
  ipc.handle(IPC.bindSessionProject, async (event, raw) => {
    options.assertTrusted(event); const input = BindSessionProjectInputSchema.parse(raw);
    lifecycle.assertMutable(input.sessionId);
    const result = await client.request({ action: 'bindProject', ...input });
    options.changed(); return result;
  });
  ipc.handle(IPC.renameSession, async (event, raw) => {
    options.assertTrusted(event); const input = RenameSessionInputSchema.parse(raw);
    lifecycle.assertMutable(input.sessionId);
    await client.request({ action: 'rename', ...input }); options.changed();
  });
  ipc.handle(IPC.deleteSession, async (event, raw) => {
    options.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    const lease = lifecycle.beginDelete(sessionId);
    try {
      await client.request({ action: 'delete', sessionId });
      options.deleted(sessionId); lease.commit(); options.changed();
    } catch (error) { lease.rollback(); throw error; }
  });
}

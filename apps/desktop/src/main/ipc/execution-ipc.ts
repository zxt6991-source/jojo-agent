import type { WorkerCommand, WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  IPC,
  MAX_IMAGE_BYTES,
  SessionIdInputSchema,
  StartTurnInputSchema,
  WorkflowRunActionInputSchema
} from '@desktop-agent/contracts';
import { ipcMain, type IpcMainInvokeEvent, type UtilityProcess } from 'electron';
import { SessionLifecycleManager } from '../session-lifecycle';
import { SessionMetadataClient } from './session-client';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  sessionLifecycle: SessionLifecycleManager;
  worker: UtilityProcess | null;
  sessionStore: SessionMetadataClient;
  postWorkerCommand: (command: WorkerCommand) => boolean;
  terminalSecretRequests: Map<string, { sessionId: string; name: string; }>;
  workflowRuns: Map<string, WorkflowRunSnapshot>;
  waitForWorker: (requestId: string, timeoutMs?: number) => Promise<void>;
}

export function registerExecutionIpc(ctx: Context): void {
  ipcMain.handle(IPC.startTurn, async (event, raw) => {
    ctx.assertTrusted(event); const payload = StartTurnInputSchema.parse(raw);
    ctx.sessionLifecycle.assertMutable(payload.sessionId);
    for (const image of payload.images) {
      if (Buffer.byteLength(image.data, 'base64') > MAX_IMAGE_BYTES) throw new Error(`图片必须小于 10 MB：${image.name ?? 'image'}`);
    }
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const session = await ctx.sessionStore.get(payload.sessionId);
    if (!session) throw new Error('Session not found.');
    ctx.postWorkerCommand({ type: 'turn.start', payload });
  });
  ipcMain.handle(IPC.cancelTurn, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    for (const [requestId, pending] of ctx.terminalSecretRequests) {
      if (pending.sessionId === sessionId) ctx.terminalSecretRequests.delete(requestId);
    }
    ctx.postWorkerCommand({ type: 'turn.cancel', sessionId });
  });
  ipcMain.handle(IPC.listWorkflowRuns, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    return [...ctx.workflowRuns.values()]
      .filter((workflow) => workflow.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  });
  ipcMain.handle(IPC.cancelWorkflow, async (event, raw) => {
    ctx.assertTrusted(event); const input = WorkflowRunActionInputSchema.parse(raw);
    ctx.postWorkerCommand({ type: 'workflow.cancel', ...input });
  });
  ipcMain.handle(IPC.resumeWorkflow, async (event, raw) => {
    ctx.assertTrusted(event); const input = WorkflowRunActionInputSchema.parse(raw);
    ctx.sessionLifecycle.assertMutable(input.sessionId);
    if (!ctx.worker) throw new Error('Agent runtime is not available.');
    const requestId = crypto.randomUUID();
    const completion = ctx.waitForWorker(requestId);
    ctx.postWorkerCommand({ type: 'workflow.resume', requestId, ...input });
    await completion;
  });

}

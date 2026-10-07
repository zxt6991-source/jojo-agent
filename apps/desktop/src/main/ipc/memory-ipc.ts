import {
  AcceptMemoryCandidateInputSchema,
  DeleteMemoryEntryInputSchema,
  GetMemoryStatusInputSchema,
  IPC,
  RebuildMemoryIndexInputSchema, RebuildSemanticMemoryIndexInputSchema, RejectMemoryCandidateInputSchema,
  SaveMemorySettingsInputSchema,
  type MemoryStatusSnapshot,
  type WorkerCommand
} from '@desktop-agent/contracts';
import { JsonConfigStore } from '@desktop-agent/storage';
import { ipcMain, type IpcMainInvokeEvent } from 'electron';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  readApiKeys: () => Promise<Record<string, string>>;
  configStore: JsonConfigStore;
  pushConfig: () => Promise<void>;
  requestMemoryStatus: (command: Extract<WorkerCommand, { type: 'memory.status' | 'memory.rebuild' | 'memory.semantic.rebuild' | 'memory.delete' | 'memory.candidate.accept' | 'memory.candidate.reject' }>) => Promise<MemoryStatusSnapshot>;
}

export function registerMemoryIpc(ctx: Context): void {
  ipcMain.handle(IPC.saveMemorySettings, async (event, raw) => {
    ctx.assertTrusted(event);
    const memory = SaveMemorySettingsInputSchema.parse(raw);
    const apiKeys = await ctx.readApiKeys();
    const current = await ctx.configStore.get(apiKeys);
    await ctx.configStore.save({ ...current, memory });
    await ctx.pushConfig();
    return memory;
  });
  ipcMain.handle(IPC.getMemoryStatus, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = GetMemoryStatusInputSchema.parse(raw ?? {});
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.status',
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });
  ipcMain.handle(IPC.rebuildMemoryIndex, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = RebuildMemoryIndexInputSchema.parse(raw);
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.rebuild',
      scope: input.scope,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });
  ipcMain.handle(IPC.rebuildSemanticMemoryIndex, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = RebuildSemanticMemoryIndexInputSchema.parse(raw ?? {});
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.semantic.rebuild',
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });
  ipcMain.handle(IPC.deleteMemoryEntry, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = DeleteMemoryEntryInputSchema.parse(raw);
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.delete',
      scope: input.scope,
      entryId: input.entryId,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });
  ipcMain.handle(IPC.acceptMemoryCandidate, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = AcceptMemoryCandidateInputSchema.parse(raw);
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.candidate.accept',
      candidateId: input.candidateId,
      userConfirmed: true,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      ...(input.edit ? { edit: input.edit } : {})
    });
  });
  ipcMain.handle(IPC.rejectMemoryCandidate, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = RejectMemoryCandidateInputSchema.parse(raw);
    const requestId = crypto.randomUUID();
    return ctx.requestMemoryStatus({
      requestId,
      type: 'memory.candidate.reject',
      candidateId: input.candidateId,
      ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {})
    });
  });

}

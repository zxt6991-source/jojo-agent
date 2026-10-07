import type { Message, SessionMeta } from '@desktop-agent/contracts';
import { ArtifactReadRequestV2Schema, ArtifactSaveRequestV2Schema, GeneratedDocumentSchema, IPC, SessionIdInputSchema, type ArtifactTargetV2, type SessionCompactionRecord } from '@desktop-agent/contracts';
import { ArtifactContentError, artifactFailure, artifactReadValue, readSessionArtifact, readSessionArtifactV2 } from '@desktop-agent/tools-node';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createArtifactExporter } from '../artifact-export';
import { renderConversationTrajectoryMarkdown, trajectoryExportFilename } from '../conversation-export';
import { SessionLifecycleManager } from '../session-lifecycle';
import { collectWorkspaceChanges } from '../workspace-changes';
import { SessionMetadataClient } from './session-client';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  loadRuntimeTranscript: (sessionId: string) => Promise<Message[]>;
  loadSessionCompactions: (sessionId: string) => Promise<SessionCompactionRecord[]>;
  sessionLifecycle: SessionLifecycleManager;
  sessionStore: SessionMetadataClient;
  mainWindow: BrowserWindow | null;
  listDesktopSessions: () => Promise<SessionMeta[]>;
}

export function registerTranscriptIpc(ctx: Context): void {
  ipcMain.handle(IPC.loadMessages, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    return ctx.loadRuntimeTranscript(sessionId);
  });
  ipcMain.handle(IPC.loadSessionCompactions, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    return ctx.loadSessionCompactions(sessionId);
  });
  const authorizeArtifact = async (target: ArtifactTargetV2) => {
    if (ctx.sessionLifecycle.state(target.sessionId) !== 'active') throw new ArtifactContentError('FORBIDDEN');
    const session = await ctx.sessionStore.get(target.sessionId);
    if (!session) throw new ArtifactContentError('NOT_FOUND');
    return { messages: await ctx.loadRuntimeTranscript(target.sessionId), workingDirectory: session.workingDirectory };
  };
  const exportArtifact = createArtifactExporter({
    authorize: authorizeArtifact,
    select: (name) => dialog.showSaveDialog(ctx.mainWindow!, {
      title: '保存原始文件', defaultPath: path.join(app.getPath('downloads'), name), buttonLabel: '保存'
    }),
    write: (destination, bytes) => writeFile(destination, bytes, { mode: 0o600 })
  });
  for (const channel of [IPC.readArtifactV2, IPC.saveArtifactV2]) {
    ipcMain.handle(channel, async (event, raw) => {
      try {
        try { ctx.assertTrusted(event); } catch (error) { throw new ArtifactContentError('FORBIDDEN', undefined, { cause: error }); }
        if (channel === IPC.saveArtifactV2) {
          const parsed = ArtifactSaveRequestV2Schema.safeParse(raw);
          if (!parsed.success) throw new ArtifactContentError('INVALID_REQUEST');
          return await exportArtifact(event.sender.id, parsed.data);
        }
        const parsed = ArtifactReadRequestV2Schema.safeParse(raw);
        if (!parsed.success) throw new ArtifactContentError('INVALID_REQUEST');
        const authorization = await authorizeArtifact(parsed.data);
        const result = await readSessionArtifactV2(authorization.messages, authorization.workingDirectory, parsed.data.sessionId, parsed.data.artifactId);
        return { ok: true, value: artifactReadValue(result, parsed.data) };
      } catch (error) { return artifactFailure(error); }
    });
  }
  for (const channel of [IPC.readArtifact, IPC.saveArtifact]) {
    ipcMain.handle(channel, async (event, raw) => {
      ctx.assertTrusted(event);
      const input = z.object({ sessionId: z.string().min(1).max(256), artifactId: z.string().min(1).max(4096) }).strict().parse(raw);
      const session = await ctx.sessionStore.get(input.sessionId);
      if (!session) throw new Error('Session not found.');
      const result = await readSessionArtifact(await ctx.loadRuntimeTranscript(input.sessionId), session.workingDirectory, input.artifactId);
      if (channel === IPC.readArtifact) return { data: result.bytes.toString('base64'), mimeType: result.artifact.mimeType };
      const selected = await dialog.showSaveDialog(ctx.mainWindow!, {
        title: '保存原始文件', defaultPath: path.join(app.getPath('downloads'), result.artifact.name), buttonLabel: '保存'
      });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      await writeFile(selected.filePath, result.bytes, { mode: 0o600 });
      return { canceled: false, path: selected.filePath };
    });
  }
  ipcMain.handle(IPC.saveGeneratedDocument, async (event, raw) => {
    ctx.assertTrusted(event);
    const document = GeneratedDocumentSchema.parse(raw);
    const bytes = Buffer.from(document.content, 'utf8');
    const selected = await dialog.showSaveDialog(ctx.mainWindow!, {
      title: '保存生成的文档',
      defaultPath: path.join(app.getPath('downloads'), document.name),
      buttonLabel: '保存',
      filters: [{ name: 'HTML 文档', extensions: ['html', 'htm'] }]
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    await writeFile(selected.filePath, bytes, { mode: 0o600 });
    return { canceled: false, path: selected.filePath };
  });
  ipcMain.handle(IPC.exportSessionTrajectory, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    const metadata = await ctx.sessionStore.get(sessionId);
    if (!metadata) throw new Error('Session not found.');
    const session = (await ctx.listDesktopSessions()).find((item) => item.id === sessionId) ?? metadata;
    const selected = await dialog.showSaveDialog(ctx.mainWindow!, {
      title: '导出会话轨迹',
      defaultPath: path.join(app.getPath('downloads'), trajectoryExportFilename(session.title)),
      buttonLabel: '导出',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    const content = renderConversationTrajectoryMarkdown({
      session,
      messages: await ctx.loadRuntimeTranscript(sessionId),
      compactions: await ctx.loadSessionCompactions(sessionId)
    });
    await writeFile(selected.filePath, content, { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, path: selected.filePath };
  });
  ipcMain.handle(IPC.getWorkspaceChanges, async (event, raw) => {
    ctx.assertTrusted(event); const { sessionId } = SessionIdInputSchema.parse({ sessionId: raw });
    const session = await ctx.sessionStore.get(sessionId);
    if (!session) throw new Error('Session not found.');
    return collectWorkspaceChanges(session.workingDirectory);
  });

}

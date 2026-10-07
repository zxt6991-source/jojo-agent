import {
  IPC,
  MAX_FILE_BYTES, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES,
  type AttachmentSelection
} from '@desktop-agent/contracts';
import { BrowserWindow, clipboard, dialog, ipcMain, nativeImage, type IpcMainInvokeEvent } from 'electron';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { clipboardFilePaths, hasClipboardFiles } from '../clipboard-files';

interface Context {
  assertTrusted: (event: IpcMainInvokeEvent) => void;
  mainWindow: BrowserWindow | null;
  importAttachmentPaths: (paths: string[], mode: 'files' | 'folder') => Promise<AttachmentSelection>;
  importTransferredPaths: (paths: string[]) => Promise<AttachmentSelection>;
}

export function registerAttachmentsIpc(ctx: Context): void {
  ipcMain.handle(IPC.chooseDirectory, async (event) => {
    ctx.assertTrusted(event); const result = await dialog.showOpenDialog(ctx.mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.chooseFiles, async (event, raw) => {
    ctx.assertTrusted(event);
    const mode = z.enum(['files', 'folder']).parse(raw);
    const result = await dialog.showOpenDialog(ctx.mainWindow!, {
      title: mode === 'folder' ? '添加文件夹中的文件' : '添加文件',
      properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
    });
    if (result.canceled) return { files: [], warnings: [] };
    return ctx.importAttachmentPaths(result.filePaths, mode);
  });

  ipcMain.on(IPC.hasClipboardFiles, (event) => {
    try { ctx.assertTrusted(event); event.returnValue = hasClipboardFiles(clipboard); }
    catch { event.returnValue = false; }
  });
  ipcMain.handle(IPC.pasteFiles, async (event) => {
    ctx.assertTrusted(event);
    const paths = clipboardFilePaths(clipboard);
    if (paths.length > 100) throw new Error('一次最多粘贴 100 项，请分批添加。');
    if (!paths.length) return { files: [], warnings: ['剪贴板中的文件无法读取，请重新复制或拖入文件。'] };
    return ctx.importTransferredPaths(paths);
  });
  ipcMain.handle(IPC.importAttachments, async (event, raw) => {
    ctx.assertTrusted(event);
    const input = z.object({
      paths: z.array(z.string().min(1).max(4_096).refine((value) => path.isAbsolute(value))).max(100),
      blobs: z.array(z.object({
        name: z.string().min(1).max(255).refine((name) => name !== '.' && name !== '..' && !/[\\/\0]/u.test(name)),
        data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= MAX_FILE_BYTES)
      }).strict()).max(100)
    }).strict().refine((value) => value.paths.length + value.blobs.length <= 100 && value.blobs.reduce((size, blob) => size + blob.data.byteLength, 0) <= 50 * 1024 * 1024).parse(raw);
    if (!input.blobs.length) return ctx.importTransferredPaths(input.paths);
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'jojo-pasted-files-'));
    try {
      const paths = [...input.paths];
      for (const [index, blob] of input.blobs.entries()) {
        const directory = path.join(temporary, String(index));
        await mkdir(directory);
        const filePath = path.join(directory, blob.name);
        await writeFile(filePath, blob.data);
        paths.push(filePath);
      }
      return await ctx.importTransferredPaths(paths);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  ipcMain.handle(IPC.chooseImages, async (event) => {
    ctx.assertTrusted(event);
    const result = await dialog.showOpenDialog(ctx.mainWindow!, {
      title: '选择图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (result.canceled) return [];
    const mimeTypes: Record<string, `image/${string}`> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'
    };
    return Promise.all(result.filePaths.slice(0, MAX_IMAGE_ATTACHMENTS).map(async (filePath) => {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error(`图片必须小于 10 MB：${path.basename(filePath)}`);
      const mimeType = mimeTypes[path.extname(filePath).toLowerCase()];
      if (!mimeType || nativeImage.createFromPath(filePath).isEmpty()) throw new Error(`不支持或无法读取图片：${path.basename(filePath)}`);
      return { type: 'image' as const, data: (await readFile(filePath)).toString('base64'), mimeType, name: path.basename(filePath) };
    }));
  });

}

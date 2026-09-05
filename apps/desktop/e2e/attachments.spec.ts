import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { expect, test } from '@playwright/test';
import { pdfFixture } from '../test-fixtures/pdf';
import { launchElectron } from './helpers/launch-electron';

test('imports files and folders, removes attachments, sends file-only input and reloads it', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-attachments-e2e-'));
  const folder = path.join(dataDirectory, 'reference');
  await mkdir(folder);
  await writeFile(path.join(folder, 'note.md'), '# 附件测试\n本月收入 1234 元。');
  await writeFile(path.join(folder, 'archive.zip'), Buffer.from([0x50, 0x4b, 3, 4]));
  await writeFile(path.join(folder, 'firmware.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(folder, 'page.html'), '<h1>HTML 附件</h1><p>成本 456 元</p>');
  await writeFile(path.join(folder, 'manual.pdf'), pdfFixture('PDF revenue 7890'));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['收入', 1234]]), '统计');
  await writeFile(path.join(folder, 'report.xlsx'), XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const launched = await launchElectron(dataDirectory);
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    await expect(launched.page.getByPlaceholder('随心输入')).toBeVisible();
    await launched.app.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, path.join(folder, 'note.md'));
    await launched.page.getByRole('button', { name: '添加附件' }).click();
    await launched.page.getByRole('menuitem', { name: '添加文件', exact: false }).first().click();
    await expect(launched.page.getByLabel('待发送文件')).toContainText('note.md');
    await launched.page.getByRole('button', { name: '移除 note.md', exact: true }).click();
    await expect(launched.page.getByRole('button', { name: '发送消息' })).toBeDisabled();

    await launched.app.evaluate(({ dialog }, selectedFolder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedFolder] });
    }, folder);
    await launched.page.getByRole('button', { name: '添加附件' }).click();
    await launched.page.getByRole('menuitem', { name: /添加文件夹/ }).click();
    await expect(launched.page.getByLabel('待发送文件')).toContainText('reference/report.xlsx');
    await expect(launched.page.getByLabel('待发送文件').locator('.file-chip')).toHaveCount(6);
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    await expect(launched.page.locator('.message-files details')).toHaveCount(6);
    await launched.page.reload();
    await expect(launched.page.locator('.message-files details')).toHaveCount(6);
    await launched.page.locator('.message-files summary').filter({ hasText: 'report.xlsx' }).click();
    await expect(launched.page.locator('.message-files pre').filter({ hasText: '收入,1234' })).toBeVisible();
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    const journal = await readFile(path.join(dataDirectory, 'sessions', `${sessions[0]!.id}.jsonl`), 'utf8');
    expect(journal).toContain('reference/note.md');
    expect(journal).toContain('本月收入 1234 元');
    expect(journal).toContain('收入,1234');
    expect(journal).toContain('PDF revenue 7890');
    expect(journal).toContain('"type":"file"');
    await expect(launched.page.locator('.message-files summary').filter({ hasText: 'firmware.bin' })).toContainText('原始文件');
  } finally { await launched.app.close(); }
});

test('accepts native file/folder drops, clipboard file references and pasted file bytes', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-transfer-e2e-'));
  const folder = path.join(dataDirectory, 'drag-folder');
  await mkdir(folder);
  const filePath = path.join(dataDirectory, 'dragged.md');
  await writeFile(filePath, '# 拖入的文件');
  await writeFile(path.join(folder, 'nested.md'), '# 文件夹里的文件');
  const launched = await launchElectron(dataDirectory);
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    const composer = launched.page.locator('.composer');
    const textarea = launched.page.getByPlaceholder('随心输入');
    await textarea.fill('保留问题');
    const bounds = await textarea.boundingBox();
    if (!bounds) throw new Error('Composer not visible');
    const cdp = await launched.page.context().newCDPSession(launched.page);
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', {
        type, x: bounds.x + 40, y: bounds.y + 20,
        data: { items: [], files: [filePath, folder], dragOperationsMask: 1 }
      });
    }
    await expect(launched.page.getByLabel('待发送文件')).toContainText('dragged.md');
    await expect(launched.page.getByLabel('待发送文件')).toContainText('drag-folder/nested.md');
    await expect(composer).not.toHaveClass(/dragging-files/);
    await expect(textarea).toHaveValue('保留问题');

    // Simulate the native formats supplied by Finder, without modifying the user's clipboard.
    await launched.app.evaluate(({ clipboard }, paths) => {
      clipboard.availableFormats = () => ['NSFilenamesPboardType'];
      clipboard.readBuffer = () => Buffer.from(`<?xml version="1.0"?><plist version="1.0"><array>${paths.map((value) => `<string>${value}</string>`).join('')}</array></plist>`);
    }, [filePath, folder]);
    await textarea.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'dragged.md\ndrag-folder');
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(launched.page.getByLabel('待发送文件').locator('.file-chip')).toHaveCount(4);
    await expect(textarea).toHaveValue('保留问题');

    await launched.app.evaluate(({ clipboard }) => { clipboard.availableFormats = () => ['text/plain']; });
    await textarea.evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['# 粘贴的 Markdown 内容'], 'pasted.md', { type: 'text/markdown' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(launched.page.getByLabel('待发送文件')).toContainText('pasted.md');
    await textarea.evaluate(async (element) => {
      const data = new DataTransfer();
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
      const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'));
      data.items.add(new File([png], 'pasted.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(launched.page.getByLabel('待发送图片').locator('img')).toHaveCount(1);
    const plainTextPrevented = await textarea.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', '/tmp/a-file-path-is-still-text.md');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(plainTextPrevented).toBe(false);
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    await expect(launched.page.locator('.message-files details')).toHaveCount(5);
    await cdp.detach();
  } finally { await launched.app.close(); }
});

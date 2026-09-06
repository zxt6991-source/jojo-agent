import { mkdtemp, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('previews a document, persists across reload, and saves only after the user chooses a destination', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-documents-e2e-'));
  const destination = path.join(directory, 'saved.html');
  const { app, page } = await launchElectron(directory);
  try {
    const externalRequests: string[] = [];
    page.on('request', (request) => { if (request.url().includes('document-preview.invalid')) externalRequests.push(request.url()); });
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByPlaceholder('随心输入').fill('E2E: generated document');
    await page.getByRole('button', { name: '发送消息' }).click();
    const card = page.getByRole('region', { name: '生成的文档：稳健选股.html' });
    await expect(card).toBeVisible();
    await expect(page.frameLocator('.generated-document iframe').getByRole('heading')).toHaveText('文档预览测试');
    await expect(page.frameLocator('.generated-document iframe').getByRole('heading')).toHaveCSS('color', 'rgb(12, 34, 56)');
    expect(externalRequests).toEqual([]);
    const previewFrame = page.frames().find((frame) => frame.parentFrame());
    expect(await previewFrame!.evaluate(() => typeof (window as unknown as { desktopAgent?: unknown }).desktopAgent)).toBe('undefined');
    await expect(access(destination)).rejects.toThrow();
    await page.reload();
    await expect(card).toBeVisible();
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
    await card.getByRole('button', { name: '下载保存' }).click();
    await expect(card.getByRole('button', { name: '下载保存' })).toBeEnabled();
    await expect(access(destination)).rejects.toThrow();
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await card.getByRole('button', { name: '下载保存' }).click();
    await expect(card.getByRole('status')).toHaveText('文档已保存');
    expect(await readFile(destination, 'utf8')).toContain('<h1>文档预览测试</h1>');
  } finally { await app.close(); }
});

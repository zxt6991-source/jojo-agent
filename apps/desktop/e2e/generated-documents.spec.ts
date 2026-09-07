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
    expect(await previewFrame!.evaluate(() => {
      try { localStorage.getItem('test'); return false; } catch { return true; }
    })).toBe(true);
    expect(await previewFrame!.evaluate(() => {
      try { return document.cookie; } catch { return 'blocked'; }
    })).toBe('blocked');
    await card.getByRole('button', { name: '收起预览' }).click();
    await expect(card.locator('iframe')).toHaveCount(0);
    await card.getByRole('button', { name: '打开面板' }).click();
    await expect(page.getByRole('dialog', { name: 'Artifact 预览：稳健选股.html' })).toBeVisible();
    await expect(page.frameLocator('.artifact-panel iframe').getByRole('heading')).toHaveText('文档预览测试');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
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

test('delivers workspace Markdown, images and PDF through show_artifact and opens file references', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-artifacts-e2e-'));
  const { app, page } = await launchElectron(directory);
  let logs = '';
  app.process().stdout?.on('data', (chunk) => { logs += String(chunk); });
  app.process().stderr?.on('data', (chunk) => { logs += String(chunk); });
  try {
    await page.getByRole('button', { name: '新建对话' }).click();
    const sessions = await page.evaluate(() => window.desktopAgent.listSessions());
    const root = sessions[0]!.workingDirectory;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'report.md'), '# Artifact Markdown\n\nA **generated** report.');
    await writeFile(path.join(root, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="teal"/></svg>');
    await writeFile(path.join(root, 'report.pdf'), '%PDF-1.4\n% download test');
    await page.getByPlaceholder('随心输入').fill('E2E: generated artifacts');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.locator('.artifact-card')).toHaveCount(3);
    const markdown = page.getByRole('region', { name: '生成的文档：report.md', exact: true });
    await expect(markdown.frameLocator('iframe').getByRole('heading')).toHaveText('Artifact Markdown');
    await expect(page.getByRole('img', { name: 'chart.svg' })).toBeVisible();
    expect(await page.getByRole('img', { name: 'chart.svg' }).evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(120);
    await page.locator('.message.assistant .artifact-reference').filter({ hasText: 'report.md' }).click();
    await expect(page.getByRole('dialog', { name: 'Artifact 预览：report.md', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    const pdf = page.getByRole('region', { name: '生成的文档：report.pdf', exact: true });
    const destination = path.join(directory, 'saved.pdf');
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, destination);
    await pdf.getByRole('button', { name: '下载保存' }).click();
    await expect(pdf.getByRole('status')).toHaveText('文档已保存');
    expect(await readFile(destination, 'utf8')).toBe('%PDF-1.4\n% download test');
    await page.reload();
    await expect(page.locator('.artifact-card')).toHaveCount(3);
    await expect(markdown.frameLocator('iframe').getByRole('heading')).toHaveText('Artifact Markdown');
    expect(logs).not.toContain('Artifact not found in this session');
    expect(logs).not.toContain('IPC protocol violation');
  } finally { await app.close(); }
});

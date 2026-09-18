import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('browser settings, site access and recording developer hierarchy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-browser-settings-'));
  const { app, page } = await launchElectron(directory);
  try {
    await app.evaluate(({ ipcMain }) => {
      const document = { version: 2, id: 'export-report', name: '导出报表', scope: 'user', domains: ['example.com'], params: [], outputs: [], steps: [{ id: 'open', action: 'navigate', url: 'https://example.com' }, { id: 'export', action: 'click', target: { selector: '#internal-selector', fingerprint: { tag: 'button', accessibleName: '导出报表' } } }], revision: 1, contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' };
      const detail = { document, source: 'user', trust: 'not_required', editable: true, timeline: [], revisions: [{ revision: 1, contentHash: document.contentHash, updatedAt: document.updatedAt, current: true }], replay: [], heals: [] };
      for (const channel of ['browser:recordings-list', 'browser:recording-studio-get', 'browser:recording-studio-save']) ipcMain.removeHandler(channel);
      ipcMain.handle('browser:recordings-list', () => ({ userDirectory: '/test/recordings', recordings: [{ id: document.id, name: document.name, source: 'user', trust: 'not_required', overriddenSources: [], domains: document.domains, effects: ['click'], highRisk: true, stepCount: 2, revision: document.revision, contentHash: document.contentHash, updatedAt: document.updatedAt }] }));
      ipcMain.handle('browser:recording-studio-get', () => detail);
      ipcMain.handle('browser:recording-studio-save', (_event, input) => {
        if (input.expectedRevision !== document.revision || input.expectedHash !== document.contentHash) throw new Error('版本冲突');
        document.name = input.document.name;
        document.revision += 1;
        return detail;
      });
    });
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '浏览器', exact: true }).click();
    const settings = page.getByRole('form', { name: '浏览器', exact: true });
    await expect(settings.getByText('所有设置已保存。')).toBeVisible();
    await expect(settings.locator('textarea')).toHaveCount(0);
    await expect(settings.getByText('导出报表', { exact: true })).toHaveCount(0);
    await settings.getByRole('radio', { name: /本机浏览器/ }).check();
    await expect(settings.getByText('有尚未保存的修改。')).toBeVisible();
    await settings.getByRole('button', { name: '管理网站', exact: true }).click();
    const sites = page.getByRole('dialog', { name: '无需确认即可打开的网站' });
    await sites.getByRole('textbox', { name: '添加网站' }).fill('https://example.com');
    await sites.getByRole('button', { name: '完成', exact: true }).click();
    await expect(sites.getByRole('alert')).toContainText('主机名');
    await sites.getByRole('textbox', { name: '添加网站' }).fill('EXAMPLE.COM, *.example.com');
    await sites.getByRole('button', { name: '完成', exact: true }).click();
    await expect(sites).toHaveCount(0);
    await expect(settings.getByText('2 个网站无需确认即可打开')).toBeVisible();
    await settings.getByRole('button', { name: '管理录制任务' }).click();
    const assets = page.getByRole('region', { name: '浏览器自动化', exact: true });
    await expect(assets.getByText('导出报表', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '设置分类' })).toHaveCount(0);
    await expect(assets.getByText('/test/recordings')).toHaveCount(0);
    await assets.getByRole('button', { name: '返回浏览器设置' }).click();
    await expect(settings.getByText('有尚未保存的修改。')).toBeVisible();
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    await expect(settings.getByText('所有设置已保存。')).toBeVisible();
    const saved = await page.evaluate(async () => (await window.desktopAgent.getSettings()).extensions.browser);
    expect(saved.mode).toBe('chrome');
    expect(saved.allowedDomains).toEqual(['example.com', '*.example.com']);
    await settings.getByRole('switch').click();
    await settings.getByRole('button', { name: '放弃修改' }).click();
    await expect(settings.getByRole('switch')).toBeChecked();
    await settings.getByRole('heading', { name: '浏览器', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('browser-overview.png') });
    await settings.getByRole('button', { name: '管理录制任务' }).click();
    await assets.getByRole('searchbox').fill('没有匹配');
    await expect(assets.getByText('没有匹配的录制任务。')).toBeVisible();
    await assets.getByRole('searchbox').fill('');
    await assets.getByRole('button', { name: '打开', exact: true }).click();
    await expect(assets.getByRole('heading', { name: '导出报表', exact: true })).toBeVisible();
    await expect(assets.locator('textarea')).toHaveCount(0);
    await assets.getByRole('button', { name: '步骤', exact: true }).click();
    await expect(assets.getByText('点击：导出报表')).toBeVisible();
    await expect(assets.getByText('#internal-selector')).toHaveCount(0);
    await assets.getByText('更多操作', { exact: true }).click();
    await assets.getByRole('button', { name: '开发者工具', exact: true }).click();
    const editor = assets.getByRole('textbox', { name: '录制任务 JSON 编辑器' });
    const json = JSON.parse(await editor.inputValue());
    json.name = '新的报表任务';
    await editor.fill(JSON.stringify(json));
    await assets.getByRole('button', { name: '保存新版本', exact: true }).click();
    await expect(assets.getByRole('heading', { name: '新的报表任务' })).toBeVisible();
    for (const name of ['回放调试', '选择器修复', '版本历史']) {
      await assets.getByRole('button', { name, exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath('browser-developer.png') });
    await assets.getByRole('button', { name: '返回录制任务' }).click();
    await expect(assets.getByText('新的报表任务', { exact: true })).toBeVisible();
    await assets.getByRole('button', { name: '返回浏览器设置' }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '浏览器自动化', exact: true }).click();
    await expect(assets.getByRole('heading', { name: '浏览器自动化', exact: true })).toBeVisible();
  } finally { await app.close(); }
});

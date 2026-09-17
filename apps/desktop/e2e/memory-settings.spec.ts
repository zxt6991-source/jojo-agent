import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('memory overview, draft persistence, content management and diagnostics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-settings-'));
  const { app, page } = await launchElectron(directory);
  try {
    // Stub memory IPC in the isolated test process: production Memory uses the user's
    // home directory independently of Electron's userData setting.
    await app.evaluate(({ ipcMain }) => {
      const entry = { id: 'mem_chinese', scopeId: 'global', kind: 'preference', status: 'confirmed', title: '默认使用中文回答', content: '所有回答默认使用中文。', tags: [], sourceFile: 'MEMORY.md', createdAt: 1, updatedAt: 1, contentHash: 'entry-hash', unknownMetadata: {} };
      const snapshot = { root: '/test/memory', ftsMode: 'trigram', projectAvailable: false, scopes: [{ id: 'global', kind: 'global', displayName: 'Global', directory: '/test/memory/global', version: 1, contentHash: 'scope-hash', dirty: false, warningCount: 0, entryCount: 1, entries: [entry] }], pendingCandidates: [{ id: 'memcand_test', sessionId: 'session-test', operationId: 'operation-test', scopeId: 'prj_test', scope: 'project', kind: 'rule', title: '项目使用 pnpm', content: '始终使用 pnpm。', rationale: '用户已确认的工具约定。', confidence: 'high', tags: [], state: 'pending', createdAt: 1 }] };
      for (const channel of ['memory:status', 'memory:rebuild-index', 'memory:entry-delete', 'memory:candidate-accept']) ipcMain.removeHandler(channel);
      ipcMain.handle('memory:status', () => snapshot);
      ipcMain.handle('memory:candidate-accept', (_event, input) => {
        if (!input.userConfirmed || input.candidateId !== 'memcand_test' || input.edit?.scope !== 'global') throw new Error('Candidate requires explicit review in an available scope');
        snapshot.pendingCandidates = [];
        return snapshot;
      });
      ipcMain.handle('memory:rebuild-index', () => snapshot);
      ipcMain.handle('memory:entry-delete', (_event, input) => {
        if (input.entryId !== 'mem_chinese' || input.scope !== 'global') throw new Error('Unexpected deletion');
        snapshot.scopes[0]!.entries = [];
        snapshot.scopes[0]!.entryCount = 0;
        return snapshot;
      });
    });
    await page.evaluate(async () => {
      const settings = await window.desktopAgent.getSettings();
      // The UI must still confirm deletion for legacy configurations that disable it.
      await window.desktopAgent.saveMemorySettings({ ...settings.memory, confirmDelete: false });
    });
    await page.reload();
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'Memory', exact: true }).click();
    const memoryPage = page.getByRole('form', { name: 'Memory', exact: true });
    await expect(memoryPage.getByRole('switch')).toHaveCount(4);
    await expect(memoryPage.getByText('Memory 工作正常', { exact: true })).toBeVisible();
    await expect(memoryPage.getByText('SQLite Linear Cosine', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('memory-overview.png') });

    await memoryPage.getByRole('switch', { name: '所有项目', exact: true }).click();
    await memoryPage.getByRole('tab', { name: '高级设置', exact: true }).click();
    await expect(memoryPage.getByText('有尚未保存的修改。')).toBeVisible();
    await expect(memoryPage.getByRole('combobox', { name: 'Embedding Model', exact: true })).toBeVisible();
    await memoryPage.locator('.memory-semantic-settings').screenshot({ path: test.info().outputPath('memory-selects.png') });
    await expect(memoryPage.getByText('FTS5 · Trigram', { exact: true })).toHaveCount(0);
    await memoryPage.getByRole('button', { name: '放弃修改', exact: true }).click();
    await memoryPage.getByRole('tab', { name: '概览', exact: true }).click();
    await expect(memoryPage.getByRole('switch', { name: '所有项目', exact: true })).toBeChecked();
    await memoryPage.getByRole('switch', { name: '所有项目', exact: true }).click();
    await memoryPage.getByRole('button', { name: '保存 Memory 设置', exact: true }).click();
    await expect(memoryPage.getByRole('button', { name: '保存 Memory 设置', exact: true })).toBeDisabled();
    expect(await page.evaluate(async () => (await window.desktopAgent.getSettings()).memory.globalEnabled)).toBe(false);

    await memoryPage.getByRole('tab', { name: '待确认 1', exact: true }).click();
    await expect(memoryPage.getByRole('button', { name: '保存 Memory', exact: true })).toBeDisabled();
    await expect(memoryPage.getByText('建议置信度：high', { exact: true })).toBeHidden();
    await memoryPage.getByRole('button', { name: '编辑', exact: true }).click();
    await memoryPage.getByRole('combobox', { name: '保存到', exact: true }).selectOption('global');
    await memoryPage.getByRole('button', { name: '保存 Memory', exact: true }).click();
    await expect(memoryPage.getByRole('tab', { name: '待确认 0', exact: true })).toBeVisible();

    await memoryPage.getByRole('tab', { name: '已保存', exact: true }).click();
    await expect(memoryPage.getByText('默认使用中文回答', { exact: true })).toBeVisible();
    await memoryPage.locator('.memory-saved-filters').screenshot({ path: test.info().outputPath('memory-filters.png') });
    await expect(memoryPage.getByText('Entry ID：', { exact: false })).toBeHidden();
    await memoryPage.getByRole('searchbox').fill('不匹配');
    await expect(memoryPage.getByText('默认使用中文回答', { exact: true })).toHaveCount(0);
    await memoryPage.getByRole('searchbox').fill('中文');
    await memoryPage.getByRole('button', { name: '删除 默认使用中文回答', exact: true }).click();
    await expect(memoryPage.getByText('确定删除这条 Memory？', { exact: true })).toBeVisible();
    expect(await page.evaluate(async () => (await window.desktopAgent.getMemoryStatus()).scopes.find((scope) => scope.kind === 'global')?.entryCount)).toBe(1);
    await memoryPage.getByRole('button', { name: '取消', exact: true }).click();
    await memoryPage.getByRole('button', { name: '删除 默认使用中文回答', exact: true }).click();
    await memoryPage.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(memoryPage.getByText('默认使用中文回答', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(async () => (await window.desktopAgent.getMemoryStatus()).scopes.find((scope) => scope.kind === 'global')?.entryCount)).toBe(0);

    await memoryPage.getByRole('tab', { name: '高级设置', exact: true }).click();
    const providerId = await page.evaluate(async () => (await window.desktopAgent.getSettings()).providers[0]!.id);
    await memoryPage.getByRole('switch', { name: '启用增强记忆搜索', exact: true }).click();
    const embeddingProvider = memoryPage.locator('.memory-semantic-settings').getByRole('combobox', { name: 'Provider', exact: true });
    await embeddingProvider.selectOption(providerId);
    const consent = memoryPage.getByRole('switch', { name: '允许发送到远程 Embedding Provider', exact: true });
    await expect(consent).not.toBeChecked();
    await consent.click();
    await expect(consent).toBeChecked();
    await embeddingProvider.selectOption('');
    await embeddingProvider.selectOption(providerId);
    await expect(consent).not.toBeChecked();
    await memoryPage.getByRole('button', { name: '放弃修改', exact: true }).click();
    await memoryPage.getByRole('button', { name: '诊断与索引修复', exact: true }).click();
    await expect(memoryPage.getByRole('button', { name: '修复索引', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('memory-advanced.png') });
    await memoryPage.getByRole('button', { name: '修复索引', exact: true }).click();
    await expect(memoryPage.getByRole('button', { name: '修复索引', exact: true })).toBeEnabled();
  } finally {
    await app.close();
  }
});

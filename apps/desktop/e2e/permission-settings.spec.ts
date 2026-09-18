import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('permission preferences preserve rules, restore inheritance and explain decisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-permission-settings-'));
  const { app, page } = await launchElectron(directory);
  try {
    await page.evaluate((workingDirectory) => window.desktopAgent.createSession({ title: '权限设置测试', workingDirectory }), directory);
    await page.getByPlaceholder('随心输入').fill('E2E: approval allow');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '选择允许范围' }).click();
    await page.getByRole('menuitem', { name: '允许一次' }).click();
    await expect(page.getByText('approval handled')).toBeVisible();
    const sessions = await page.evaluate(() => window.desktopAgent.listSessions());
    const workingDirectory = sessions[0]!.workingDirectory;
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '权限', exact: true }).click();
    const settings = page.getByRole('tabpanel', { name: '权限策略' });
    await expect(settings.getByRole('radio', { name: /每次确认/ })).toBeChecked();
    await expect(settings.getByRole('textbox', { name: '策略 JSON' })).not.toBeVisible();
    await settings.getByRole('radio', { name: /智能自动/ }).check();
    await expect(settings.getByText('你有未保存的更改', { exact: true })).toBeVisible();
    await page.evaluate(() => { window.confirm = () => false; });
    await page.getByRole('button', { name: '模型', exact: true }).click();
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '保存更改' }).click();
    await expect(settings.getByText('所有更改已保存', { exact: true })).toBeVisible();

    await settings.getByRole('button', { name: '添加例外规则', exact: true }).click();
    const builder = settings.getByRole('region', { name: '添加例外规则' });
    await builder.getByLabel('1. 你想控制哪类操作？').selectOption({ label: '定时任务使用密钥' });
    await page.getByRole('tab', { name: '活动记录' }).click();
    await page.getByRole('tab', { name: '权限策略' }).click();
    await expect(builder.getByLabel('1. 你想控制哪类操作？')).toHaveValue('3');
    await builder.getByRole('button', { name: '应用到草稿' }).click();
    await settings.getByRole('button', { name: '添加例外规则', exact: true }).click();
    await builder.getByLabel('1. 你想控制哪类操作？').selectOption({ label: '终端使用主机网络' });
    await builder.getByRole('button', { name: '应用到草稿' }).click();
    await settings.getByRole('button', { name: '上移规则 2', exact: true }).click();
    await settings.getByRole('button', { name: '编辑规则 1', exact: true }).click();
    await settings.getByRole('region', { name: '编辑例外规则' }).getByLabel('遇到这种行为时').selectOption('deny');
    await settings.getByRole('button', { name: '应用到草稿' }).click();
    await settings.getByRole('button', { name: '保存更改' }).click();
    await expect(settings.getByText('所有更改已保存', { exact: true })).toBeVisible();
    const saved = await page.evaluate(() => window.desktopAgent.getPermissionGovernance());
    expect(saved.global.document.rules.map((rule) => rule.effect)).toEqual(['deny', 'deny']);
    expect(saved.global.document.rules[0]!.match.network).toBe('host');

    await settings.getByText('高级设置', { exact: true }).click();
    const editor = settings.getByRole('textbox', { name: '策略 JSON' });
    const validJson = await editor.inputValue();
    await editor.fill('{bad');
    await expect(settings.getByRole('button', { name: '保存更改' })).toBeDisabled();
    await expect(settings.getByRole('button', { name: '添加例外规则', exact: true })).toBeDisabled();
    await editor.fill(validJson);
    await settings.getByText('高级设置', { exact: true }).click();
    await settings.getByRole('button', { name: /^当前项目/ }).click();
    await expect(settings.getByText('正在继承“所有项目”的确认策略和例外规则。')).toBeVisible();
    await expect(settings.getByRole('radio', { name: /智能自动/ })).toBeDisabled();
    await settings.getByRole('button', { name: '为此项目单独设置' }).click();
    await settings.getByRole('radio', { name: /尽量自动/ }).check();
    await settings.getByRole('button', { name: '保存更改' }).click();
    await expect(settings.getByRole('button', { name: '恢复继承所有项目设置' })).toBeVisible();
    const overridden = await page.evaluate((workingDirectory) => window.desktopAgent.getPermissionGovernance({ workingDirectory }), workingDirectory);
    expect(overridden.effective).toMatchObject({ mode: 'yolo', modeSource: 'workspace', globalRuleCount: 2, workspaceRuleCount: 0 });
    await page.evaluate(() => { window.confirm = () => true; });
    await settings.getByRole('button', { name: '恢复继承所有项目设置' }).click();
    await expect(settings.getByText('正在继承“所有项目”的确认策略和例外规则。')).toBeVisible();
    const inherited = await page.evaluate((workingDirectory) => window.desktopAgent.getPermissionGovernance({ workingDirectory }), workingDirectory);
    expect(inherited.workspace).toBeUndefined();
    expect(inherited.effective).toMatchObject({ mode: 'auto', modeSource: 'global', globalRuleCount: 2 });
    await page.screenshot({ path: test.info().outputPath('permission-policy.png') });

    await page.getByRole('tab', { name: '活动记录' }).click();
    const activity = page.getByRole('region', { name: '权限活动' });
    await expect(activity.getByText('基础权限检查要求你先确认这次操作。')).toBeVisible();
    await expect(activity.getByText('requestFingerprint', { exact: false })).not.toBeVisible();
    await activity.getByText('查看技术详情', { exact: true }).first().click();
    await expect(activity.locator('pre').first()).toContainText('requestFingerprint');
    await activity.getByLabel('搜索工具或原因').fill('没有匹配的工具');
    await expect(activity.getByText('没有符合筛选条件的记录。')).toBeVisible();
    await activity.getByLabel('搜索工具或原因').fill('');
    await activity.getByLabel('结果', { exact: true }).selectOption('deny');
    await expect(activity.getByText('没有符合筛选条件的记录。')).toBeVisible();
    await activity.getByLabel('结果', { exact: true }).selectOption('all');
    await page.screenshot({ path: test.info().outputPath('permission-activity.png') });
  } finally {
    // Electron's native beforeunload dialog is not controlled by CDP. Avoid
    // masking a failed assertion with a dialog error while closing the test app.
    await page.evaluate(() => window.addEventListener('beforeunload', (event) => event.stopImmediatePropagation(), { capture: true })).catch(() => undefined);
    await app.close();
  }
});

test('unbound conversations cannot accidentally configure a project policy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-permission-unbound-'));
  const { app, page } = await launchElectron(directory);
  try {
    await page.getByRole('button', { name: '新建对话' }).click();
    await expect(page.getByPlaceholder('随心输入')).toBeVisible();
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '权限', exact: true }).click();
    const settings = page.getByRole('tabpanel', { name: '权限策略' });
    await expect(settings.getByRole('button', { name: '当前项目', exact: true })).toBeDisabled();
    await expect(settings.getByRole('button', { name: '所有项目', exact: true })).toBeEnabled();
  } finally { await app.close(); }
});

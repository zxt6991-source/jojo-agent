import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';
import type { ConversationMapResult, SessionMeta } from '@desktop-agent/contracts';

test('generates a map from durable conversations and opens the exact evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-conversation-map-'));
  const { app, page } = await launchElectron(directory);
  try {
    await page.getByRole('button', { name: '新建对话' }).click();
    await page.getByPlaceholder('随心输入').fill('讨论 Jojo 设置页的交流脉络设计');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('hello from offline e2e')).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
    const second = await page.evaluate(() => window.desktopAgent.createSession({ title: '继续讨论' }));
    await page.getByRole('button', { name: second!.title, exact: true }).click();
    await page.getByPlaceholder('随心输入').fill('继续讨论 Jojo 设置页布局');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('hello from offline e2e')).toBeVisible();
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '交流脉络', exact: true }).click();
    const view = page.getByTestId('conversation-map-page');
    await expect(view.getByRole('button', { name: '最近30天', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await view.getByRole('button', { name: '生成脉络图', exact: true }).click();
    await expect(view.getByLabel('主题列表').getByRole('button').first()).toBeVisible();
    await expect(view.getByTestId('conversation-map-overview-diagram').locator('svg')).toBeVisible();
    await expect(view.getByTestId('conversation-map-flow-diagram').locator('svg')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('conversation-map.png'), fullPage: true });
    await view.getByRole('button', { name: '最近7天', exact: true }).click();
    await expect(view.getByText(/筛选条件或当前项目已更改/)).toBeVisible();
    await view.getByLabel('交流步骤').getByRole('button').first().click();
    await view.getByRole('button', { name: /用户原文/ }).first().click();
    await expect(view.getByLabel('原始证据')).toContainText('Jojo');
    await view.getByRole('button', { name: '查看原始对话', exact: true }).click();
    await expect(page.getByTestId('conversation-map-page')).toHaveCount(0);
    await expect(page.locator('[data-node-id]').filter({ hasText: '讨论 Jojo 设置页的交流脉络设计' }).first()).toBeVisible();
  } finally { await app.close(); }
});

test('empty history does not invent topics and cancelled generation cannot publish stale results', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-conversation-map-empty-'));
  const { app, page } = await launchElectron(directory);
  try {
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '交流脉络', exact: true }).click();
    const view = page.getByTestId('conversation-map-page');
    await view.getByRole('button', { name: '生成脉络图', exact: true }).click();
    await expect(view.getByText(/所选范围内暂无符合条件的文本对话/)).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('conversation-map:generate');
      ipcMain.handle('conversation-map:generate', (event, input) => {
        event.sender.send('conversation-map:event', { type: 'conversation-map.progress', requestId: input.requestId, phase: 'extracting' });
        setTimeout(() => event.sender.send('conversation-map:event', {
          type: 'conversation-map.failed', requestId: input.requestId, code: 'late', message: 'STALE_FAILURE_SHOULD_BE_IGNORED'
        }), 500);
      });
    });
    await view.getByRole('button', { name: /生成脉络图/ }).click();
    await view.getByRole('button', { name: '取消生成', exact: true }).click();
    await page.waitForTimeout(650);
    await expect(view.getByText('STALE_FAILURE_SHOULD_BE_IGNORED')).toHaveCount(0);
    await expect(view.getByRole('button', { name: /生成脉络图/ })).toBeEnabled();
  } finally { await app.close(); }
});

test('isolates project history and invalidates evidence after session deletion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-map-scope-'));
  const projectA = await mkdtemp(path.join(os.tmpdir(), 'jojo-map-project-a-'));
  const projectB = await mkdtemp(path.join(os.tmpdir(), 'jojo-map-project-b-'));
  const { app, page } = await launchElectron(directory);
  try {
    const sessions: SessionMeta[] = [];
    for (const [index, workingDirectory] of [projectA, projectB].entries()) {
      const session = await page.evaluate(input => window.desktopAgent.createSession(input), { title: `项目 ${index}`, workingDirectory });
      sessions.push(session!);
      await page.getByRole('button', { name: session!.title, exact: true }).click();
      await page.getByPlaceholder('随心输入').fill(`讨论项目 ${index} 的开发计划`);
      await page.getByRole('button', { name: '发送消息' }).click();
      await expect(page.getByText('hello from offline e2e')).toBeVisible();
      await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
    }
    const result = await page.evaluate(({ sessionId, workingDirectory }) => new Promise<ConversationMapResult>((resolve, reject) => {
      const requestId = 'scope-test';
      const stop = window.desktopAgent.onConversationMapEvent(event => {
        if (event.requestId !== requestId) return;
        if (event.type === 'conversation-map.completed') { stop(); resolve(event.result); }
        if (event.type === 'conversation-map.failed') { stop(); reject(new Error(event.message)); }
      });
      void window.desktopAgent.generateConversationMap({ requestId, range: '30d', scope: { kind: 'project', workingDirectory }, currentSessionId: sessionId }).catch(error => { stop(); reject(error); });
    }), { sessionId: sessions[0]!.id, workingDirectory: projectA });
    expect(result.analyzedSessionCount).toBe(1);
    const references = result.topics.flatMap(topic => topic.steps.flatMap(step => step.references));
    expect(references.every(ref => ref.sessionId === sessions[0]!.id)).toBe(true);
    const input = { requestId: 'scope-test', sessionId: references[0]!.sessionId, entryId: references[0]!.entryId };
    expect(await page.evaluate(value => window.desktopAgent.getConversationMapSource(value), input)).toMatchObject({ available: true });
    await page.evaluate(id => window.desktopAgent.deleteSession(id), sessions[0]!.id);
    expect(await page.evaluate(value => window.desktopAgent.getConversationMapSource(value), input)).toEqual({ available: false });
  } finally { await app.close(); }
});

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';
import type { ConversationMapResult, ConversationMapResultV2, SessionMeta } from '@desktop-agent/contracts';

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
    await expect(view.getByLabel('主题洞察')).toContainText('当前结论');
    await expect(view.getByRole('button', { name: /展开.*事件/ })).toHaveCount(0);
    await expect(view.locator('#conversation-map-events ol')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('conversation-map.png'), fullPage: true });
    await view.getByRole('button', { name: '最近7天', exact: true }).click();
    await expect(view.getByText(/筛选条件或当前项目已更改/)).toBeVisible();
    await view.getByLabel('全部事件', { exact: true }).getByRole('button').first().click();
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
    await view.getByRole('button', { name: /生成脉络图/ }).click();
    await view.getByRole('button', { name: '最近7天', exact: true }).click();
    await expect(view.getByText('已取消生成。可以调整范围后重新生成。')).toBeVisible();
    await expect(view.getByRole('button', { name: '取消生成', exact: true })).toHaveCount(0);
    await page.waitForTimeout(650);
    await expect(view.getByText('STALE_FAILURE_SHOULD_BE_IGNORED')).toHaveCount(0);
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
    expect(result.version).toBe(2);
    const references = result.version === 2 ? result.topics.flatMap(topic => topic.events.flatMap(event => event.evidence.map(item => item.reference))) : result.topics.flatMap(topic => topic.steps.flatMap(step => step.references));
    expect(references.every(ref => ref.sessionId === sessions[0]!.id)).toBe(true);
    const input = { requestId: 'scope-test', sessionId: references[0]!.sessionId, entryId: references[0]!.entryId };
    expect(await page.evaluate(value => window.desktopAgent.getConversationMapSource(value), input)).toMatchObject({ available: true });
    await page.evaluate(id => window.desktopAgent.deleteSession(id), sessions[0]!.id);
    expect(await page.evaluate(value => window.desktopAgent.getConversationMapSource(value), input)).toEqual({ available: false });
  } finally { await app.close(); }
});


test('V2 insights expose both endpoints, expand details and clear conclusions when a source is revoked', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-map-v2-evidence-'));
  const { app, page } = await launchElectron(directory);
  try {
    const before = { sessionId: 'old-session', entryId: 'old-entry', seq: 1, createdAt: '2026-10-20T10:00:00.000Z', role: 'user' as const };
    const after = { ...before, sessionId: 'new-session', entryId: 'new-entry', createdAt: '2026-10-21T10:00:00.000Z' };
    const originalClaim = '- **生成方式**：我考虑自动生成，但只有在费用可控时才考虑启用；目前尚未决定，也还没有开始执行。';
    const readableSummary = '费用可控时考虑自动生成，尚未决定。';
    const result: ConversationMapResultV2 = {
      version: 2, generatedAt: after.createdAt, rangeStart: before.createdAt, rangeEnd: '2026-10-22T10:00:00.000Z',
      scopeKind: 'personal_main', analyzedTurnCount: 3, analyzedSessionCount: 2, modelCallCount: 2, truncated: true, omittedEventCount: 0, omittedTurnCount: 2,
      topics: [{
        id: 'topic', title: '回顾功能', summary: '历史回顾的生成方式', visibleEventIds: ['old', 'new'],
        events: [
          { id: 'old', topicId: 'topic', subjectKey: 'history', dimensionKey: 'trigger', subjectLabel: '回顾功能', dimensionLabel: '生成方式', eventType: 'position', speaker: 'user', state: 'considering', claim: originalClaim, summary: readableSummary, occurredAt: before.createdAt, evidence: [{ reference: before, quote: originalClaim }], truncatedSource: false },
          { id: 'new', topicId: 'topic', subjectKey: 'history', dimensionKey: 'trigger', subjectLabel: '回顾功能', dimensionLabel: '生成方式', eventType: 'decision', speaker: 'user', state: 'decided', claim: '选择手动生成', summary: '选择手动生成', occurredAt: after.createdAt, evidence: [{ reference: after, quote: '决定改为手动生成' }], truncatedSource: false },
          { id: 'detail', topicId: 'topic', subjectKey: 'history', dimensionKey: 'placement', subjectLabel: '回顾功能', dimensionLabel: '入口位置', eventType: 'option', speaker: 'assistant', state: 'considering', claim: '建议放在设置页', occurredAt: after.createdAt, evidence: [{ reference: { ...after, entryId: 'assistant-entry', role: 'assistant', seq: 2 }, quote: '可以放在设置页' }], truncatedSource: false }
        ],
        changes: [{ id: 'change', topicId: 'topic', fromEventId: 'old', toEventId: 'new', relation: 'revised', explanation: '从自动改为手动生成' }],
        insights: [
          { id: 'change-insight', kind: 'key_change', text: '生成方式从自动改为手动', supportingEventIds: [], supportingChangeIds: ['change'] },
          { id: 'current', kind: 'current_state', text: '用户已决定手动生成；聊天中未确认执行', supportingEventIds: ['new'], supportingChangeIds: [] }
        ]
      }]
    };
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('conversation-map:generate');
      ipcMain.handle('conversation-map:generate', (event, input) => {
        event.sender.send('conversation-map:event', { type: 'conversation-map.completed', requestId: input.requestId, result: value });
      });
      ipcMain.removeHandler('conversation-map:source');
      ipcMain.handle('conversation-map:source', () => ({ available: false }));
    }, result);
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: '交流脉络', exact: true }).click();
    const view = page.getByTestId('conversation-map-page');
    await expect(view.getByLabel('主题洞察')).toHaveCount(0);
    await view.getByRole('button', { name: '生成脉络图', exact: true }).click();
    await expect(view.getByText(/本次回顾不完整：已分析 3 轮，另有 2 轮未分析/)).toBeVisible();
    await expect(view.getByText(/以下结论仅基于成功分析的记录，可能遗漏后续变化/)).toBeVisible();
    await expect(view.getByTestId('conversation-map-flow-diagram').locator('svg')).toBeVisible();
    const flow = view.getByTestId('conversation-map-flow-diagram');
    await expect(flow.locator('svg')).not.toContainText('AI 摘要');
    await expect(flow.locator('svg .nodes')).toContainText('回顾功能');
    for (const metadata of ['2026/10/20', '2026/10/21', '用户 ·', '已决定', '生成方式']) await expect(flow.locator('svg .nodes')).not.toContainText(metadata);
    await expect(flow.locator('svg')).toContainText(readableSummary);
    await expect(flow.locator('svg')).not.toContainText('**');
    await expect(flow.locator('svg')).not.toContainText('也还没有开始执行');
    const stages = view.getByLabel('关键阶段', { exact: true });
    await expect(stages).toContainText(readableSummary);
    await expect(stages).not.toContainText(originalClaim);
    await expect(stages.locator('time')).toHaveCount(0);
    await expect(stages.locator('.conversation-map-step-kind')).toHaveCount(0);
    await expect(stages).not.toContainText('AI 摘要');
    const openReader = flow.getByRole('button', { name: '全屏阅读', exact: true });
    await openReader.click();
    const reader = page.getByRole('dialog', { name: /关键历程/ });
    await expect(reader).toBeVisible();
    await expect(reader.locator('svg')).toBeVisible();
    await expect(reader.getByLabel('缩放比例', { exact: true })).toHaveText('100%');
    await expect(flow.locator('svg')).toHaveCount(1);
    const readerBounds = await reader.boundingBox();
    const windowSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(readerBounds?.x).toBe(0);
    expect(readerBounds?.y).toBe(0);
    expect(readerBounds?.width).toBe(windowSize.width);
    expect(readerBounds?.height).toBe(windowSize.height);
    const diagramWidth = () => reader.locator('svg').evaluate(svg => svg.getBoundingClientRect().width);
    const originalWidth = await diagramWidth();
    expect(originalWidth).toBeGreaterThan(0);
    const svgHandle = await reader.locator('svg').elementHandle();
    await reader.getByRole('button', { name: '放大', exact: true }).click();
    await expect(reader.getByLabel('缩放比例', { exact: true })).toHaveText('110%');
    await expect.poll(diagramWidth).toBeCloseTo(originalWidth * 1.1, 0);
    expect(await reader.locator('svg').evaluate((svg, original) => svg === original, svgHandle)).toBe(true);
    await svgHandle?.dispose();
    await reader.getByRole('button', { name: '缩小', exact: true }).click();
    await expect(reader.getByLabel('缩放比例', { exact: true })).toHaveText('100%');
    await reader.getByRole('button', { name: '适合窗口', exact: true }).click();
    await expect(reader.getByRole('button', { name: '适合窗口', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await reader.getByRole('button', { name: '原始大小', exact: true }).click();
    await expect(reader.getByLabel('缩放比例', { exact: true })).toHaveText('100%');
    await page.screenshot({ path: test.info().outputPath('conversation-map-fullscreen.png') });
    await page.keyboard.press('Escape');
    await expect(reader).not.toBeVisible();
    await expect(openReader).toBeFocused();
    await expect(flow.locator('svg')).toHaveCount(1);
    const preview = flow.getByRole('button', { name: /关键历程，全屏阅读/ });
    await preview.click();
    await expect(reader).toBeVisible();
    await reader.getByRole('button', { name: '关闭全屏阅读', exact: true }).click();
    await expect(reader).not.toBeVisible();
    await expect(preview).toBeFocused();
    await expect(view.getByLabel('关键阶段', { exact: true }).getByRole('button')).toHaveCount(2);
    await view.getByLabel('主题洞察').getByRole('button', { name: /查看变化证据/ }).click();
    const evidence = view.getByLabel('节点信息');
    await expect(evidence.locator('blockquote').first()).toHaveText(originalClaim);
    await expect(evidence).toContainText('我考虑自动生成');
    await expect(evidence).toContainText('决定改为手动生成');
    await expect(evidence.getByRole('button', { name: /用户原文/ })).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath('conversation-map-v2.png'), fullPage: true });
    await view.getByRole('button', { name: '展开其余事件（1）', exact: true }).click();
    await expect(view.getByLabel('全部事件', { exact: true }).getByRole('button')).toHaveCount(3);
    await expect(view.getByLabel('关键阶段', { exact: true })).toHaveCount(0);
    await expect(view.locator('#conversation-map-events ol')).toHaveCount(1);
    await expect(view.getByRole('button', { name: '收起为关键阶段（2）', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await view.getByRole('button', { name: '收起为关键阶段（2）', exact: true }).click();
    await expect(view.getByLabel('关键阶段', { exact: true }).getByRole('button')).toHaveCount(2);
    await expect(view.getByLabel('全部事件', { exact: true })).toHaveCount(0);
    await view.getByRole('button', { name: '展开其余事件（1）', exact: true }).click();
    await view.getByLabel('全部事件', { exact: true }).getByRole('button', { name: /建议放在设置页/ }).click();
    await expect(evidence).toContainText('可以放在设置页');
    await view.getByRole('button', { name: '重新生成脉络图', exact: true }).click();
    await expect(view.getByLabel('关键阶段', { exact: true }).getByRole('button')).toHaveCount(2);
    await expect(view.getByRole('button', { name: '展开其余事件（1）', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(evidence).toContainText('我考虑自动生成');
    await expect(evidence).not.toContainText('可以放在设置页');
    await view.getByRole('button', { name: '展开其余事件（1）', exact: true }).click();
    await view.getByLabel('全部事件', { exact: true }).getByRole('button', { name: /建议放在设置页/ }).click();
    await expect(evidence).toContainText('可以放在设置页');
    await expect(evidence.getByRole('button', { name: /AI 回复原文/ })).toBeVisible();
    await evidence.getByRole('button', { name: /AI 回复原文/ }).click();
    await expect(view.getByText(/旧图与相关结论已清除/)).toBeVisible();
    await expect(view.getByLabel('主题洞察')).toHaveCount(0);
    await expect(view.getByLabel('节点信息')).toHaveCount(0);
    await expect(view.getByTestId('conversation-map-flow-diagram')).toHaveCount(0);
  } finally { await app.close(); }
});

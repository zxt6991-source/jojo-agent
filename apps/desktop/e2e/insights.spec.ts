import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { InsightAnalysisPerspective, InsightEvent, InsightResult } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

async function generate(page: Page, perspective: InsightAnalysisPerspective): Promise<InsightResult> {
  return page.evaluate(perspective => new Promise<InsightResult>((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const unsubscribe = window.desktopAgent.onInsightEvent(event => {
      if (event.requestId !== requestId) return;
      if (event.type === 'insight.completed') { unsubscribe(); resolve(event.result); }
      if (event.type === 'insight.failed') { unsubscribe(); reject(new Error(event.message)); }
      if (event.type === 'insight.cancelled') { unsubscribe(); reject(new Error('Unexpected cancellation')); }
    });
    void window.desktopAgent.generateInsight({ requestId, range: '30d', scope: { kind: 'personal_main' }, perspective })
      .catch(error => { unsubscribe(); reject(error); });
  }), perspective);
}

test('settings opens an idle insight center and all three perspectives support empty history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insights-empty-'));
  const { app, page } = await launchElectron(directory);
  try {
    await page.evaluate(() => {
      const state = window as unknown as { insightEvents: InsightEvent[] };
      state.insightEvents = [];
      window.desktopAgent.onInsightEvent(event => state.insightEvents.push(event));
    });
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    const view = page.getByTestId('insight-center-page');
    await expect(view.getByRole('heading', { name: 'AI 洞察中心', exact: true })).toBeVisible();
    await expect(view.getByRole('button', { name: '最近30天', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(view.getByLabel('数据范围')).toHaveValue('personal_main');
    await expect(view.getByLabel('数据范围').locator('option')).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { insightEvents: InsightEvent[] }).insightEvents)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('insight-center.png'), fullPage: true });

    for (const name of ['逆向思考', '二阶思考', '思维盲点']) {
      await view.getByRole('button', { name: new RegExp(name) }).click();
      await expect(view.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(view.getByRole('heading', { name: '所选范围内暂无足够历史内容', exact: true })).toBeVisible();
      await expect(view.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
      await expect(view.getByLabel('洞察结果')).toContainText('已分析 0 轮 · 0 个会话');
      await view.getByRole('button', { name: '← 返回洞察中心', exact: true }).click();
    }
    const events = await page.evaluate(() => (window as unknown as { insightEvents: InsightEvent[] }).insightEvents);
    expect(events.filter(event => event.type === 'insight.completed')).toHaveLength(3);
    expect(events.filter(event => event.type === 'insight.failed')).toEqual([]);

    await view.getByRole('button', { name: /交流脉络/ }).click();
    const map = page.getByTestId('conversation-map-page');
    await expect(map).toBeVisible();
    await map.getByRole('button', { name: '生成脉络图', exact: true }).click();
    await expect(map.getByText(/所选范围内暂无符合条件的文本对话/)).toBeVisible();
    await page.getByRole('button', { name: '← 返回洞察中心', exact: true }).click();
    await expect(view.getByRole('heading', { name: 'AI 洞察中心', exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test('real insight IPC returns validated results and rejects unavailable project scope and forged sources', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insights-ipc-'));
  const { app, page } = await launchElectron(directory);
  try {
    const first = await generate(page, 'reverse_thinking');
    expect(first).toMatchObject({ version: 1, perspective: 'reverse_thinking', cards: [], analyzedTurnCount: 0, modelCallCount: 0 });
    const second = await generate(page, 'second_order');
    expect(second).toMatchObject({ version: 1, perspective: 'second_order', cards: [], analyzedTurnCount: 0, modelCallCount: 0 });
    // Exact rolling windows can reuse extraction while the source set is unchanged.
    expect(second.semanticCacheHit).toBe(true);
    expect(await page.evaluate(() => window.desktopAgent.getInsightSource({ requestId: 'forged', sessionId: 'private', entryId: 'missing' }))).toEqual({ available: false });
    const failure = await page.evaluate(() => new Promise<InsightEvent>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const stop = window.desktopAgent.onInsightEvent(event => {
        if (event.requestId !== requestId || event.type === 'insight.progress') return;
        stop(); resolve(event);
      });
      void window.desktopAgent.generateInsight({ requestId, perspective: 'blind_spots', range: '30d', scope: { kind: 'project', workingDirectory: '/not-authorized' }, currentSessionId: 'missing' })
        .catch(error => { stop(); reject(error); });
    }));
    expect(failure.type).toBe('insight.failed');
    if (failure.type === 'insight.failed') expect(failure.message).toContain('当前项目');
    // A failed authorization must release the shared analysis slot for retry.
    expect(await generate(page, 'blind_spots')).toMatchObject({ perspective: 'blind_spots', cards: [] });
  } finally { await app.close(); }
});

test('switching perspectives does not show the previous result while running or after failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insights-switch-'));
  const { app, page } = await launchElectron(directory);
  try {
    const result: InsightResult = {
      version: 1, perspective: 'reverse_thinking', generatedAt: '2026-10-27T01:00:00.000Z',
      rangeStart: '2026-09-27T01:00:00.000Z', rangeEnd: '2026-10-27T01:00:00.000Z', scopeKind: 'personal_main',
      analyzedTurnCount: 42, analyzedSessionCount: 9, modelCallCount: 0, semanticCacheHit: false,
      truncated: false, omittedTurnCount: 0, cards: []
    };
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('insight:generate');
      ipcMain.handle('insight:generate', (event, input) => {
        if (input.perspective === 'reverse_thinking') {
          event.sender.send('insight:event', { type: 'insight.completed', requestId: input.requestId, result: value });
        } else if (input.perspective === 'second_order') {
          event.sender.send('insight:event', { type: 'insight.progress', requestId: input.requestId, phase: 'analyzing' });
        } else {
          event.sender.send('insight:event', { type: 'insight.failed', requestId: input.requestId, code: 'test_failure', message: '测试分析失败' });
        }
      });
    }, result);
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    const view = page.getByTestId('insight-center-page');
    await view.getByRole('button', { name: /逆向思考/ }).click();
    await expect(view.getByLabel('洞察结果')).toContainText('已分析 42 轮 · 9 个会话');
    await view.getByRole('button', { name: '← 返回洞察中心', exact: true }).click();
    await view.getByRole('button', { name: /二阶思考/ }).click();
    await expect(view.getByRole('progressbar', { name: '洞察生成进度' })).toBeVisible();
    await expect(view).not.toContainText('已分析 42 轮 · 9 个会话');
    await view.getByRole('button', { name: '← 返回洞察中心', exact: true }).click();
    await view.getByRole('button', { name: /思维盲点/ }).click();
    await expect(view.getByRole('alert')).toContainText('测试分析失败');
    await expect(view).not.toContainText('已分析 42 轮 · 9 个会话');
  } finally { await app.close(); }
});

for (const partial of [
  { name: 'omitted turns', analyzedTurnCount: 6, analyzedSessionCount: 1, omittedTurnCount: 15,
    heading: '部分对话分析未完成，暂时无法形成洞察', detail: '另有 15 轮未分析',
    recovery: '重新生成会重新分析所选范围，包括本次未能分析的对话' },
  { name: 'lost sources or candidates', analyzedTurnCount: 21, analyzedSessionCount: 8, omittedTurnCount: 0,
    heading: '分析结果不完整，暂时无法形成洞察', detail: '部分来源或候选事件被截断或未通过校验',
    recovery: '当前结果无法判断是否有充分证据支持洞察' }
]) test(`partial extraction with ${partial.name} and no cards offers retry and model settings`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insights-partial-'));
  const { app, page } = await launchElectron(directory);
  try {
    const result: InsightResult = {
      version: 1, perspective: 'reverse_thinking', generatedAt: '2026-10-27T01:00:00.000Z',
      rangeStart: '2026-10-20T01:00:00.000Z', rangeEnd: '2026-10-27T01:00:00.000Z', scopeKind: 'personal_main',
      analyzedTurnCount: partial.analyzedTurnCount, analyzedSessionCount: partial.analyzedSessionCount, modelCallCount: 2, semanticCacheHit: false,
      truncated: true, omittedTurnCount: partial.omittedTurnCount, cards: []
    };
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('insight:generate');
      ipcMain.handle('insight:generate', (event, input) => {
        event.sender.send('insight:event', { type: 'insight.completed', requestId: input.requestId, result: value });
      });
    }, result);
    await page.evaluate(() => {
      const state = window as unknown as { insightAttempts: string[] };
      state.insightAttempts = [];
      window.desktopAgent.onInsightEvent(event => {
        if (event.type === 'insight.completed') state.insightAttempts.push(event.requestId);
      });
    });
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    const view = page.getByTestId('insight-center-page');
    await view.getByRole('button', { name: '最近7天', exact: true }).click();
    await view.getByRole('button', { name: /逆向思考/ }).click();
    const output = view.getByLabel('洞察结果', { exact: true });
    await expect(output).toContainText(`已分析 ${partial.analyzedTurnCount} 轮 · ${partial.analyzedSessionCount} 个会话`);
    await expect(output).toContainText(partial.detail);
    await expect(output.getByRole('heading', { name: partial.heading, exact: true })).toBeVisible();
    await expect(output).not.toContainText('未找到有充分证据的洞察');
    await expect(output).not.toContainText('所选范围内暂无足够历史内容');
    await expect(output).not.toContainText('当前范围内没有足够证据');
    await expect(output).not.toContainText('另有 0 轮未分析');
    await expect(output).toContainText(partial.recovery);
    await output.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { insightAttempts: string[] }).insightAttempts.length)).toBe(2);
    expect(new Set(await page.evaluate(() => (window as unknown as { insightAttempts: string[] }).insightAttempts)).size).toBe(2);
    await output.getByRole('button', { name: '检查模型配置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '模型', level: 1, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    await expect(view.getByRole('button', { name: '最近7天', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally { await app.close(); }
});

test('coverage distinguishes an ineligible perspective from a clipped assistant response', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insights-coverage-'));
  const { app, page } = await launchElectron(directory);
  try {
    const result: InsightResult = {
      version: 1, perspective: 'reverse_thinking', generatedAt: '2026-10-27T15:32:00.000Z',
      rangeStart: '2026-09-27T15:32:00.000Z', rangeEnd: '2026-10-27T15:32:00.000Z', scopeKind: 'personal_main',
      analyzedTurnCount: 21, analyzedSessionCount: 8, modelCallCount: 2, semanticCacheHit: false,
      truncated: true, omittedTurnCount: 0, cards: [], emptyReason: 'no_eligible_events',
      coverage: { extractedEventCount: 8, eligibleEventCount: 0, selectedEventCount: 0, omittedEventCount: 0, omittedCardCount: 0,
        truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1, omittedAssistantMessageCount: 0,
        unknownSourceTruncation: false, analysisPerformed: false }
    };
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('insight:generate');
      ipcMain.handle('insight:generate', (event, input) => {
        event.sender.send('insight:event', { type: 'insight.completed', requestId: input.requestId, result: value });
      });
    }, result);
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    const view = page.getByTestId('insight-center-page');
    await view.getByRole('button', { name: /逆向思考/ }).click();
    const output = view.getByLabel('洞察结果', { exact: true });
    await expect(output.getByRole('heading', { name: '尚未提取到可检验的具体问题、方案、观点或约束', exact: true })).toBeVisible();
    await expect(output).toContainText('已分析 21 轮 · 8 个会话');
    await expect(output).toContainText('1 条 AI 回复仅分析了部分内容');
    await expect(output).toContainText('用户输入已完整读取');
    await expect(output).toContainText('本次未调用洞察生成模型');
    await expect(output).not.toContainText('本次分析不完整');
    await expect(output.getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0);
    await expect(output.getByRole('button', { name: '检查模型配置', exact: true })).toHaveCount(0);
    const details = output.locator('details');
    await expect(details).not.toHaveAttribute('open');
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open');
    await expect(details.getByText('符合当前视角', { exact: true }).locator('..')).toHaveText('符合当前视角0');
    await expect(details.getByText('洞察生成模型', { exact: true }).locator('..')).toHaveText('洞察生成模型未调用');
    await page.screenshot({ path: test.info().outputPath('insight-coverage.png'), fullPage: true });
  } finally { await app.close(); }
});

for (const filtered of [
  { perspective: 'blind_spots' as const, label: '思维盲点', userEventCount: 0, assistantEventCount: 51, omittedEventCount: 21,
    explanation: '当前保留的事件均来自 AI 回复；用户输入尚未提取出可用于此视角的事件。' },
  { perspective: 'second_order' as const, label: '二阶思考', userEventCount: 13, assistantEventCount: 38, omittedEventCount: 11,
    explanation: '当前保留的 13 条用户事件中，尚未找到可推演影响的明确方案或探讨备选方案的问题。' }
]) test(`incomplete ${filtered.perspective} extraction explains the skipped insight model and keeps a working retry`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), `jojo-insights-${filtered.perspective}-filtered-`));
  const { app, page } = await launchElectron(directory);
  try {
    const result: InsightResult = {
      version: 1, perspective: filtered.perspective, generatedAt: '2026-10-28T14:23:00.000Z',
      rangeStart: '2026-09-28T14:23:00.000Z', rangeEnd: '2026-10-28T14:23:00.000Z', scopeKind: 'personal_main',
      analyzedTurnCount: 21, analyzedSessionCount: 8, modelCallCount: 4, semanticCacheHit: false,
      truncated: true, omittedTurnCount: 0, cards: [], emptyReason: 'incomplete_analysis',
      coverage: { extractedEventCount: 51, userEventCount: filtered.userEventCount, assistantEventCount: filtered.assistantEventCount,
        eligibleEventCount: 0, selectedEventCount: 0, omittedEventCount: filtered.omittedEventCount, omittedCardCount: 0,
        truncatedUserMessageCount: 0, truncatedAssistantMessageCount: 1, omittedAssistantMessageCount: 0,
        unknownSourceTruncation: false, analysisPerformed: false }
    };
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('insight:generate');
      ipcMain.handle('insight:generate', (event, input) => {
        event.sender.send('insight:event', { type: 'insight.completed', requestId: input.requestId, result: value });
      });
    }, result);
    await page.evaluate(() => {
      const state = window as unknown as { insightAttempts: string[] };
      state.insightAttempts = [];
      window.desktopAgent.onInsightEvent(event => {
        if (event.type === 'insight.completed') state.insightAttempts.push(event.requestId);
      });
    });
    await page.getByRole('button', { name: '⚙ 设置' }).click();
    await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
    const view = page.getByTestId('insight-center-page');
    await view.getByRole('button', { name: new RegExp(filtered.label) }).click();
    const output = view.getByLabel('洞察结果', { exact: true });
    await expect(output.getByRole('heading', { name: '分析结果不完整，暂时无法形成洞察', exact: true })).toBeVisible();
    await expect(output).toContainText('已分析 21 轮 · 8 个会话');
    await expect(output).toContainText(`${filtered.omittedEventCount} 条候选事件未通过校验或超出处理上限`);
    await expect(output).toContainText('1 条 AI 回复仅分析了部分内容');
    await expect(output).toContainText('用户输入已完整读取');
    await expect(output).toContainText(filtered.explanation);
    await expect(output).toContainText('本次未调用洞察生成模型');
    await expect(output).toContainText('暂时不能判断整个范围是否存在可分析内容');
    await expect(output.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
    await expect(output.getByRole('button', { name: '检查模型配置', exact: true })).toHaveCount(0);
    await expect(output).not.toContainText('检查或切换分析模型后重试');
    await expect(output).not.toContainText('没有找到适合此视角的用户观点');
    await expect(output).not.toContainText('至少两条不同用户消息');

    const details = output.locator('details');
    await details.locator('summary').click();
    await expect(details.getByText('提取到的事件', { exact: true }).locator('..')).toHaveText('提取到的事件51');
    await expect(details.getByText('用户事件', { exact: true }).locator('..')).toHaveText(`用户事件${filtered.userEventCount}`);
    await expect(details.getByText('AI 回复事件', { exact: true }).locator('..')).toHaveText(`AI 回复事件${filtered.assistantEventCount}`);
    await expect(details.getByText('符合当前视角', { exact: true }).locator('..')).toHaveText('符合当前视角0');
    await expect(details.getByText('洞察生成模型', { exact: true }).locator('..')).toHaveText('洞察生成模型未调用');
    await output.getByRole('button', { name: '重新生成', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`insight-${filtered.perspective}-filtered-incomplete.png`), fullPage: true });

    await output.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { insightAttempts: string[] }).insightAttempts.length)).toBe(2);
    expect(new Set(await page.evaluate(() => (window as unknown as { insightAttempts: string[] }).insightAttempts)).size).toBe(2);
    await expect(output.getByRole('button', { name: '重新生成', exact: true })).toBeEnabled();
  } finally { await app.close(); }
});

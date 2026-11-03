import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { ConversationMapEvent, InsightEvent } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

type AnalysisKind = 'insight' | 'conversation-map';
type ProgressFixture = {
  requests: Record<AnalysisKind, { requestId: string; senderId: number }[]>;
  cancelled: string[];
};

// Drive the real preload/event subscriptions explicitly so the tests never
// depend on model speed or on a timer inventing analysis progress.
async function installProgressFixture(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const fixture: ProgressFixture = { requests: { insight: [], 'conversation-map': [] }, cancelled: [] };
    (globalThis as unknown as { progressFixture: ProgressFixture }).progressFixture = fixture;
    for (const kind of ['insight', 'conversation-map'] as const) {
      ipcMain.removeHandler(`${kind}:generate`);
      ipcMain.handle(`${kind}:generate`, (event, input: { requestId: string }) => {
        fixture.requests[kind].push({ requestId: input.requestId, senderId: event.sender.id });
        event.sender.send(`${kind}:event`, {
          type: `${kind}.progress`, requestId: input.requestId, phase: 'reading', detail: '正在读取本次授权范围的历史。'
        });
      });
      ipcMain.removeHandler(`${kind}:cancel`);
      ipcMain.handle(`${kind}:cancel`, (_event, input: { requestId: string }) => { fixture.cancelled.push(input.requestId); });
    }
  });
}

async function latestRequest(app: ElectronApplication, kind: AnalysisKind): Promise<string> {
  return app.evaluate((_electron, kind) => {
    const fixture = (globalThis as unknown as { progressFixture: ProgressFixture }).progressFixture;
    return fixture.requests[kind].at(-1)!.requestId;
  }, kind);
}

async function emit(app: ElectronApplication, event: InsightEvent | ConversationMapEvent) {
  await app.evaluate(({ webContents }, event) => {
    const fixture = (globalThis as unknown as { progressFixture: ProgressFixture }).progressFixture;
    const kind = event.type.startsWith('insight.') ? 'insight' : 'conversation-map';
    const request = fixture.requests[kind].find(request => request.requestId === event.requestId)!;
    webContents.fromId(request.senderId)!.send(`${kind}:event`, event);
  }, event);
}

async function openCenter(page: Page) {
  await page.getByRole('button', { name: '⚙ 设置' }).click();
  await page.getByRole('button', { name: 'AI 洞察中心', exact: true }).click();
  return page.getByTestId('insight-center-page');
}

test('each thinking perspective exposes actual analysis phases, batches and its own analysis purpose', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insight-progress-'));
  const { app, page } = await launchElectron(directory);
  try {
    await installProgressFixture(app);
    const view = await openCenter(page);
    for (const perspective of [
      { label: '逆向思考', analysis: '检验假设与反例' },
      { label: '二阶思考', analysis: '推演后续影响' },
      { label: '思维盲点', analysis: '寻找信息缺口' }
    ]) {
      await view.getByRole('button', { name: new RegExp(perspective.label) }).click();
      const panel = view.getByRole('region', { name: '分析过程', exact: true });
      await expect(panel).toContainText('正在读取本次授权范围的历史。');
      await expect(panel).toContainText(/已用时 \d+ 秒/);
      const requestId = await latestRequest(app, 'insight');
      const steps = panel.getByRole('list', { name: '分析步骤' });
      await expect(steps.locator('[data-phase="reading"]')).toHaveAttribute('data-status', 'active');
      await expect(steps.locator('[data-phase="analyzing"]')).toHaveAttribute('data-status', 'pending');

      await emit(app, { type: 'insight.progress', requestId, phase: 'reading', completed: 21, detail: '已读取 21 轮对话，准备整理分析内容。' });
      await emit(app, { type: 'insight.progress', requestId, phase: 'extracting', completed: 1, total: 3,
        detail: '已处理 1 批对话，正在提取第 2 批中的关键内容。' });
      const bar = panel.getByRole('progressbar', { name: '洞察生成进度' });
      await expect(bar).toHaveAttribute('aria-valuenow', '1');
      await expect(bar).toHaveAttribute('aria-valuemax', '3');
      await expect(panel).toContainText('已处理 1 批对话，正在提取第 2 批中的关键内容。');
      await expect(steps.locator('[data-phase="reading"]')).toHaveAttribute('data-status', 'done');
      await expect(steps.locator('[data-phase="extracting"]')).toHaveAttribute('data-status', 'active');
      await expect(steps.locator('[data-phase="merging"]')).toHaveAttribute('data-status', 'pending');

      await emit(app, { type: 'insight.progress', requestId, phase: 'extracting', completed: 3, total: 3,
        detail: '已处理 3 批对话，保留 12 条关键内容。' });
      await emit(app, { type: 'insight.progress', requestId, phase: 'merging', detail: '正在归并 4 个相关讨论主题。' });
      await expect(panel.getByRole('heading', { name: '归并讨论主题', exact: true })).toBeVisible();
      await expect(steps.locator('[data-phase="extracting"]')).toHaveAttribute('data-status', 'done');
      await expect(bar).not.toHaveAttribute('aria-valuenow');

      await emit(app, { type: 'insight.progress', requestId, phase: 'merging', detail: '已整理为 4 个主题，共 12 条有原文依据的事件。' });
      await emit(app, { type: 'insight.progress', requestId, phase: 'analyzing', completed: 0, total: 1,
        detail: '正在分析 6 条符合当前视角的用户记录。' });
      await expect(panel.getByRole('heading', { name: perspective.analysis, exact: true })).toBeVisible();
      await expect(panel).toContainText('正在分析 6 条符合当前视角的用户记录。');
      await expect(steps.locator('[data-phase="merging"]')).toHaveAttribute('data-status', 'done');
      await expect(steps.locator('[data-phase="validating"]')).toHaveAttribute('data-status', 'pending');
      await expect(panel).not.toContainText(/\d+%/);
      await expect(bar).not.toHaveAttribute('aria-valuenow');
      if (perspective.label === '逆向思考') await panel.screenshot({ path: test.info().outputPath('insight-analysis-progress.png') });

      await emit(app, { type: 'insight.progress', requestId, phase: 'validating', detail: '正在核对洞察引用的原始记录。' });
      await expect(panel.getByRole('heading', { name: '核对原文依据', exact: true })).toBeVisible();
      await expect(steps.locator('[data-phase="analyzing"]')).toHaveAttribute('data-status', 'done');
      await view.getByRole('button', { name: '← 返回洞察中心', exact: true }).click();
      await expect(panel).toHaveCount(0);
    }
  } finally { await app.close(); }
});

test('cancelling, retrying and failing clears progress and rejects events from a previous request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-insight-progress-retry-'));
  const { app, page } = await launchElectron(directory);
  try {
    await installProgressFixture(app);
    const view = await openCenter(page);
    await page.clock.install();
    await view.getByRole('button', { name: /思维盲点/ }).click();
    const panel = view.getByRole('region', { name: '分析过程', exact: true });
    await expect(panel).toContainText('正在读取本次授权范围的历史。');
    const firstRequest = await latestRequest(app, 'insight');
    await emit(app, { type: 'insight.progress', requestId: firstRequest, phase: 'analyzing', detail: '第一轮分析已经开始。' });
    await expect(panel).toContainText('第一轮分析已经开始。');
    await expect(panel).not.toContainText('此步骤耗时较长');
    await page.clock.fastForward(31_000);
    await expect(panel).toContainText(/已用时 3\d 秒/);
    await expect(panel).toContainText('此步骤耗时较长，仍在等待处理结果。');
    await view.getByRole('button', { name: '取消生成', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(view).toContainText('已取消生成。可以调整范围后重新生成。');
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { progressFixture: ProgressFixture }).progressFixture.cancelled))
      .toContain(firstRequest);

    await view.getByRole('button', { name: '生成洞察', exact: true }).click();
    await expect(panel).toContainText('正在读取本次授权范围的历史。');
    const secondRequest = await latestRequest(app, 'insight');
    expect(secondRequest).not.toBe(firstRequest);
    await expect(panel.locator('[data-phase="analyzing"]')).toHaveAttribute('data-status', 'pending');
    await expect(panel).not.toContainText('第一轮分析已经开始。');
    await expect(panel).not.toContainText('此步骤耗时较长');
    await emit(app, { type: 'insight.progress', requestId: firstRequest, phase: 'validating', detail: '旧请求的进度不应出现。' });
    await emit(app, { type: 'insight.failed', requestId: firstRequest, code: 'late', message: '旧请求的错误不应出现。' });
    await expect(panel.locator('[data-phase="reading"]')).toHaveAttribute('data-status', 'active');
    await expect(view).not.toContainText('旧请求的');

    await emit(app, { type: 'insight.failed', requestId: secondRequest, code: 'test_failure', message: '本次模型分析失败，请重试。' });
    await expect(panel).toHaveCount(0);
    await expect(view.getByRole('alert')).toContainText('本次模型分析失败，请重试。');
    await view.getByRole('button', { name: '重试生成', exact: true }).click();
    await expect(panel).toContainText('正在读取本次授权范围的历史。');
    await expect(panel.locator('[data-phase="analyzing"]')).toHaveAttribute('data-status', 'pending');
    await expect(view.getByRole('alert')).toHaveCount(0);
  } finally { await app.close(); }
});

test('conversation maps expose comparison progress without marking unobserved phases completed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-map-progress-'));
  const { app, page } = await launchElectron(directory);
  try {
    await installProgressFixture(app);
    const center = await openCenter(page);
    await center.getByRole('button', { name: /交流脉络/ }).click();
    const view = page.getByTestId('conversation-map-page');
    await view.getByRole('button', { name: '生成脉络图', exact: true }).click();
    const panel = view.getByRole('region', { name: '分析过程', exact: true });
    await expect(panel).toContainText('正在读取本次授权范围的历史。');
    const requestId = await latestRequest(app, 'conversation-map');
    await emit(app, { type: 'conversation-map.progress', requestId, phase: 'comparing', completed: 1, total: 4,
      detail: '已比较 1 个主题，正在比较其余主题的观点变化。' });
    await expect(panel.getByRole('heading', { name: '比较观点变化', exact: true })).toBeVisible();
    await expect(panel.getByRole('progressbar', { name: '脉络生成进度' })).toHaveAttribute('aria-valuenow', '1');
    await expect(panel.getByRole('progressbar', { name: '脉络生成进度' })).toHaveAttribute('aria-valuemax', '4');
    await expect(panel.locator('[data-phase="reading"]')).toHaveAttribute('data-status', 'done');
    await expect(panel.locator('[data-phase="extracting"]')).toHaveAttribute('data-status', 'skipped');
    await expect(panel.locator('[data-phase="merging"]')).toHaveAttribute('data-status', 'skipped');
    await expect(panel.locator('[data-phase="rendering"]')).toHaveAttribute('data-status', 'pending');
    await panel.screenshot({ path: test.info().outputPath('conversation-map-analysis-progress.png') });
    await emit(app, { type: 'conversation-map.progress', requestId, phase: 'rendering', detail: '正在核对引用并生成交流脉络图。' });
    await expect(panel.getByRole('heading', { name: '核对依据与绘图', exact: true })).toBeVisible();
    await expect(panel.getByRole('progressbar', { name: '脉络生成进度' })).not.toHaveAttribute('aria-valuenow');
    await emit(app, { type: 'conversation-map.completed', requestId, result: {
      version: 2, generatedAt: '2026-11-02T01:00:00.000Z', rangeStart: '2026-10-03T01:00:00.000Z', rangeEnd: '2026-11-02T01:00:00.000Z',
      scopeKind: 'personal_main', analyzedTurnCount: 0, analyzedSessionCount: 0, modelCallCount: 0,
      truncated: false, omittedEventCount: 0, topics: []
    } });
    await expect(panel).toHaveCount(0);
    await expect(view.getByText(/所选范围内暂无符合条件的文本对话/)).toBeVisible();
  } finally { await app.close(); }
});

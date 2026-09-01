import { access, mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function createSession(page: Awaited<ReturnType<typeof launchElectron>>['page']): Promise<void> {
  await page.getByRole('button', { name: '新建对话' }).click();
  await expect(page.getByPlaceholder('随心输入')).toBeVisible();
}

async function send(page: Awaited<ReturnType<typeof launchElectron>>['page'], prompt: string): Promise<void> {
  await page.getByPlaceholder('随心输入').fill(prompt);
  await page.getByRole('button', { name: '发送消息' }).click();
}

test('boots Main, Preload, Renderer and Worker and completes an offline prompt', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  try {
    await expect(launched.page.getByRole('heading', { name: 'Desktop Agent' })).toBeVisible();
    await createSession(launched.page);
    await send(launched.page, 'E2E: text');
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();

    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(sessions).toHaveLength(1);
    const journal = await readFile(path.join(dataDirectory, 'sessions', `${sessions[0]!.id}.jsonl`), 'utf8');
    expect(journal).toContain('hello from offline e2e');
  } finally {
    await launched.app.close();
  }
});

test('registers Jojo Channel tools in an ordinary desktop conversation', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  try {
    await createSession(launched.page);
    await send(launched.page, 'E2E: channel tools');
    await expect(launched.page.getByText('channel tools handled')).toBeVisible();

    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    const journal = await readFile(path.join(dataDirectory, 'sessions', `${sessions[0]!.id}.jsonl`), 'utf8');
    expect(journal).toContain('channel_list_targets');
    expect(journal).not.toContain('Unknown tool: channel_list_targets');
  } finally {
    await launched.app.close();
  }
});

test('stores pasted Feishu secrets encrypted and keeps plaintext out of Channel SQLite', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  const appSecret = 'e2e-feishu-app-secret-do-not-persist';
  try {
    await expect(launched.page.getByRole('heading', { name: 'Desktop Agent' })).toBeVisible();
    const result = await launched.page.evaluate(async (secret) => {
      const references = await window.desktopAgent.saveChannelSecrets({
        instanceId: 'feishu-e2e', secrets: { appSecret: secret }
      });
      if (!references.appSecret) throw new Error('Secure storage returned no App Secret reference.');
      const snapshot = await window.desktopAgent.mutateChannel({
        action: 'instance.save',
        instance: {
          id: 'feishu-e2e', kind: 'feishu', name: 'Feishu E2E', enabled: false,
          config: { appId: 'cli_e2e', transport: 'websocket' },
          secretRefs: { appSecret: references.appSecret }
        }
      });
      return { references, snapshot };
    }, appSecret);

    expect(result.references.appSecret).toMatch(/^secret:\/\/env\/JOJO_CHANNEL_[A-F0-9]{20}_APP_SECRET$/);
    expect(JSON.stringify(result.snapshot)).not.toContain(appSecret);
    expect((await readFile(path.join(dataDirectory, 'secrets', 'channel-secrets.bin'))).includes(Buffer.from(appSecret))).toBe(false);
    expect((await readFile(path.join(dataDirectory, 'runtime', 'channels.sqlite'))).includes(Buffer.from(appSecret))).toBe(false);
  } finally {
    await launched.app.close();
  }
});

test('approval allow writes and approval deny has no side effect', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  const approvedTarget = path.join(dataDirectory, 'workspaces', 'general', 'e2e-approved.txt');
  const deniedTarget = path.join(dataDirectory, 'workspaces', 'general', 'e2e-denied.txt');
  try {
    await createSession(launched.page);
    await send(launched.page, 'E2E: approval allow');
    await expect(launched.page.getByRole('dialog')).toBeVisible();
    await launched.page.getByRole('button', { name: '选择允许范围' }).click();
    await expect(launched.page.getByRole('menuitem', { name: '允许一次' })).toBeVisible();
    await expect(launched.page.getByRole('menuitem', { name: '允许类似命令' })).toBeVisible();
    await expect(launched.page.getByRole('menuitem', { name: '本次对话都允许' })).toBeVisible();
    await launched.page.getByRole('menuitem', { name: '允许一次' }).click();
    await expect(launched.page.getByText('approval handled')).toBeVisible();
    expect(await readFile(approvedTarget, 'utf8')).toBe('approved');

    const second = await launched.page.evaluate(() => window.desktopAgent.createSession({ title: 'deny' }));
    expect(second).not.toBeNull();
    await launched.page.getByRole('button', { name: second!.title, exact: true }).click();
    await send(launched.page, 'E2E: approval deny');
    await expect(launched.page.getByRole('dialog')).toBeVisible();
    await launched.page.getByRole('button', { name: /拒绝/ }).click();
    await expect(launched.page.getByText('approval handled')).toBeVisible();
    expect(await exists(deniedTarget)).toBe(false);
  } finally {
    await launched.app.close();
  }
});

test('approves host network and injects a named Terminal secret without persisting it in history', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  try {
    await createSession(launched.page);
    await send(launched.page, 'E2E: terminal secret');
    const approval = launched.page.getByRole('dialog');
    await expect(approval).toContainText('此命令将使用主机全局网络');
    await expect(approval).toContainText('WEREAD_API_KEY');
    await approval.getByRole('button', { name: /允许一次/ }).click();

    const secretDialog = launched.page.getByRole('dialog');
    await expect(secretDialog.getByRole('heading', { name: /WEREAD_API_KEY/ })).toBeVisible();
    await secretDialog.getByRole('textbox', { name: '密钥' }).fill('e2e-secret-value');
    await secretDialog.getByRole('checkbox').uncheck();
    await secretDialog.getByRole('button', { name: '注入并继续' }).click();
    await expect(launched.page.getByText('terminal secret handled')).toBeVisible();

    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    const journal = await readFile(path.join(dataDirectory, 'sessions', `${sessions[0]!.id}.jsonl`), 'utf8');
    expect(journal).not.toContain('e2e-secret-value');
  } finally {
    await launched.app.close();
  }
});

test('cancels a slow turn', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  const launched = await launchElectron(dataDirectory);
  try {
    await createSession(launched.page);
    await send(launched.page, 'E2E: slow');
    await expect(launched.page.getByRole('button', { name: '停止生成' })).toBeVisible();
    await launched.page.getByRole('button', { name: '停止生成' }).click();
    await expect(launched.page.getByRole('button', { name: '发送消息' })).toBeVisible();
  } finally {
    await launched.app.close();
  }
});

test('deleting a running session rejects a concurrent send and survives restart', async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-electron-e2e-'));
  let launched = await launchElectron(dataDirectory);
  let sessionId = '';
  try {
    await createSession(launched.page);
    sessionId = (await launched.page.evaluate(() => window.desktopAgent.listSessions()))[0]!.id;
    await send(launched.page, 'E2E: slow');
    await expect(launched.page.getByRole('button', { name: '停止生成' })).toBeVisible();

    const result = await launched.page.evaluate(async (id) => {
      const deletion = window.desktopAgent.deleteSession(id);
      await Promise.resolve();
      const lateSend = window.desktopAgent.startTurn({
        sessionId: id, text: 'E2E: text', providerId: 'openai', model: 'gpt-5-mini', images: []
      }).then(() => 'accepted', (error: unknown) => error instanceof Error ? error.message : String(error));
      await deletion;
      return lateSend;
    }, sessionId);
    expect(result).toMatch(/session_deleting|session_unavailable/);
    expect(await exists(path.join(dataDirectory, 'sessions', `${sessionId}.jsonl`))).toBe(false);
  } finally {
    await launched.app.close();
  }

  launched = await launchElectron(dataDirectory);
  try {
    expect(await launched.page.evaluate(() => window.desktopAgent.listSessions())).toEqual([]);
    expect(await exists(path.join(dataDirectory, 'sessions', `${sessionId}.jsonl`))).toBe(false);
  } finally {
    await launched.app.close();
  }
});

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { verificationFacts, type Message } from '@desktop-agent/contracts';
import { launchElectron } from './helpers/launch-electron';

test('governs a three-check batch, retains evidence across restart and detects external changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-verification-e2e-'));
  const workspace = path.join(directory, 'workspaces', 'general');
  await mkdir(path.join(workspace, '.jojo'), { recursive: true });
  await mkdir(path.join(workspace, 'src'));
  await writeFile(path.join(workspace, 'src/a.ts'), 'export const a = 1;');
  await writeFile(path.join(workspace, '.jojo/verification.json'), JSON.stringify({ version: 2,
    inputs: { include: ['src/**'] }, budgetMs: 60000,
    commands: ['lint', 'typecheck', 'test'].map(kind => ({ id: kind, kind, scope: 'src', cwd: '.', command: 'node', args: ['-e', 'console.log("offline check");process.exit(0)'] }))
  }));
  let launched = await launchElectron(directory);
  const violations: string[] = [], errors: string[] = [];
  const watch = () => {
    launched.app.process().stderr?.on('data', data => { if (String(data).includes('IPC protocol violation')) violations.push(String(data)); });
    launched.page.on('pageerror', error => errors.push(error.message));
  };
  watch();
  let sessionId = '';
  const messages = () => launched.page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId);
  const openChecks = async () => {
    const collapsed = launched.page.locator('.disclosure-row[aria-expanded="false"]');
    while (await collapsed.count()) await collapsed.first().click();
  };
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    sessionId = (await launched.page.evaluate(() => window.desktopAgent.listSessions()))[0]!.id;
    await launched.page.getByPlaceholder('随心输入').fill('E2E: verification batch');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    for (let index = 0; index < 3; index++) {
      const dialog = launched.page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('node');
      await dialog.getByRole('button', { name: /允许一次/ }).click();
    }
    await expect(launched.page.getByText('verification batch settled')).toBeVisible();
    await expect.poll(async () => verificationFacts(await messages() as Message[]).filter(fact => fact.status === 'passed' && fact.validity === 'current').length).toBe(3);
    await openChecks();
    await expect(launched.page.getByText('验证 · lint · 通过 · src', { exact: true }).first()).toBeVisible();
    await launched.app.close();
    launched = await launchElectron(directory); watch();
    const session = (await launched.page.evaluate(() => window.desktopAgent.listSessions())).find(item => item.id === sessionId)!;
    await launched.page.getByText(session.title, { exact: true }).first().click();
    expect(verificationFacts(await messages() as Message[]).filter(fact => fact.status === 'passed')).toHaveLength(3);
    await writeFile(path.join(workspace, 'src/a.ts'), 'export const a = 2;');
    // A new turn uses the ordinary Runtime final-report revision recheck.
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    await expect.poll(async () => verificationFacts(await messages() as Message[]).filter(fact => fact.status === 'passed' && fact.stale).length).toBe(3);
    await openChecks();
    await expect(launched.page.getByText(/验证 · lint · 通过 · 后续变更尚未验证/).first()).toBeVisible();
  } finally { await launched.app.close(); }
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

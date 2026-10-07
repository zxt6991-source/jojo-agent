import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-tool-workflows-'));
  const workspace = path.join(directory, 'workspaces', 'general');
  await mkdir(workspace, { recursive: true });
  const launched = await launchElectron(directory);
  await launched.page.getByRole('button', { name: '新建对话' }).click();
  const sessionId = (await launched.page.evaluate(() => window.desktopAgent.listSessions()))[0]!.id;
  const send = async (text: string) => {
    await launched.page.getByPlaceholder('随心输入').fill(text);
    await launched.page.getByRole('button', { name: '发送消息' }).click();
  };
  const approve = async () => {
    const dialog = launched.page.getByRole('dialog'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /允许一次/ }).click();
  };
  const results = async () => (await launched.page.evaluate(id => window.desktopAgent.loadMessages(id), sessionId))
    .flatMap(message => message.content.flatMap(block => block.type === 'tool_result' ? [block.result] : []));
  const errors: string[] = [];
  launched.page.on('pageerror', error => errors.push(error.message));
  launched.app.process().stderr?.on('data', data => { if (String(data).includes('IPC protocol violation')) errors.push(String(data)); });
  return { ...launched, workspace, sessionId, send, approve, results, errors };
}

test('recovers the middle of a reclaimed long Terminal output by original call id', async () => {
  const f = await fixture();
  try {
    await f.send('E2E: long result'); await f.approve();
    await expect(f.page.getByText('middle error recovered from original result')).toBeVisible();
    const results = await f.results();
    const original = results.find(result => result.callId.endsWith('-long'))!;
    const recovered = results.find(result => result.callId.endsWith('-window'))!;
    expect(original.content.length).toBeGreaterThan(40000);
    expect(original.ok).toBe(false);
    expect(recovered.content).toContain('MIDDLE_ERROR');
    expect(recovered.structuredResult).toMatchObject({ sourceCallId: original.callId, offset: 19950 });
  } finally { await f.app.close(); }
  expect(f.errors).toEqual([]);
});

test('searches a prior user decision and opens its original conversation entry', async () => {
  const f = await fixture();
  try {
    await f.send('SQLite原始选择：保留事务以便恢复。');
    await expect(f.page.getByText('hello from offline e2e')).toBeVisible();
    await f.send('E2E: history search');
    await expect(f.page.getByText('history source recovered')).toBeVisible();
    const results = await f.results();
    expect(results.find(result => result.callId.endsWith('-history-window'))?.content).toContain('SQLite原始选择');
    const collapsed = f.page.locator('.disclosure-row[aria-expanded="false"]');
    while (await collapsed.count()) await collapsed.first().click();
    await f.page.getByRole('button', { name: /查看原文/ }).first().click();
    await expect(f.page.getByText('SQLite原始选择：保留事务以便恢复。', { exact: true }).first()).toBeVisible();
  } finally { await f.app.close(); }
  expect(f.errors).toEqual([]);
});

test('reviews a multi-file patch and its reverse diff before Undo and Redo', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.workspace, 'a.txt'), 'before-a');
    await writeFile(path.join(f.workspace, 'b.txt'), 'before-b');
    await f.send('E2E: patch journal');
    await expect(f.page.getByRole('dialog')).toContainText('2 files');
    await f.approve();
    await expect.poll(async () => (await f.results()).find(result => result.callId.endsWith('-patch'))?.ok).toBe(true);
    await expect(f.page.getByRole('dialog')).toBeVisible();
    expect(await readFile(path.join(f.workspace, 'a.txt'), 'utf8')).toBe('after-a');
    expect(await readFile(path.join(f.workspace, 'b.txt'), 'utf8')).toBe('after-b');
    await f.approve();
    await expect.poll(async () => (await f.results()).find(result => result.callId.endsWith('-undo'))?.ok).toBe(true);
    await expect(f.page.getByRole('dialog')).toBeVisible();
    expect(await readFile(path.join(f.workspace, 'a.txt'), 'utf8')).toBe('before-a');
    expect(await readFile(path.join(f.workspace, 'b.txt'), 'utf8')).toBe('before-b');
    await f.approve();
    await expect(f.page.getByText('patch journal settled')).toBeVisible();
    expect(await readFile(path.join(f.workspace, 'a.txt'), 'utf8')).toBe('after-a');
    expect(await readFile(path.join(f.workspace, 'b.txt'), 'utf8')).toBe('after-b');
    expect((await f.results()).filter(result => /-(patch|undo|redo)$/u.test(result.callId)).every(result => result.ok)).toBe(true);
  } finally { await f.app.close(); }
  expect(f.errors).toEqual([]);
});

test('saves and previews a verified Skill draft while rejecting activation', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.workspace, '.jojo'));
    await writeFile(path.join(f.workspace, 'source.txt'), 'fixture');
    await writeFile(path.join(f.workspace, '.jojo/verification.json'), JSON.stringify({ version: 2, inputs: { include: ['source.txt'] }, commands: [{ id: 'test', kind: 'test', scope: 'source', command: 'node', args: ['-e', 'process.exit(0)'] }] }));
    await f.send('E2E: skill draft'); await f.approve(); await f.approve();
    const dialog = f.page.getByRole('dialog');
    await expect(dialog).toContainText('SKILL.md');
    await dialog.getByRole('button', { name: /拒绝/ }).click();
    await expect(f.page.getByText('skill draft reviewed')).toBeVisible();
    const results = await f.results();
    expect(results.find(result => result.callId.endsWith('-draft'))?.ok).toBe(true);
    expect(results.find(result => result.callId.endsWith('-preview'))?.content).toContain('Offline tested process');
    expect(results.find(result => result.callId.endsWith('-activate'))?.ok).toBe(false);
    expect(await readdir(path.join(f.workspace, '.jojo/skill-drafts/e2e-process'))).toHaveLength(1);
    await expect(access(path.join(f.workspace, '.agents/skills/e2e-process/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.app.close(); }
  expect(f.errors).toEqual([]);
});

for (const name of ['write_file', 'edit_file', 'delete_file'] as const) {
  test(`reviews and restores a ${name} journal through Electron approvals`, async () => {
    const f = await fixture();
    const target = path.join(f.workspace, 'single.txt');
    try {
      await writeFile(target, 'before-single');
      await f.send(`E2E: single file journal ${name}`);
      await expect(f.page.getByRole('dialog')).toContainText('single.txt');
      await f.approve();
      await expect.poll(async () => (await f.results()).find(result => result.callId.endsWith('-mutation'))?.ok).toBe(true);
      const mutation = (await f.results()).find(result => result.callId.endsWith('-mutation'))!;
      expect(mutation.structuredResult).toMatchObject({ journalId: expect.any(String), status: 'applied' });
      await expect(f.page.getByRole('dialog')).toBeVisible();
      if (name === 'delete_file') await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(target, 'utf8')).toBe('after-single');
      await f.approve();
      await expect.poll(async () => (await f.results()).find(result => result.callId.endsWith('-undo'))?.ok).toBe(true);
      await expect(f.page.getByRole('dialog')).toBeVisible();
      expect(await readFile(target, 'utf8')).toBe('before-single');
      await f.approve();
      await expect(f.page.getByText('single file journal settled')).toBeVisible();
      if (name === 'delete_file') await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(target, 'utf8')).toBe('after-single');
    } finally { await f.app.close(); }
    expect(f.errors).toEqual([]);
  });
}

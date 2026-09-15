import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('restores the captured execution after killing Electron in model_pending', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-execution-recovery-'));
  const models = [{ id: 'original-model', discovered: { contextWindowTokens: 48000, maxOutputTokens: 4096, contextSource: 'builtin', maxOutputSource: 'builtin' }, defaultOutputTokens: 1024 }];
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ schemaVersion: 4, activeProviderId: 'openai',
    providers: [{ id: 'openai', name: 'Offline', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', model: 'original-model', models }],
    utilityModel: { providerId: 'openai', model: 'original-model' } }));
  let launched = await launchElectron(directory);
  const readOperation = () => {
    const db = new DatabaseSync(path.join(directory, 'runtime', 'agent-runtime.sqlite'));
    try {
      const row = db.prepare('SELECT id, meta_json, state_json FROM operations ORDER BY updated_at LIMIT 1').get();
      if (!row) return undefined;
      return { id: String(row.id), meta: JSON.parse(String(row.meta_json)), state: JSON.parse(String(row.state_json)) };
    } finally { db.close(); }
  };
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: execution recovery');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect.poll(async () => readFile(path.join(directory, 'e2e-request-before.json'), 'utf8').then(() => true, () => false)).toBe(true);
    const original = readOperation()!;
    expect(original.state.phase).toBe('model_pending');
    expect(original.meta.execution).toMatchObject({ actor: { kind: 'main' }, budget: { contextWindowTokens: 48000, maxOutputTokens: 1024 } });
    // A hard process kill leaves the durable operation nonterminal, unlike app.close().
    const exited = new Promise<void>(resolve => launched.app.process().once('exit', () => resolve()));
    launched.app.process().kill('SIGKILL');
    await exited;
    await writeFile(path.join(directory, 'e2e-resume-allowed'), 'yes');
    launched = await launchElectron(directory);
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    await launched.page.getByText(sessions[0]!.title, { exact: true }).first().click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('execution recovered from original snapshot')).toBeVisible();
    const before = JSON.parse(await readFile(path.join(directory, 'e2e-request-before.json'), 'utf8'));
    const after = JSON.parse(await readFile(path.join(directory, 'e2e-request-after.json'), 'utf8'));
    expect(after).toEqual(before);
    expect(readOperation()).toMatchObject({ id: original.id, meta: { execution: original.meta.execution }, state: { phase: 'completed' } });
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
  } finally { await launched.app.close(); }
});

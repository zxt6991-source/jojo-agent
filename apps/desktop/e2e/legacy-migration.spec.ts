import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('imports legacy history once across restart and does not resurrect deleted JSONL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-legacy-e2e-'));
  const fixture = await readFile(path.resolve('../../packages/storage/test/fixtures/legacy-session/session.jsonl'), 'utf8');
  const records = fixture.trim().split('\n').map((line) => JSON.parse(line));
  records[0].session.workingDirectory = directory;
  records[0].session.projectBound = false;
  const source = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await mkdir(path.join(directory, 'sessions'));
  const journal = path.join(directory, 'sessions', 'session.jsonl');
  await writeFile(journal, source);
  let launched = await launchElectron(directory);
  const facts = () => {
    const db = new DatabaseSync(path.join(directory, 'runtime', 'agent-runtime.sqlite'));
    try {
      return {
        originals: db.prepare("SELECT id FROM entries WHERE id IN ('user-1', 'assistant-1') ORDER BY id").all(),
        marker: db.prepare("SELECT source_count, imported_count FROM runtime_migrations WHERE session_id = 'session' AND migration_id = 'legacy-jsonl-main-cutover-v1'").get()
      };
    } finally { db.close(); }
  };
  const send = async () => {
    await launched.page.getByText('Legacy fixture', { exact: true }).first().click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e').first()).toBeVisible();
  };
  try {
    await send();
    expect(facts()).toMatchObject({ originals: [{ id: 'assistant-1' }, { id: 'user-1' }], marker: { source_count: 2, imported_count: 2 } });
    await launched.app.close();
    launched = await launchElectron(directory);
    await send();
    expect(facts().marker?.imported_count).toBe(2);
    expect(await readFile(journal, 'utf8')).toBe(source);
    expect(facts().originals).toHaveLength(2);
    await launched.page.evaluate(() => window.desktopAgent.deleteSession('session'));
    const application = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
    try {
      expect(application.prepare("SELECT count(*) AS count FROM server_runs WHERE session_id = 'session'").get()?.count).toBe(0);
      expect(application.prepare("SELECT session_id FROM application_deleted_sessions WHERE session_id = 'session'").get()?.session_id).toBe('session');
    } finally { application.close(); }
    await writeFile(journal, source);
    expect(await launched.page.evaluate(() => window.desktopAgent.listSessions())).toEqual([]);
    expect(await launched.page.evaluate(() => window.desktopAgent.loadMessages('session'))).toEqual([]);
    expect(facts().marker).toBeUndefined();
  } finally { await launched.app.close(); }
});

test('finishes interrupted deletion of Runtime and application results on startup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-delete-recovery-'));
  let launched = await launchElectron(directory);
  try {
    await launched.page.getByRole('button', { name: '新建对话' }).click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e').first()).toBeVisible();
    const [session] = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    await launched.app.close();
    // Simulate a crash after the file tombstone commit and before either database delete.
    await mkdir(path.join(directory, 'sessions', '.tombstones'), { recursive: true });
    await writeFile(path.join(directory, 'sessions', '.tombstones', session!.id), new Date().toISOString());
    launched = await launchElectron(directory);
    expect(await launched.page.evaluate(() => window.desktopAgent.listSessions())).toEqual([]);
    await expect.poll(() => {
      const runtime = new DatabaseSync(path.join(directory, 'runtime', 'agent-runtime.sqlite'));
      const application = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
      try {
        return {
          runtime: runtime.prepare('SELECT count(*) AS count FROM sessions').get()?.count,
          application: application.prepare('SELECT count(*) AS count FROM server_runs').get()?.count,
          deleted: application.prepare('SELECT session_id FROM application_deleted_sessions WHERE session_id = ?').get(session!.id)?.session_id
        };
      } finally { runtime.close(); application.close(); }
    }).toEqual({ runtime: 0, application: 0, deleted: session!.id });
  } finally { await launched.app.close(); }
});

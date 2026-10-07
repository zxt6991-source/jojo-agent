import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdtemp, readFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchElectron } from './helpers/launch-electron';

test('keeps renamed titles in application SQLite across restart and stale JSONL updates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-title-e2e-'));
  let launched = await launchElectron(directory);
  try {
    const session = await launched.page.evaluate(() => window.desktopAgent.createSession({ title: 'Original title' }));
    expect(session).not.toBeNull();
    const file = path.join(directory, 'sessions', `${session!.id}.jsonl`);
    const original = await readFile(file, 'utf8');
    await launched.page.evaluate(sessionId => window.desktopAgent.renameSession({ sessionId, title: 'SQLite title' }), session!.id);
    expect(await readFile(file, 'utf8')).toBe(original);
    const db = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
    try { expect(db.prepare('SELECT title FROM server_sessions WHERE session_id = ?').get(session!.id)?.title).toBe('SQLite title'); }
    finally { db.close(); }
    await launched.app.close();
    await appendFile(file, `${JSON.stringify({ schemaVersion: 1, type: 'title', title: 'Stale legacy title' })}\n`);
    launched = await launchElectron(directory);
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(sessions.find(candidate => candidate.id === session!.id)?.title).toBe('SQLite title');
  } finally { await launched.app.close(); }
});

test('uses the SQLite project binding for the first Worker run and after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-project-e2e-'));
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-bound-project-'));
  let launched = await launchElectron(directory);
  try {
    const session = await launched.page.evaluate(() => window.desktopAgent.createSession({ title: 'Bound session' }));
    const file = path.join(directory, 'sessions', `${session!.id}.jsonl`);
    const original = await readFile(file, 'utf8');
    const bound = await launched.page.evaluate(input => window.desktopAgent.bindSessionProject(input), {
      sessionId: session!.id, workingDirectory: projectDirectory
    });
    expect(bound).toMatchObject({ workingDirectory: projectDirectory, projectBound: true });
    expect(bound.projectIdentity).toBeDefined();
    expect(await readFile(file, 'utf8')).toBe(original);
    await launched.page.getByRole('button', { name: 'Bound session', exact: true }).click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    const db = new DatabaseSync(path.join(directory, 'runtime', 'agent-runtime.sqlite'));
    try {
      const operation = db.prepare('SELECT meta_json FROM operations LIMIT 1').get();
      expect(JSON.parse(String(operation?.meta_json)).execution.executionScope.workingDirectory).toBe(projectDirectory);
    } finally { db.close(); }
    await launched.app.close();
    launched = await launchElectron(directory);
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(sessions.find(candidate => candidate.id === session!.id)).toMatchObject({
      workingDirectory: projectDirectory, projectBound: true, projectIdentity: bound.projectIdentity
    });
  } finally { await launched.app.close(); }
});


test('lists and opens a migrated conversation from SQLite without its legacy metadata file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-sqlite-discovery-e2e-'));
  let launched = await launchElectron(directory);
  try {
    const session = await launched.page.evaluate(() => window.desktopAgent.createSession({ title: 'SQLite conversation' }));
    await launched.page.getByRole('button', { name: 'SQLite conversation', exact: true }).click();
    await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
    await launched.page.getByRole('button', { name: '发送消息' }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    await launched.app.close();
    const file = path.join(directory, 'sessions', `${session!.id}.jsonl`);
    await rename(file, `${file}.backup`);
    launched = await launchElectron(directory);
    const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
    expect(sessions.find(candidate => candidate.id === session!.id)?.title).toBe('SQLite conversation');
    await launched.page.getByRole('button', { name: 'SQLite conversation', exact: true }).click();
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
    await launched.page.evaluate(sessionId => window.desktopAgent.renameSession({ sessionId, title: 'Still available' }), session!.id);
    expect((await launched.page.evaluate(() => window.desktopAgent.listSessions()))[0]?.title).toBe('Still available');
  } finally { await launched.app.close(); }
});

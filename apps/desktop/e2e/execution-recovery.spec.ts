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
    await expect.poll(() => {
      const db = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
      try { return db.prepare('SELECT status FROM server_runs WHERE id = ?').get(original.id)?.status; }
      finally { db.close(); }
    }).toBe('completed');
    await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
  } finally { await launched.app.close(); }
});

for (const decision of ['allow', 'deny'] as const) {
  test(`requires approval again after a hard crash, then respects ${decision}`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-approval-recovery-'));
    const target = path.join(directory, 'workspaces', 'general', 'e2e-approved.txt');
    let launched = await launchElectron(directory);
    const readOperation = () => {
      const db = new DatabaseSync(path.join(directory, 'runtime', 'agent-runtime.sqlite'));
      try {
        const row = db.prepare('SELECT id, state_json FROM operations ORDER BY updated_at LIMIT 1').get();
        return row ? { id: String(row.id), state: JSON.parse(String(row.state_json)) } : undefined;
      } finally { db.close(); }
    };
    try {
      await launched.page.getByRole('button', { name: '新建对话' }).click();
      await launched.page.getByPlaceholder('随心输入').fill('E2E: approval allow');
      await launched.page.getByRole('button', { name: '发送消息' }).click();
      await expect(launched.page.getByRole('dialog')).toBeVisible();
      const original = readOperation()!;
      const pending = original.state.calls.find((call: { permission: string }) => call.permission === 'pending');
      expect(pending.approvalRequest.requestId).toBeTruthy();
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      const exited = new Promise<void>(resolve => launched.app.process().once('exit', () => resolve()));
      launched.app.process().kill('SIGKILL');
      await exited;
      launched = await launchElectron(directory);
      const sessions = await launched.page.evaluate(() => window.desktopAgent.listSessions());
      await launched.page.getByText(sessions[0]!.title, { exact: true }).first().click();
      await launched.page.getByPlaceholder('随心输入').fill('E2E: text');
      await launched.page.getByRole('button', { name: '发送消息' }).click();
      await expect(launched.page.getByRole('dialog')).toBeVisible();
      expect(readOperation()).toMatchObject({ id: original.id });
      expect(readOperation()!.state.calls.find((call: { permission: string }) => call.permission === 'pending').approvalRequest.requestId)
        .not.toBe(pending.approvalRequest.requestId);
      const renewedId = readOperation()!.state.calls.find((call: { permission: string }) => call.permission === 'pending').approvalRequest.requestId;
      const readApproval = (id: string) => {
        const db = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
        try { return db.prepare('SELECT status, decision, resolved_by, run_id FROM server_approvals WHERE id = ?').get(id); }
        finally { db.close(); }
      };
      await expect.poll(() => readApproval(pending.approvalRequest.requestId)?.status).toBe('interrupted');
      await expect.poll(() => readApproval(renewedId)?.status).toBe('pending');
      expect(readApproval(renewedId)?.run_id).toBe(original.id);
      expect(readOperation()!.state.calls.find((call: { permission: string }) => call.permission === 'pending'))
        .toMatchObject({ callId: pending.callId, toolName: pending.toolName, input: pending.input });
      await launched.page.evaluate(requestId => window.desktopAgent.resolveApproval({ requestId, allow: true }), pending.approvalRequest.requestId);
      await expect(launched.page.getByRole('dialog')).toBeVisible();
      await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await launched.page.getByRole('button', { name: decision === 'allow' ? /允许一次/ : /拒绝/ }).click();
      await expect(launched.page.getByText('approval handled')).toBeVisible();
      await expect.poll(() => readApproval(renewedId)?.status).toBe(decision === 'allow' ? 'allowed' : 'denied');
      expect(readApproval(renewedId)?.decision).toBe(decision);
      expect(readApproval(renewedId)?.resolved_by).toBeTruthy();
      expect(readApproval(pending.approvalRequest.requestId)?.status).toBe('interrupted');
      await expect(launched.page.getByText('hello from offline e2e')).toBeVisible();
      if (decision === 'allow') expect(await readFile(target, 'utf8')).toBe('approved');
      else await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect.poll(() => {
        const db = new DatabaseSync(path.join(directory, 'runtime', 'application.sqlite'));
        try { return db.prepare('SELECT status FROM server_runs WHERE id = ?').get(original.id)?.status; }
        finally { db.close(); }
      }).toBe('completed');
    } finally { await launched.app.close(); }
  });
}

import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SERVER_STATE_SCHEMA_SQL } from '../src/server-state-schema.js';
import { SqliteServerStateStore } from '../src/sqlite-server-state-store.js';

async function databaseFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-server-state-')), 'server-state.sqlite');
}

describe('SqliteServerStateStore', () => {
  it('upgrades v2 without losing runs, then permanently removes their result copies', async () => {
    const filename = await databaseFile();
    const original = new SqliteServerStateStore(filename);
    await original.sessions.ensureActive({ sessionId: 's', title: 'kept' });
    await original.runs.createAccepted({ id: 'r', sessionId: 's', laneId: 'main', providerId: 'p', model: 'm', inputHash: 'hash' });
    await original.approvals.createPending({ id: 'a', sessionId: 's', laneId: 'main', runId: 'r', toolCallId: 'c', toolName: 'write', reason: 'ask', requestHash: 'hash' });
    await original.close();
    const old = new DatabaseSync(filename);
    old.exec('DROP TRIGGER application_session_no_resurrection; DROP TABLE application_deleted_sessions; PRAGMA user_version = 2');
    old.close();
    const upgraded = new SqliteServerStateStore(filename);
    const second = new SqliteServerStateStore(filename);
    try {
      expect(await upgraded.sessions.get('s')).toMatchObject({ title: 'kept' });
      expect(await upgraded.runs.get('r')).toMatchObject({ inputHash: 'hash' });
      upgraded.deleteSessionPermanently('s');
      expect(await second.runs.get('r')).toBeUndefined();
      expect(await second.approvals.get('a')).toBeUndefined();
      await expect(second.sessions.ensureActive({ sessionId: 's' })).rejects.toThrow('application_session_deleted');
      await expect(second.sessions.createCreating({ sessionId: 's' })).rejects.toThrow('application_session_deleted');
    } finally { await upgraded.close(); await second.close(); }
    const reopened = new SqliteServerStateStore(filename);
    try { await expect(reopened.sessions.ensureActive({ sessionId: 's' })).rejects.toThrow('application_session_deleted'); }
    finally { await reopened.close(); }
  });
  it('migrates an existing v1 database to the idempotency schema', async () => {
    const filename = await databaseFile();
    const legacy = new DatabaseSync(filename);
    legacy.exec('PRAGMA user_version = 1;');
    legacy.close();

    const migrated = new SqliteServerStateStore(filename, { now: () => 1_000 });
    await expect(migrated.idempotency.claim({
      principalId: 'principal-1', route: 'session.create', key: 'key-1', requestHash: 'hash-1',
      expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({ status: 'claimed' });
    await migrated.close();

    const verified = new DatabaseSync(filename);
    expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    expect(verified.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'server_idempotency'
    `).get()).toEqual({ name: 'server_idempotency' });
    verified.close();
  });

  it('persists metadata revisions and enforces optimistic concurrency across reopen', async () => {
    const filename = await databaseFile();
    let now = 1_000;
    const store = new SqliteServerStateStore(filename, { now: () => now++ });
    await store.sessions.createCreating({
      sessionId: 'session-1', title: 'Durable title', labels: ['one'], createdBy: 'principal-1'
    });
    const active = await store.sessions.activate('session-1');
    const patched = await store.sessions.patch('session-1', {
      labels: ['one', 'two'], favorite: true, expectedRevision: active.revision
    });
    expect(patched).toMatchObject({
      state: 'active', title: 'Durable title', labels: ['one', 'two'], favorite: true,
      revision: active.revision + 1
    });
    await expect(store.sessions.patch('session-1', {
      title: 'stale', expectedRevision: active.revision
    })).rejects.toThrow('revision_conflict');
    await store.close();

    const reopened = new SqliteServerStateStore(filename);
    expect(await reopened.sessions.get('session-1')).toMatchObject({
      title: 'Durable title', labels: ['one', 'two'], favorite: true, revision: patched.revision
    });
    await reopened.close();
  });

  it('persists terminal runs, bumps revision atomically, and forbids terminal rollback', async () => {
    const filename = await databaseFile();
    const store = new SqliteServerStateStore(filename, { now: () => 2_000 });
    await store.sessions.ensureActive({ sessionId: 'session-1' });
    const before = await store.sessions.get('session-1');
    const accepted = await store.runs.createAccepted({
      id: 'run-1', sessionId: 'session-1', laneId: 'main', providerId: 'provider', model: 'model',
      inputHash: 'hash', requestMeta: { budget: { maxIterations: 4 } }
    });
    const starting = await store.runs.markStarting('run-1', accepted.version);
    const running = await store.runs.markRunning('run-1', starting.version);
    const result = {
      runId: 'run-1', sessionId: 'session-1', laneId: 'main', status: 'completed' as const,
      finalText: 'durable answer', messages: []
    };
    const completed = await store.runs.markCompleted('run-1', result, running.version);
    expect(completed).toMatchObject({ status: 'completed', result, version: 4 });
    await expect(store.runs.markRunning('run-1')).rejects.toThrow('run_transition_conflict');
    expect((await store.sessions.get('session-1'))!.revision).toBe(before!.revision + 4);
    await store.close();

    const reopened = new SqliteServerStateStore(filename);
    expect(await reopened.runs.get('run-1')).toMatchObject({
      status: 'completed', result: { finalText: 'durable answer' }, version: 4
    });
    await reopened.close();
  });

  it('stores only sanitized approval summaries and makes decisions idempotent', async () => {
    const filename = await databaseFile();
    const store = new SqliteServerStateStore(filename, { now: () => 3_000 });
    await store.sessions.ensureActive({ sessionId: 'session-1' });
    await store.runs.createAccepted({
      id: 'run-1', sessionId: 'session-1', laneId: 'main', providerId: 'provider', model: 'model', inputHash: 'hash'
    });
    const pending = await store.approvals.createPending({
      id: 'approval-1', sessionId: 'session-1', laneId: 'main', runId: 'run-1',
      toolCallId: 'call-1', toolName: 'write_file', reason: 'Needs a write', requestHash: 'request-hash',
      preview: { kind: 'update', path: '/safe/path', additions: 2, deletions: 1 }
    });
    const allowed = await store.approvals.resolve('approval-1', 'allow', 'principal-1', pending.version);
    expect(allowed).toMatchObject({ status: 'allowed', decision: 'allow', resolvedBy: 'principal-1' });
    await expect(store.approvals.resolve('approval-1', 'allow')).resolves.toMatchObject({ status: 'allowed' });
    await expect(store.approvals.resolve('approval-1', 'deny')).rejects.toThrow('approval_already_resolved');
    await store.close();

    const database = new DatabaseSync(filename);
    const row = database.prepare('SELECT preview_json FROM server_approvals WHERE id = ?').get('approval-1') as {
      preview_json: string;
    };
    expect(row.preview_json).toContain('/safe/path');
    expect(row.preview_json).not.toContain('patch');
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 6 });
    database.close();
  });

  it('persists completed idempotency responses and protects pending claims', async () => {
    const filename = await databaseFile();
    const identity = {
      principalId: 'principal-1', route: 'run.start:session-1', key: 'key-1', requestHash: 'hash-1'
    };
    const store = new SqliteServerStateStore(filename, { now: () => 4_000 });
    await expect(store.idempotency.claim({
      ...identity, expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({ status: 'claimed' });
    await expect(store.idempotency.claim({
      ...identity, expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({ status: 'pending' });
    await expect(store.idempotency.claim({
      ...identity, requestHash: 'different', expiresAt: new Date(20_000).toISOString()
    })).rejects.toThrow('idempotency_conflict');
    await store.idempotency.complete({ ...identity, result: { id: 'run-1', status: 'running' } });
    await store.close();

    const reopened = new SqliteServerStateStore(filename, { now: () => 5_000 });
    await expect(reopened.idempotency.claim({
      ...identity, expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({
      status: 'completed', result: { id: 'run-1', status: 'running' }
    });
    const second = { ...identity, key: 'key-2' };
    await reopened.idempotency.claim({ ...second, expiresAt: new Date(20_000).toISOString() });
    await reopened.idempotency.abandon(second);
    await expect(reopened.idempotency.claim({
      ...second, expiresAt: new Date(20_000).toISOString()
    })).resolves.toEqual({ status: 'claimed' });
    await reopened.close();
  });
});


it.each([false, true])('migrates v3 approval audit atomically (corrupt foreign key: %s)', async corrupt => {
  const filename = await databaseFile();
  const legacy = new DatabaseSync(filename);
  const v3 = SERVER_STATE_SCHEMA_SQL
    .replace("    scope TEXT NOT NULL DEFAULT 'run' CHECK(scope IN ('run', 'session')),\n", '')
    .replace('    run_id TEXT REFERENCES server_runs(id)', '    run_id TEXT NOT NULL REFERENCES server_runs(id)')
    .replace('    lane_id TEXT,', '    lane_id TEXT NOT NULL,')
    .replace(",\n    CHECK((scope = 'run' AND run_id IS NOT NULL AND lane_id IS NOT NULL)\n       OR (scope = 'session' AND run_id IS NULL AND lane_id IS NULL))", '');
  legacy.exec(v3);
  legacy.exec(`PRAGMA user_version = 3;
    INSERT INTO server_sessions(session_id,state,created_at,updated_at) VALUES ('s','active',1000,1000);
    INSERT INTO server_runs(id,session_id,lane_id,status,provider_id,model,input_hash,created_at,updated_at)
      VALUES ('r','s','main','running','p','m','h',1000,1000);
    INSERT INTO server_approvals(id,session_id,run_id,lane_id,status,tool_call_id,tool_name,reason,request_hash,
      decision,resolved_by,created_at,resolved_at,updated_at,version)
      VALUES ('old','s','r','main','allowed','c','write','ask','h','allow','owner',1000,2000,2000,2);`);
  expect(legacy.prepare('PRAGMA table_info(server_approvals)').all().some(column => column.name === 'scope')).toBe(false);
  if (corrupt) legacy.exec("PRAGMA foreign_keys = OFF; DELETE FROM server_runs WHERE id = 'r';");
  legacy.close();
  if (corrupt) {
    expect(() => new SqliteServerStateStore(filename)).toThrow('FOREIGN KEY');
    const unchanged = new DatabaseSync(filename);
    try {
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(unchanged.prepare('SELECT status FROM server_approvals WHERE id = ?').get('old')).toEqual({ status: 'allowed' });
      expect(unchanged.prepare('PRAGMA table_info(server_approvals)').all().some(column => column.name === 'scope')).toBe(false);
    } finally { unchanged.close(); }
    return;
  }
  const upgraded = new SqliteServerStateStore(filename);
  try {
    expect(await upgraded.approvals.get('old')).toMatchObject({
      sessionId: 's', runId: 'r', laneId: 'main', status: 'allowed', decision: 'allow',
      resolvedBy: 'owner', version: 2, resolvedAt: new Date(2000).toISOString()
    });
    const preparation = { id: 'preflight', scope: 'session' as const, sessionId: 's', toolCallId: 'hook',
      toolName: 'hook', reason: 'trust', requestHash: 'session-hash' };
    await upgraded.approvals.createPending(preparation);
    await upgraded.approvals.resolve('preflight', 'deny', 'owner');
    await expect(upgraded.approvals.createPending({ ...preparation, sessionId: 'other' })).rejects.toThrow('approval_conflict');
    await expect(upgraded.approvals.createPending({ ...preparation, id: 'bad-run', scope: 'run', runId: 'missing', laneId: 'main' }))
      .rejects.toThrow('run_not_found');
  } finally { await upgraded.close(); }
  const reopened = new SqliteServerStateStore(filename);
  try {
    expect(await reopened.approvals.get('preflight')).toMatchObject({ scope: 'session', status: 'denied', resolvedBy: 'owner' });
    expect(await reopened.approvals.get('preflight')).not.toHaveProperty('runId');
    reopened.deleteSessionPermanently('s');
    expect(await reopened.approvals.get('preflight')).toBeUndefined();
    expect(await reopened.approvals.get('old')).toBeUndefined();
  } finally { await reopened.close(); }
});

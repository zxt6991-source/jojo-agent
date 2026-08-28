import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { SqliteServerStateStore } from '../src/sqlite-server-state-store.js';

async function databaseFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-server-state-')), 'server-state.sqlite');
}

describe('SqliteServerStateStore', () => {
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
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    database.close();
  });
});

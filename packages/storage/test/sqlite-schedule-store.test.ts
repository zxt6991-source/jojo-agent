import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Schedule } from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '../src/index.js';

async function databaseFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-scheduler-')), 'scheduler.sqlite');
}

function schedule(): Schedule {
  return {
    id: 'sch_1', name: 'Durable', enabled: true,
    spec: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-08-30T00:00:00.000Z' },
    target: {
      kind: 'agent', sessionId: 'session-1', input: { content: [{ type: 'text', text: 'review' }] },
      providerId: 'provider', model: 'model'
    },
    delivery: { conversation: { enabled: true, sessionId: 'session-1' } },
    misfire: { kind: 'fire_once', graceMs: 86_400_000 }, concurrency: 'skip',
    nextRunAt: '2026-08-30T00:01:00.000Z', revision: 1, createdBy: 'user-1',
    createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
  };
}

describe('SqliteScheduleStore', () => {
  it('atomically claims an occurrence, advances the schedule, and rejects duplicates', async () => {
    const filename = await databaseFile();
    const store = new SqliteScheduleStore(filename);
    const item = await store.create(schedule());
    const run = {
      id: 'sr_1', scheduleId: item.id, occurrenceKey: 'timer:1', scheduledFor: item.nextRunAt!,
      trigger: 'timer' as const, status: 'dispatching' as const, targetKind: 'agent' as const,
      createdAt: '2026-08-30T00:01:00.000Z', targetSnapshot: item.target
    };
    const claimed = await store.claimOccurrence({
      scheduleId: item.id, expectedRevision: item.revision, expectedNextRunAt: item.nextRunAt!,
      run, nextRunAt: '2026-08-30T00:02:00.000Z', updateLastRunAt: true
    });
    expect(claimed).toMatchObject({ claimed: true, run: { id: 'sr_1', version: 1 } });
    if (!claimed.claimed) throw new Error('Expected occurrence claim.');
    const completed = await store.transitionRun('sr_1', {
      status: 'completed', finishedAt: '2026-08-30T00:01:10.000Z', resultPreview: 'done',
      deliveryStatus: 'delivered', deliveryMessageId: 'scheduler_sr_1'
    }, claimed.run.version);
    expect(completed).toMatchObject({
      status: 'completed', deliveryStatus: 'delivered', deliveryMessageId: 'scheduler_sr_1'
    });
    await expect(store.claimOccurrence({
      scheduleId: item.id, run: { ...run, id: 'sr_duplicate' }, nextRunAt: '2026-08-30T00:03:00.000Z'
    })).resolves.toEqual({ claimed: false });
    expect(await store.get(item.id)).toMatchObject({
      nextRunAt: '2026-08-30T00:02:00.000Z', lastRunAt: item.nextRunAt, revision: 2
    });
    await store.close();

    const reopened = new SqliteScheduleStore(filename);
    expect(await reopened.get(item.id)).toMatchObject({
      delivery: { conversation: { enabled: true, sessionId: 'session-1' } }
    });
    expect(await reopened.getRun('sr_1')).toMatchObject({
      occurrenceKey: 'timer:1', status: 'completed', deliveryStatus: 'delivered',
      deliveryMessageId: 'scheduler_sr_1'
    });
    await reopened.close();
  });

  it('enforces schedule revisions and an expiring engine lease', async () => {
    const store = new SqliteScheduleStore(await databaseFile());
    const item = await store.create(schedule());
    const updated = await store.update({ ...item, name: 'Updated', updatedAt: '2026-08-30T00:00:01.000Z' }, item.revision);
    expect(updated).toMatchObject({ name: 'Updated', revision: 2 });
    await expect(store.update({ ...item, name: 'Stale' }, item.revision)).rejects.toThrow('schedule_revision_conflict');
    await expect(store.acquireEngineLease('owner-a', 1_000, 30_000)).resolves.toBe(true);
    await expect(store.acquireEngineLease('owner-b', 2_000, 30_000)).resolves.toBe(false);
    await expect(store.acquireEngineLease('owner-b', 31_001, 30_000)).resolves.toBe(true);
    await store.close();
  });

  it('migrates legacy scheduler tables without enabling conversation delivery', async () => {
    const filename = await databaseFile();
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, enabled INTEGER NOT NULL,
        schedule_kind TEXT NOT NULL, schedule_json TEXT NOT NULL, target_kind TEXT NOT NULL,
        target_json TEXT NOT NULL, misfire_json TEXT NOT NULL, concurrency_policy TEXT NOT NULL,
        next_run_at INTEGER, last_run_at INTEGER, revision INTEGER NOT NULL, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
      );
      CREATE TABLE schedule_runs (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, occurrence_key TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL, trigger_kind TEXT NOT NULL, status TEXT NOT NULL,
        target_kind TEXT NOT NULL, target_execution_id TEXT, target_snapshot_json TEXT NOT NULL,
        claimed_by TEXT, claim_expires_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER,
        finished_at INTEGER, error_code TEXT, error TEXT, result_preview TEXT, version INTEGER NOT NULL,
        UNIQUE(schedule_id, occurrence_key)
      );
    `);
    const item = schedule();
    legacy.prepare(`
      INSERT INTO schedules (
        id, name, description, enabled, schedule_kind, schedule_json, target_kind, target_json,
        misfire_json, concurrency_policy, next_run_at, last_run_at, revision, created_by,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id, item.name, null, 1, item.spec.kind, JSON.stringify(item.spec), item.target.kind,
      JSON.stringify(item.target), JSON.stringify(item.misfire), item.concurrency,
      new Date(item.nextRunAt!).getTime(), null, item.revision, item.createdBy,
      new Date(item.createdAt).getTime(), new Date(item.updatedAt).getTime(), null
    );
    legacy.close();

    const migrated = new SqliteScheduleStore(filename);
    expect(await migrated.get(item.id)).toMatchObject({ id: item.id });
    expect((await migrated.get(item.id))?.delivery).toBeUndefined();
    const run = await migrated.createManualRun({
      id: 'sr_migrated', scheduleId: item.id, occurrenceKey: 'manual:migrated',
      scheduledFor: item.createdAt, trigger: 'manual', status: 'completed', targetKind: 'agent',
      createdAt: item.createdAt, finishedAt: item.createdAt, targetSnapshot: item.target,
      deliveryStatus: 'skipped'
    });
    expect(run.deliveryStatus).toBe('skipped');
    await migrated.close();
  });
});

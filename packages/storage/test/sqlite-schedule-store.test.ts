import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    await expect(store.claimOccurrence({
      scheduleId: item.id, expectedRevision: item.revision, expectedNextRunAt: item.nextRunAt!,
      run, nextRunAt: '2026-08-30T00:02:00.000Z', updateLastRunAt: true
    })).resolves.toMatchObject({ claimed: true, run: { id: 'sr_1', version: 1 } });
    await expect(store.claimOccurrence({
      scheduleId: item.id, run: { ...run, id: 'sr_duplicate' }, nextRunAt: '2026-08-30T00:03:00.000Z'
    })).resolves.toEqual({ claimed: false });
    expect(await store.get(item.id)).toMatchObject({
      nextRunAt: '2026-08-30T00:02:00.000Z', lastRunAt: item.nextRunAt, revision: 2
    });
    await store.close();

    const reopened = new SqliteScheduleStore(filename);
    expect(await reopened.getRun('sr_1')).toMatchObject({ occurrenceKey: 'timer:1', status: 'dispatching' });
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
});

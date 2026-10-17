import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ScheduleDeliveryItemSchema, ScheduleTargetSchema, ScheduleVoiceDeliverySchema } from '@desktop-agent/contracts';
import { MemoryScheduleStore, type Schedule, type ScheduleDeliveryItem, type ScheduleStore } from '@desktop-agent/scheduler';
import { SqliteScheduleStore } from '../src/sqlite-schedule-store.js';

const now = Date.parse('2026-10-14T12:00:00.000Z');
const stamp = (offset = 0) => new Date(now + offset).toISOString();
const voice = { enabled: true, deviceId: 'local-desktop', content: { kind: 'result', maxChars: 200 }, expiresAfterMs: 60_000 } as const;
function schedule(): Schedule {
  return {
    id: 'schedule', name: '喝水', enabled: true, spec: { kind: 'once', runAt: stamp() },
    target: { kind: 'reminder', text: '喝水' },
    delivery: { conversation: { enabled: true, sessionId: 'session' }, voice },
    misfire: { kind: 'fire_once', graceMs: 60_000 }, concurrency: 'skip', revision: 1,
    createdBy: 'user', createdAt: stamp(), updatedAt: stamp(), nextRunAt: stamp()
  };
}
function delivery(destination: 'voice' | 'conversation' = 'voice', runId = 'run'): ScheduleDeliveryItem {
  return {
    id: `${runId}_${destination}`, scheduleRunId: runId, destination,
    destinationId: destination === 'voice' ? 'local-desktop' : 'session',
    dedupeKey: `${runId}:${destination}`, state: 'pending', attempts: 0,
    payloadSnapshot: destination === 'voice'
      ? { kind: 'voice', title: '喝水', content: '该喝水了', createdAt: stamp(), messageId: `message_${runId}`, deviceId: 'local-desktop' }
      : { kind: 'conversation', title: '喝水', content: '该喝水了', createdAt: stamp(), messageId: `message_${runId}` },
    createdAt: stamp(), updatedAt: stamp(), expiresAt: stamp(60_000), version: 1
  };
}
async function run(store: ScheduleStore, id = 'run') {
  await store.createManualRun({
    id, scheduleId: 'schedule', occurrenceKey: `manual:${id}`, scheduledFor: stamp(), trigger: 'manual',
    status: 'running', targetKind: 'reminder', targetSnapshot: { kind: 'reminder', text: '喝水' }, createdAt: stamp()
  });
  return store.transitionRunWithDeliveries(id, { status: 'completed', finishedAt: stamp() }, [delivery('voice', id), delivery('conversation', id)], 1);
}
function claim(itemId = 'run_voice', offset = 0, token = 'claim') {
  return { itemId, claimToken: token, playbackId: `playback_${token}`, generation: 1, now: now + offset, ttlMs: 20_000 };
}
async function filename() {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-outbox-')), 'scheduler.sqlite');
}

for (const kind of ['memory', 'sqlite'] as const) describe(`${kind} scheduler delivery outbox`, () => {
  async function create(): Promise<ScheduleStore> {
    const store = kind === 'memory' ? new MemoryScheduleStore() : new SqliteScheduleStore(await filename());
    await store.create(schedule());
    return store;
  }
  it('fixes initial delivery settings and atomically returns per-destination terminal items', async () => {
    const store = await create();
    const completed = await run(store);
    expect(completed.deliverySnapshot).toEqual({ name: '喝水', scheduleRevision: 1, delivery: schedule().delivery });
    expect(completed.deliveryItems).toHaveLength(2);
    const changed = await store.update({ ...schedule(), name: '新的名字', delivery: { ...schedule().delivery, conversation: { enabled: true, sessionId: 'different' } } }, 1);
    expect(changed.revision).toBe(2);
    expect((await store.getRun('run'))?.deliverySnapshot?.name).toBe('喝水');
    expect((await store.getDelivery('run_conversation'))?.destinationId).toBe('session');
    await store.close?.();
  });
  it('rejects duplicate destination inserts and stale terminal CAS without partial writes', async () => {
    const store = await create();
    await store.createManualRun({ id: 'run', scheduleId: 'schedule', occurrenceKey: 'manual:run', scheduledFor: stamp(), trigger: 'manual', status: 'running', targetKind: 'reminder', targetSnapshot: schedule().target, createdAt: stamp() });
    await expect(store.transitionRunWithDeliveries('run', { status: 'completed' }, [delivery(), { ...delivery(), id: 'different', dedupeKey: 'different' }], 1)).rejects.toThrow('schedule_delivery_conflict');
    expect(await store.listDeliveries()).toEqual([]);
    expect(await store.getRun('run')).toMatchObject({ status: 'running', version: 1 });
    await store.transitionRunWithDeliveries('run', { status: 'completed' }, [delivery()], 1);
    await expect(store.transitionRunWithDeliveries('run', { status: 'completed' }, [delivery('conversation')], 1)).rejects.toThrow('schedule_run_revision_conflict');
    expect(await store.listDeliveries()).toHaveLength(1);
    await store.close?.();
  });
  it('allows only one claim and fences start, end and lease renewal by the complete identity', async () => {
    const store = await create(); await run(store);
    const [first, second] = await Promise.all([store.claimDelivery(claim()), store.claimDelivery(claim('run_voice', 0, 'other'))]);
    expect(first).toMatchObject({ state: 'claimed', attempts: 1 }); expect(second).toBeUndefined();
    expect(await store.ackDelivery({ ...claim(), playbackId: 'stale', state: 'playing' })).toBeUndefined();
    expect(await store.ackDelivery({ ...claim(), state: 'played' })).toBeUndefined();
    expect(await store.ackDelivery({ ...claim(), state: 'playing' })).toMatchObject({ state: 'playing' });
    expect(await store.renewDeliveryClaim(claim('run_voice', 10_000))).toMatchObject({ claimExpiresAt: stamp(30_000) });
    expect(await store.ackDelivery({ ...claim('run_voice', 25_000), state: 'played' })).toMatchObject({ state: 'played' });
    expect(await store.ackDelivery({ ...claim('run_voice', 25_001), state: 'played' })).toBeUndefined();
    expect(await store.claimDelivery(claim('run_voice', 25_002, 'new'))).toBeUndefined();
    await store.close?.();
  });
  it('recovers lost voice permission as uncertain and rejects a late ACK or automatic replay', async () => {
    const store = await create(); await run(store); await store.claimDelivery(claim());
    expect(await store.ackDelivery({ ...claim('run_voice', 20_000), state: 'played' })).toBeUndefined();
    expect(await store.getDelivery('run_voice')).toMatchObject({ state: 'uncertain', attempts: 1 });
    expect(await store.claimDelivery(claim('run_voice', 20_001, 'new'))).toBeUndefined();
    const replayed = await store.replayDelivery('run_voice', now + 20_002);
    expect(replayed).toMatchObject({ state: 'pending' });
    await store.claimDelivery(claim('run_voice', 20_003, 'replay'));
    expect(await store.ackDelivery({ ...claim('run_voice', 20_004), state: 'playing' })).toBeUndefined();
    expect(await store.ackDelivery({ ...claim('run_voice', 20_004, 'replay'), state: 'playing' })).toMatchObject({ state: 'playing' });
    expect(await store.ackDelivery({ ...claim('run_voice', 20_005, 'replay'), state: 'failed', nextAttemptAt: stamp(25_000) })).toMatchObject({ state: 'uncertain' });
    await store.close?.();
  });
  it('bounds pre-play retries and leaves expired content silent', async () => {
    const store = await create(); await run(store);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const offset = attempt * 1_000;
      expect(await store.claimDelivery(claim('run_voice', offset, String(attempt)))).toMatchObject({ attempts: attempt });
      await store.ackDelivery({ ...claim('run_voice', offset, String(attempt)), state: 'failed', nextAttemptAt: stamp(offset + 500), errorCode: 'transient' });
      expect(await store.claimDelivery(claim('run_voice', offset + 1, 'early'))).toBeUndefined();
    }
    expect(await store.claimDelivery(claim('run_voice', 10_000, 'fourth'))).toBeUndefined();
    expect(await store.recoverDeliveries(now + 60_000)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'run_voice', state: 'expired' }), expect.objectContaining({ id: 'run_conversation', state: 'expired' })]));
    expect(await store.replayDelivery('run_voice', now + 60_001)).toBeUndefined();
    await store.close?.();
  });
  it('revokes unstarted voice on deletion or disabling voice and preserves text deliveries', async () => {
    const store = await create(); await run(store); await store.claimDelivery(claim());
    await store.update({ ...schedule(), delivery: { ...schedule().delivery, voice: { ...voice, enabled: false } }, updatedAt: stamp(100) }, 1);
    expect(await store.getDelivery('run_voice')).toMatchObject({ state: 'suppressed', errorCode: 'schedule_voice_revoked' });
    expect(await store.ackDelivery({ ...claim('run_voice', 101), state: 'playing' })).toBeUndefined();
    expect(await store.getDelivery('run_conversation')).toMatchObject({ state: 'pending' });
    expect(await store.replayDelivery('run_voice', now + 102)).toBeUndefined();
    await store.update({ ...schedule(), revision: 2, updatedAt: stamp(200) }, 2);
    await run(store, 'later');
    await store.softDelete('schedule', stamp(300));
    expect(await store.getDelivery('later_voice')).toMatchObject({ state: 'suppressed' });
    expect(await store.getDelivery('later_conversation')).toMatchObject({ state: 'pending' });
    await store.close?.();
  });
  it('projects partial delivery independently without changing the terminal run version', async () => {
    const store = await create(); await run(store);
    await store.claimDelivery(claim('run_conversation'));
    await store.ackDelivery({ ...claim('run_conversation'), state: 'delivered' });
    expect(await store.getRun('run')).toMatchObject({ status: 'completed', version: 2, deliveryStatus: 'pending', deliveryMessageId: 'message_run' });
    await store.claimDelivery(claim());
    await store.ackDelivery({ ...claim(), state: 'failed', error: '无语音权限' });
    expect(await store.getRun('run')).toMatchObject({ status: 'completed', version: 2, deliveryStatus: 'failed', deliveryMessageId: 'message_run', deliveryError: '无语音权限' });
    expect(await store.listPendingDeliveryRuns()).toEqual([]);
    await store.close?.();
  });
  it('refuses a stale manual revision and revokes a voice intent produced after deletion', async () => {
    const store = await create();
    const initial = { id: 'run', scheduleId: 'schedule', occurrenceKey: 'manual:run', scheduledFor: stamp(), trigger: 'manual' as const, status: 'running' as const, targetKind: 'reminder' as const, targetSnapshot: schedule().target, createdAt: stamp() };
    await store.update({ ...schedule(), name: '已编辑', updatedAt: stamp(100) }, 1);
    await expect(store.createManualRun(initial, 1)).rejects.toThrow('schedule_revision_conflict');
    expect(await store.getRun('run')).toBeUndefined();
    await store.createManualRun(initial, 2);
    await store.softDelete('schedule', stamp(200));
    await store.transitionRunWithDeliveries('run', { status: 'completed' }, [delivery(), delivery('conversation')], 1);
    expect(await store.getDelivery('run_voice')).toMatchObject({ state: 'suppressed' });
    expect(await store.getDelivery('run_conversation')).toMatchObject({ state: 'pending' });
    await store.close?.();
  });
  it('filters failed, backed-off, leased and expired entries before applying the queue limit', async () => {
    const store = await create(); await run(store);
    await store.claimDelivery(claim('run_conversation'));
    await store.ackDelivery({ ...claim('run_conversation'), state: 'failed' });
    expect(await store.listDeliveries({ states: ['pending', 'failed'], dueAt: now, limit: 1 })).toMatchObject([{ id: 'run_voice' }]);
    await store.claimDelivery(claim());
    expect(await store.listDeliveries({ states: ['pending', 'failed', 'claimed'], dueAt: now, limit: 1 })).toEqual([]);
    await store.ackDelivery({ ...claim(), state: 'failed', nextAttemptAt: stamp(10_000) });
    expect(await store.listDeliveries({ dueAt: now + 1_000 })).toEqual([]);
    expect(await store.listDeliveries({ dueAt: now + 10_000 })).toMatchObject([{ id: 'run_voice' }]);
    expect(await store.listDeliveries({ dueAt: now + 60_000 })).toEqual([]);
    await store.close?.();
  });
});

describe('SQLite scheduler durability', () => {
  it('rolls the terminal update and all earlier inserts back when a later insert fails', async () => {
    const file = await filename(); const store = new SqliteScheduleStore(file); await store.create(schedule());
    await store.createManualRun({ id: 'run', scheduleId: 'schedule', occurrenceKey: 'manual:run', scheduledFor: stamp(), trigger: 'manual', status: 'running', targetKind: 'reminder', targetSnapshot: schedule().target, createdAt: stamp() });
    const fault = new DatabaseSync(file);
    fault.exec("CREATE TRIGGER fail_voice BEFORE INSERT ON schedule_delivery_items WHEN NEW.destination = 'voice' BEGIN SELECT RAISE(ABORT, 'injected fault'); END;"); fault.close();
    await expect(store.transitionRunWithDeliveries('run', { status: 'completed', finishedAt: stamp() }, [delivery('conversation'), delivery('voice')], 1)).rejects.toThrow('injected fault');
    expect(await store.getRun('run')).toMatchObject({ status: 'running', version: 1 }); expect(await store.listDeliveries()).toEqual([]);
    await store.close();
    const reopened = new SqliteScheduleStore(file);
    expect(await reopened.getRun('run')).toMatchObject({ status: 'running', version: 1 }); expect(await reopened.listDeliveries()).toEqual([]);
    await reopened.close();
  });
  it('persists fixed payloads, admits one claimant across connections and recovers without replay', async () => {
    const file = await filename(); const first = new SqliteScheduleStore(file); await first.create(schedule()); await run(first);
    const second = new SqliteScheduleStore(file);
    const claims = await Promise.all([first.claimDelivery(claim()), second.claimDelivery(claim('run_voice', 0, 'other'))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await first.ackDelivery({ ...claim(), state: 'playing' }); await first.close(); await second.close();
    const reopened = new SqliteScheduleStore(file);
    expect(await reopened.getDelivery('run_voice')).toMatchObject({ payloadSnapshot: delivery().payloadSnapshot, state: 'playing' });
    expect(await reopened.recoverDeliveries(now + 20_000)).toMatchObject([{ id: 'run_voice', state: 'uncertain' }]);
    expect(await reopened.claimDelivery(claim('run_voice', 20_001, 'new'))).toBeUndefined();
    expect(await reopened.ackDelivery({ ...claim('run_voice', 20_001), state: 'played' })).toBeUndefined();
    await reopened.close();
  });
  it('reopens migration idempotently and never manufactures deliveries for historical terminal runs', async () => {
    const file = await filename(); const store = new SqliteScheduleStore(file); await store.create(schedule());
    await store.createManualRun({ id: 'legacy', scheduleId: 'schedule', occurrenceKey: 'manual:legacy', scheduledFor: stamp(), trigger: 'manual', status: 'failed', targetKind: 'reminder', targetSnapshot: schedule().target, createdAt: stamp() }); await store.close();
    const legacy = new DatabaseSync(file);
    legacy.exec('DROP TABLE schedule_delivery_items; DROP TABLE scheduler_schema_meta; ALTER TABLE schedule_runs DROP COLUMN delivery_snapshot_json; PRAGMA user_version = 77;'); legacy.close();
    for (let index = 0; index < 2; index += 1) {
      const migrated = new SqliteScheduleStore(file);
      expect(await migrated.getRun('legacy')).toMatchObject({ status: 'failed' });
      expect((await migrated.getRun('legacy'))?.deliverySnapshot).toBeUndefined(); expect(await migrated.listDeliveries()).toEqual([]);
      await migrated.close();
    }
    const inspected = new DatabaseSync(file);
    expect(inspected.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 77 });
    expect(inspected.prepare("SELECT version FROM scheduler_schema_meta WHERE key = 'scheduler'").get()).toMatchObject({ version: 2 }); inspected.close();
  });
  it('rejects a future dedicated scheduler schema before modifying its tables', async () => {
    const file = await filename(); const future = new DatabaseSync(file);
    future.exec("CREATE TABLE scheduler_schema_meta(key TEXT PRIMARY KEY, version INTEGER); INSERT INTO scheduler_schema_meta VALUES ('scheduler', 3);"); future.close();
    expect(() => new SqliteScheduleStore(file)).toThrow('scheduler_schema_version_unsupported: 3');
    const inspected = new DatabaseSync(file);
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get()).toBeUndefined(); inspected.close();
  });
});

describe('reminder and delivery contracts', () => {
  it('accepts trimmed fixed reminders while rejecting oversized or executable target fields', () => {
    expect(ScheduleTargetSchema.parse({ kind: 'reminder', text: ' 喝水 ' })).toEqual({ kind: 'reminder', text: '喝水' });
    expect(ScheduleTargetSchema.safeParse({ kind: 'reminder', text: ' ', providerId: 'provider' }).success).toBe(false);
    expect(ScheduleTargetSchema.safeParse({ kind: 'reminder', text: '水'.repeat(201) }).success).toBe(false);
    expect(ScheduleVoiceDeliverySchema.safeParse({ ...voice, expiresAfterMs: 999 }).success).toBe(false);
    expect(ScheduleVoiceDeliverySchema.safeParse({ ...voice, deviceId: 'remote' }).success).toBe(false);
    expect(ScheduleVoiceDeliverySchema.safeParse({ ...voice, content: { kind: 'result', maxChars: 601 } }).success).toBe(false);
    expect(ScheduleDeliveryItemSchema.safeParse({ ...delivery(), payloadSnapshot: delivery('conversation').payloadSnapshot }).success).toBe(false);
    expect(ScheduleDeliveryItemSchema.safeParse({ ...delivery(), state: 'playing' }).success).toBe(false);
    expect(ScheduleDeliveryItemSchema.safeParse({ ...delivery(), claimToken: 'partial' }).success).toBe(false);
    expect(ScheduleDeliveryItemSchema.safeParse({ ...delivery(), payloadSnapshot: { ...delivery().payloadSnapshot, createdAt: stamp(1) } }).success).toBe(false);
  });
});

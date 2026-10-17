import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { ScheduleDeliveryItemSchema, ScheduleDeliverySnapshotSchema, ScheduleRunSchema, ScheduleSchema } from '@desktop-agent/contracts';
import {
  aggregateScheduleDeliveries, ackScheduleDelivery, claimScheduleDelivery, recoverScheduleDelivery, renewScheduleDelivery,
  replayScheduleDelivery, revokeScheduleVoice, snapshotScheduleRun, validateDeliveryInsert
} from '@desktop-agent/scheduler';
import type {
  ClaimOccurrenceInput,
  Schedule,
  ScheduleRun,
  ScheduleRunListOptions,
  ScheduleRunStatus,
  ScheduleRunTransition,
  ScheduleStore,
  ScheduleTarget,
  ScheduleSpec,
  MisfirePolicy,
  ScheduleConcurrencyPolicy,
  ScheduleDelivery,
  ScheduleDeliveryItem, ScheduleDeliveryListOptions, DeliveryClaimInput, DeliveryClaimIdentity, DeliveryAckInput
} from '@desktop-agent/scheduler';

type Row = Record<string, unknown>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    schedule_kind TEXT NOT NULL,
    schedule_json TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_json TEXT NOT NULL,
    delivery_json TEXT,
    misfire_json TEXT NOT NULL,
    concurrency_policy TEXT NOT NULL,
    next_run_at INTEGER,
    last_run_at INTEGER,
    revision INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

  CREATE TABLE IF NOT EXISTS schedule_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_execution_id TEXT,
    target_snapshot_json TEXT NOT NULL,
    claimed_by TEXT,
    claim_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    error_code TEXT,
    error TEXT,
    result_preview TEXT,
    delivery_status TEXT,
    delivery_message_id TEXT,
    delivery_error TEXT,
    version INTEGER NOT NULL,
    UNIQUE(schedule_id, occurrence_key)
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_runs_active ON schedule_runs(schedule_id, status);
  CREATE INDEX IF NOT EXISTS idx_schedule_runs_recovery ON schedule_runs(status, claim_expires_at);

  CREATE TABLE IF NOT EXISTS scheduler_leases (
    key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL
  );
`;

const OUTBOX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scheduler_schema_meta (
    key TEXT PRIMARY KEY CHECK(key = 'scheduler'), version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS schedule_delivery_items (
    id TEXT PRIMARY KEY,
    schedule_run_id TEXT NOT NULL REFERENCES schedule_runs(id),
    destination TEXT NOT NULL CHECK(destination IN ('conversation', 'notification', 'voice', 'channel')),
    destination_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_attempt_at INTEGER,
    expires_at INTEGER,
    claim_expires_at INTEGER,
    item_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    UNIQUE(schedule_run_id, destination, destination_id)
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_delivery_due ON schedule_delivery_items(state, next_attempt_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_schedule_delivery_run ON schedule_delivery_items(schedule_run_id);
`;

const terminal = new Set<ScheduleRunStatus>(['completed', 'failed', 'cancelled', 'skipped', 'interrupted']);
const recoverable: ScheduleRunStatus[] = ['pending', 'dispatching', 'running', 'waiting_approval'];

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`scheduler_store_corrupted: ${field}`);
  return value;
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`scheduler_store_corrupted: ${field}`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === null ? undefined : stringValue(value, field);
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === null ? undefined : integerValue(value, field);
}

function json<T>(value: unknown, field: string): T {
  try { return JSON.parse(stringValue(value, field)) as T; }
  catch { throw new Error(`scheduler_store_corrupted: ${field}`); }
}

function epoch(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isSafeInteger(time)) throw new Error(`scheduler_store_failed: Invalid timestamp ${value}`);
  return time;
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function scheduleFromRow(row: Row): Schedule {
  const enabled = integerValue(row.enabled, 'schedule enabled');
  const concurrency = stringValue(row.concurrency_policy, 'schedule concurrency') as ScheduleConcurrencyPolicy;
  const nextRunAt = iso(optionalInteger(row.next_run_at, 'schedule next_run_at'));
  const lastRunAt = iso(optionalInteger(row.last_run_at, 'schedule last_run_at'));
  const deletedAt = iso(optionalInteger(row.deleted_at, 'schedule deleted_at'));
  const description = optionalString(row.description, 'schedule description');
  const delivery = optionalString(row.delivery_json, 'schedule delivery');
  return ScheduleSchema.parse({
    id: stringValue(row.id, 'schedule id'),
    name: stringValue(row.name, 'schedule name'),
    ...(description ? { description } : {}),
    enabled: enabled === 1,
    spec: json<ScheduleSpec>(row.schedule_json, 'schedule spec'),
    target: json<ScheduleTarget>(row.target_json, 'schedule target'),
    ...(delivery ? { delivery: json<ScheduleDelivery>(delivery, 'schedule delivery') } : {}),
    misfire: json<MisfirePolicy>(row.misfire_json, 'schedule misfire'),
    concurrency,
    ...(nextRunAt ? { nextRunAt } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    revision: integerValue(row.revision, 'schedule revision'),
    createdBy: stringValue(row.created_by, 'schedule created_by'),
    createdAt: new Date(integerValue(row.created_at, 'schedule created_at')).toISOString(),
    updatedAt: new Date(integerValue(row.updated_at, 'schedule updated_at')).toISOString(),
    ...(deletedAt ? { deletedAt } : {})
  }) as Schedule;
}

function runFromRow(row: Row): ScheduleRun {
  const targetExecutionId = optionalString(row.target_execution_id, 'run target_execution_id');
  const claimedBy = optionalString(row.claimed_by, 'run claimed_by');
  const claimExpiresAt = iso(optionalInteger(row.claim_expires_at, 'run claim_expires_at'));
  const startedAt = iso(optionalInteger(row.started_at, 'run started_at'));
  const finishedAt = iso(optionalInteger(row.finished_at, 'run finished_at'));
  const errorCode = optionalString(row.error_code, 'run error_code');
  const error = optionalString(row.error, 'run error');
  const resultPreview = optionalString(row.result_preview, 'run result_preview');
  const deliveryStatus = optionalString(row.delivery_status, 'run delivery_status') as ScheduleRun['deliveryStatus'];
  const deliveryMessageId = optionalString(row.delivery_message_id, 'run delivery_message_id');
  const deliveryError = optionalString(row.delivery_error, 'run delivery_error');
  const deliverySnapshot = optionalString(row.delivery_snapshot_json, 'run delivery_snapshot_json');
  return ScheduleRunSchema.parse({
    id: stringValue(row.id, 'run id'),
    scheduleId: stringValue(row.schedule_id, 'run schedule_id'),
    occurrenceKey: stringValue(row.occurrence_key, 'run occurrence_key'),
    scheduledFor: new Date(integerValue(row.scheduled_for, 'run scheduled_for')).toISOString(),
    trigger: stringValue(row.trigger_kind, 'run trigger') as ScheduleRun['trigger'],
    status: stringValue(row.status, 'run status') as ScheduleRunStatus,
    targetKind: stringValue(row.target_kind, 'run target_kind') as ScheduleTarget['kind'],
    ...(targetExecutionId ? { targetExecutionId } : {}),
    ...(claimedBy ? { claimedBy } : {}),
    ...(claimExpiresAt ? { claimExpiresAt } : {}),
    createdAt: new Date(integerValue(row.created_at, 'run created_at')).toISOString(),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(error ? { error } : {}),
    ...(resultPreview ? { resultPreview } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(deliveryMessageId ? { deliveryMessageId } : {}),
    ...(deliveryError ? { deliveryError } : {}),
    targetSnapshot: json<ScheduleTarget>(row.target_snapshot_json, 'run target snapshot'),
    ...(deliverySnapshot ? { deliverySnapshot: ScheduleDeliverySnapshotSchema.parse(json(deliverySnapshot, 'run delivery snapshot')) } : {}),
    version: integerValue(row.version, 'run version')
  }) as ScheduleRun;
}

function placeholders(values: readonly unknown[]): string { return values.map(() => '?').join(', '); }

export class SqliteScheduleStore implements ScheduleStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    try {
      const meta = this.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_schema_meta'").get();
      if (meta) {
        const row = this.database.prepare("SELECT version FROM scheduler_schema_meta WHERE key = 'scheduler'").get() as Row | undefined;
        if (row && integerValue(row.version, 'scheduler schema version') > 2) throw new Error(`scheduler_schema_version_unsupported: ${row.version}`);
      }
      this.transaction(() => {
        this.database.exec(SCHEMA);
        this.ensureColumn('schedules', 'delivery_json', 'TEXT');
        this.ensureColumn('schedule_runs', 'delivery_status', 'TEXT');
        this.ensureColumn('schedule_runs', 'delivery_message_id', 'TEXT');
        this.ensureColumn('schedule_runs', 'delivery_error', 'TEXT');
        this.ensureColumn('schedule_runs', 'delivery_snapshot_json', 'TEXT');
        this.database.exec(OUTBOX_SCHEMA);
        this.database.prepare("INSERT INTO scheduler_schema_meta(key, version) VALUES ('scheduler', 2) ON CONFLICT(key) DO UPDATE SET version = 2").run();
      });
    } catch (error) { this.database.close(); throw error; }
  }

  async create(schedule: Schedule): Promise<Schedule> {
    ScheduleSchema.parse(schedule);
    try {
      this.database.prepare(`
        INSERT INTO schedules (
          id, name, description, enabled, schedule_kind, schedule_json, target_kind, target_json,
          delivery_json, misfire_json, concurrency_policy, next_run_at, last_run_at, revision,
          created_by, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...this.scheduleValues(schedule));
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new Error(`schedule_conflict: ${schedule.id}`);
      throw error;
    }
    return (await this.get(schedule.id))!;
  }

  async get(id: string): Promise<Schedule | undefined> {
    const row = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    return row ? scheduleFromRow(row) : undefined;
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<Schedule[]> {
    const rows = this.database.prepare(`
      SELECT * FROM schedules ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at ASC
    `).all() as Row[];
    return rows.map(scheduleFromRow);
  }

  async update(schedule: Schedule, expectedRevision?: number): Promise<Schedule> {
    ScheduleSchema.parse(schedule);
    const expected = expectedRevision ?? schedule.revision;
    return this.transaction(() => {
    const current = this.getScheduleSync(schedule.id);
    const result = this.database.prepare(`
      UPDATE schedules SET
        name = ?, description = ?, enabled = ?, schedule_kind = ?, schedule_json = ?, target_kind = ?,
        target_json = ?, delivery_json = ?, misfire_json = ?, concurrency_policy = ?, next_run_at = ?, last_run_at = ?,
        updated_at = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NULL AND revision = ?
    `).run(
      schedule.name, schedule.description ?? null, schedule.enabled ? 1 : 0, schedule.spec.kind,
      JSON.stringify(schedule.spec), schedule.target.kind, JSON.stringify(schedule.target),
      schedule.delivery ? JSON.stringify(schedule.delivery) : null,
      JSON.stringify(schedule.misfire), schedule.concurrency, epoch(schedule.nextRunAt), epoch(schedule.lastRunAt),
      epoch(schedule.updatedAt), schedule.id, expected
    );
    if (result.changes !== 1) {
      if (!current) throw new Error(`schedule_not_found: ${schedule.id}`);
      throw new Error(`schedule_revision_conflict: ${schedule.id}`);
    }
    if (current?.delivery?.voice?.enabled && !schedule.delivery?.voice?.enabled) this.revokeVoice(schedule.id, Date.parse(schedule.updatedAt));
    return this.getScheduleSync(schedule.id)!;
    });
  }

  async softDelete(id: string, now: string): Promise<Schedule> {
    return this.transaction(() => {
    const result = this.database.prepare(`
      UPDATE schedules SET enabled = 0, next_run_at = NULL, deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NULL
    `).run(epoch(now), epoch(now), id);
    const schedule = this.getScheduleSync(id);
    if (!schedule) throw new Error(`schedule_not_found: ${id}`);
    if (result.changes === 0 && !schedule.deletedAt) throw new Error(`scheduler_store_failed: ${id}`);
    this.revokeVoice(id, Date.parse(now));
    return schedule;
    });
  }

  async listDue(now: number, limit: number): Promise<Schedule[]> {
    return (this.database.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT ?
    `).all(now, limit) as Row[]).map(scheduleFromRow);
  }

  async nextDueAt(): Promise<string | undefined> {
    const row = this.database.prepare(`
      SELECT MIN(next_run_at) AS next_run_at FROM schedules WHERE enabled = 1 AND deleted_at IS NULL
    `).get() as Row;
    return iso(optionalInteger(row.next_run_at, 'next due'));
  }

  async claimOccurrence(input: ClaimOccurrenceInput): Promise<{ claimed: true; run: ScheduleRun } | { claimed: false }> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const scheduleRow = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(input.scheduleId) as Row | undefined;
      if (!scheduleRow) { this.database.exec('ROLLBACK;'); return { claimed: false }; }
      const schedule = scheduleFromRow(scheduleRow);
      if (!schedule.enabled || schedule.deletedAt
        || (input.expectedRevision !== undefined && schedule.revision !== input.expectedRevision)
        || (input.expectedNextRunAt !== undefined && schedule.nextRunAt !== input.expectedNextRunAt)) {
        this.database.exec('ROLLBACK;');
        return { claimed: false };
      }
      const initialRun = snapshotScheduleRun(input.run, schedule);
      try { this.insertRun(initialRun); this.insertDeliveries(initialRun.id, initialRun.deliveryItems ?? []); }
      catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          this.database.exec('ROLLBACK;');
          return { claimed: false };
        }
        throw error;
      }
      const updated = this.database.prepare(`
        UPDATE schedules SET enabled = ?, next_run_at = ?, last_run_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
      `).run(
        input.disableSchedule ? 0 : 1,
        epoch(input.nextRunAt),
        input.updateLastRunAt ? epoch(input.run.scheduledFor) : epoch(schedule.lastRunAt),
        epoch(input.run.createdAt),
        input.scheduleId,
        schedule.revision
      );
      if (updated.changes !== 1) throw new Error(`schedule_revision_conflict: ${input.scheduleId}`);
      this.database.exec('COMMIT;');
      return { claimed: true, run: (await this.getRun(input.run.id))! };
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  async createManualRun(run: Omit<ScheduleRun, 'version'>, expectedScheduleRevision?: number): Promise<ScheduleRun> {
    return this.transaction(() => {
    const schedule = this.getScheduleSync(run.scheduleId);
    if (!schedule || schedule.deletedAt) throw new Error(`schedule_not_found: ${run.scheduleId}`);
    if (expectedScheduleRevision !== undefined && schedule.revision !== expectedScheduleRevision) throw new Error(`schedule_revision_conflict: ${run.scheduleId}`);
    const initialRun = snapshotScheduleRun(run, schedule);
    try { this.insertRun(initialRun); this.insertDeliveries(initialRun.id, initialRun.deliveryItems ?? []); }
    catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new Error(`schedule_run_conflict: ${run.id}`);
      throw error;
    }
    return this.getRunSync(run.id)!;
    });
  }

  async getRun(id: string): Promise<ScheduleRun | undefined> {
    const row = this.database.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.withDeliveries(runFromRow(row)) : undefined;
  }

  async listRuns(scheduleId: string, options: ScheduleRunListOptions = {}): Promise<ScheduleRun[]> {
    const states = options.states ?? [];
    const stateFilter = states.length > 0 ? ` AND status IN (${placeholders(states)})` : '';
    const limit = options.limit ?? 1_000;
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE schedule_id = ?${stateFilter} ORDER BY created_at DESC LIMIT ?
    `).all(scheduleId, ...states, limit) as Row[]).map((row) => this.withDeliveries(runFromRow(row)));
  }

  async listRecoverableRuns(): Promise<ScheduleRun[]> {
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE status IN (${placeholders(recoverable)}) ORDER BY created_at ASC
    `).all(...recoverable) as Row[]).map((row) => this.withDeliveries(runFromRow(row)));
  }

  async listPendingDeliveryRuns(): Promise<ScheduleRun[]> {
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE delivery_status = 'pending' ORDER BY created_at ASC
    `).all() as Row[]).map((row) => this.withDeliveries(runFromRow(row))).filter((run) => run.deliveryStatus === 'pending');
  }

  async transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun> {
    return this.transitionRunWithDeliveries(id, transition, [], expectedVersion);
  }

  async transitionRunWithDeliveries(id: string, transition: ScheduleRunTransition, items: ScheduleDeliveryItem[], expectedVersion?: number): Promise<ScheduleRun> {
    return this.transaction(() => {
    const current = this.getRunSync(id);
    if (!current) throw new Error(`schedule_run_not_found: ${id}`);
    if (terminal.has(current.status) && transition.status !== current.status) {
      throw new Error(`schedule_run_transition_conflict: ${id}`);
    }
    const expected = expectedVersion ?? current.version;
    if (items.length && !terminal.has(transition.status)) throw new Error('schedule_delivery_run_not_terminal');
    const result = this.database.prepare(`
      UPDATE schedule_runs SET
        status = ?,
        target_execution_id = COALESCE(?, target_execution_id),
        started_at = COALESCE(?, started_at),
        finished_at = COALESCE(?, finished_at),
        error_code = COALESCE(?, error_code),
        error = COALESCE(?, error),
        result_preview = COALESCE(?, result_preview),
        delivery_status = COALESCE(?, delivery_status),
        delivery_message_id = COALESCE(?, delivery_message_id),
        delivery_error = COALESCE(?, delivery_error),
        claimed_by = COALESCE(?, claimed_by),
        claim_expires_at = COALESCE(?, claim_expires_at),
        version = version + 1
      WHERE id = ? AND version = ?
    `).run(
      transition.status,
      transition.targetExecutionId ?? null,
      epoch(transition.startedAt),
      epoch(transition.finishedAt),
      transition.errorCode ?? null,
      transition.error ?? null,
      transition.resultPreview?.slice(0, 4_096) ?? null,
      transition.deliveryStatus ?? null,
      transition.deliveryMessageId ?? null,
      transition.deliveryError?.slice(0, 100_000) ?? null,
      transition.claimedBy ?? null,
      epoch(transition.claimExpiresAt),
      id,
      expected
    );
    if (result.changes !== 1) throw new Error(`schedule_run_revision_conflict: ${id}`);
    this.insertDeliveries(id, items);
    return this.getRunSync(id)!;
    });
  }

  async getDelivery(id: string): Promise<ScheduleDeliveryItem | undefined> { return this.getDeliverySync(id); }

  async listDeliveries(options: ScheduleDeliveryListOptions = {}): Promise<ScheduleDeliveryItem[]> {
    return this.listDeliveriesSync(options);
  }

  async claimDelivery(input: DeliveryClaimInput): Promise<ScheduleDeliveryItem | undefined> {
    return this.transaction(() => {
      const item = this.getDeliverySync(input.itemId);
      if (!item) return undefined;
      const recovered = recoverScheduleDelivery(item, input.now);
      if (recovered) this.saveDelivery(recovered, item.version);
      const next = claimScheduleDelivery(recovered ?? item, input);
      return next ? this.saveDelivery(next, (recovered ?? item).version) : undefined;
    });
  }

  async renewDeliveryClaim(input: DeliveryClaimIdentity & { now: number; ttlMs: number }): Promise<ScheduleDeliveryItem | undefined> {
    return this.transaction(() => {
      const item = this.getDeliverySync(input.itemId);
      if (!item) return undefined;
      const recovered = recoverScheduleDelivery(item, input.now);
      if (recovered) { this.saveDelivery(recovered, item.version); return undefined; }
      const next = renewScheduleDelivery(item, input);
      return next ? this.saveDelivery(next, item.version) : undefined;
    });
  }

  async ackDelivery(input: DeliveryAckInput): Promise<ScheduleDeliveryItem | undefined> {
    return this.transaction(() => {
      const item = this.getDeliverySync(input.itemId);
      if (!item) return undefined;
      const recovered = recoverScheduleDelivery(item, input.now);
      if (recovered) { this.saveDelivery(recovered, item.version); return undefined; }
      const next = ackScheduleDelivery(item, input);
      if (!next) return undefined;
      return next.version === item.version ? next : this.saveDelivery(next, item.version);
    });
  }

  async recoverDeliveries(now: number): Promise<ScheduleDeliveryItem[]> {
    return this.transaction(() => {
      const changed: ScheduleDeliveryItem[] = [];
      // Recovery includes leader handovers and is never limited to one startup scan.
      const rows = this.database.prepare(`SELECT * FROM schedule_delivery_items
        WHERE state IN ('pending', 'preparing', 'ready', 'claimed', 'playing', 'failed')
          AND ((expires_at IS NOT NULL AND expires_at <= ?) OR (claim_expires_at IS NOT NULL AND claim_expires_at <= ?))
        ORDER BY created_at ASC, id ASC`).all(now, now) as Row[];
      for (const row of rows) {
        const item = this.deliveryFromRow(row);
        const next = recoverScheduleDelivery(item, now);
        if (next) changed.push(this.saveDelivery(next, item.version));
      }
      return changed;
    });
  }

  async replayDelivery(id: string, now: number): Promise<ScheduleDeliveryItem | undefined> {
    return this.transaction(() => {
      const item = this.getDeliverySync(id);
      const run = item && this.getRunSync(item.scheduleRunId);
      const schedule = run && this.getScheduleSync(run.scheduleId);
      if (!item || !schedule || schedule.deletedAt || !schedule.delivery?.voice?.enabled) return undefined;
      const next = replayScheduleDelivery(item, now);
      return next ? this.saveDelivery(next, item.version) : undefined;
    });
  }

  async acquireEngineLease(ownerId: string, now: number, ttlMs: number): Promise<boolean> {
    const result = this.database.prepare(`
      INSERT INTO scheduler_leases (key, owner_id, expires_at, version) VALUES ('engine', ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        owner_id = excluded.owner_id,
        expires_at = excluded.expires_at,
        version = scheduler_leases.version + 1
      WHERE scheduler_leases.owner_id = excluded.owner_id OR scheduler_leases.expires_at <= ?
    `).run(ownerId, now + ttlMs, now);
    return result.changes === 1;
  }

  async releaseEngineLease(ownerId: string): Promise<void> {
    this.database.prepare("DELETE FROM scheduler_leases WHERE key = 'engine' AND owner_id = ?").run(ownerId);
  }

  async close(): Promise<void> { this.database.close(); }

  private scheduleValues(schedule: Schedule): SQLInputValue[] {
    return [
      schedule.id, schedule.name, schedule.description ?? null, schedule.enabled ? 1 : 0,
      schedule.spec.kind, JSON.stringify(schedule.spec), schedule.target.kind, JSON.stringify(schedule.target),
      schedule.delivery ? JSON.stringify(schedule.delivery) : null,
      JSON.stringify(schedule.misfire), schedule.concurrency, epoch(schedule.nextRunAt), epoch(schedule.lastRunAt),
      schedule.revision, schedule.createdBy, epoch(schedule.createdAt), epoch(schedule.updatedAt), epoch(schedule.deletedAt)
    ];
  }

  private insertRun(run: Omit<ScheduleRun, 'version'>): void {
    ScheduleRunSchema.parse({ ...run, version: 1 });
    this.database.prepare(`
      INSERT INTO schedule_runs (
        id, schedule_id, occurrence_key, scheduled_for, trigger_kind, status, target_kind,
        target_execution_id, target_snapshot_json, claimed_by, claim_expires_at, created_at,
        started_at, finished_at, error_code, error, result_preview, delivery_status,
        delivery_message_id, delivery_error, delivery_snapshot_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      run.id, run.scheduleId, run.occurrenceKey, epoch(run.scheduledFor), run.trigger, run.status, run.targetKind,
      run.targetExecutionId ?? null, JSON.stringify(run.targetSnapshot), run.claimedBy ?? null, epoch(run.claimExpiresAt),
      epoch(run.createdAt), epoch(run.startedAt), epoch(run.finishedAt), run.errorCode ?? null, run.error ?? null,
      run.resultPreview?.slice(0, 4_096) ?? null, run.deliveryStatus ?? null,
      run.deliveryMessageId ?? null, run.deliveryError?.slice(0, 100_000) ?? null,
      run.deliverySnapshot ? JSON.stringify(run.deliverySnapshot) : null
    );
  }

  private transaction<T>(callback: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK;'); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  private getScheduleSync(id: string): Schedule | undefined {
    const row = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    return row ? scheduleFromRow(row) : undefined;
  }

  private getRunSync(id: string): ScheduleRun | undefined {
    const row = this.database.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? this.withDeliveries(runFromRow(row)) : undefined;
  }

  private withDeliveries(run: ScheduleRun): ScheduleRun {
    const items = this.listDeliveriesSync({ scheduleRunId: run.id, limit: 24 });
    return aggregateScheduleDeliveries(run, items);
  }

  private deliveryFromRow(row: Row): ScheduleDeliveryItem {
    const parsed = ScheduleDeliveryItemSchema.parse(json(row.item_json, 'delivery item'));
    if (parsed.id !== row.id || parsed.scheduleRunId !== row.schedule_run_id || parsed.destination !== row.destination
      || parsed.destinationId !== row.destination_id || parsed.dedupeKey !== row.dedupe_key
      || parsed.state !== row.state || parsed.version !== row.version) throw new Error('scheduler_store_corrupted: delivery item index');
    return parsed;
  }

  private getDeliverySync(id: string): ScheduleDeliveryItem | undefined {
    const row = this.database.prepare('SELECT * FROM schedule_delivery_items WHERE id = ?').get(id) as Row | undefined;
    return row ? this.deliveryFromRow(row) : undefined;
  }

  private listDeliveriesSync(options: ScheduleDeliveryListOptions): ScheduleDeliveryItem[] {
    const filters: string[] = [];
    const values: SQLInputValue[] = [];
    if (options.scheduleRunId) { filters.push('schedule_run_id = ?'); values.push(options.scheduleRunId); }
    if (options.destination) { filters.push('destination = ?'); values.push(options.destination); }
    if (options.states) {
      if (options.states.length === 0) return [];
      filters.push(`state IN (${placeholders(options.states)})`); values.push(...options.states);
    }
    if (options.dueAt !== undefined) {
      filters.push("state IN ('pending', 'preparing', 'ready', 'failed')");
      filters.push("(state != 'failed' OR next_attempt_at IS NOT NULL)");
      filters.push('claim_expires_at IS NULL');
      filters.push("json_extract(item_json, '$.attempts') < 3");
      filters.push('(next_attempt_at IS NULL OR next_attempt_at <= ?)'); values.push(options.dueAt);
      filters.push('(expires_at IS NULL OR expires_at > ?)'); values.push(options.dueAt);
    }
    return (this.database.prepare(`SELECT * FROM schedule_delivery_items ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at ASC, id ASC LIMIT ?`).all(...values, options.limit ?? 1_000) as Row[]).map((row) => this.deliveryFromRow(row));
  }

  private insertDeliveries(runId: string, items: ScheduleDeliveryItem[]): void {
    const count = this.database.prepare('SELECT COUNT(*) AS count FROM schedule_delivery_items WHERE schedule_run_id = ?').get(runId) as Row;
    if (items.length + integerValue(count.count, 'delivery count') > 24) throw new Error('schedule_delivery_limit');
    const parsed = items.map((item) => validateDeliveryInsert(item, runId));
    const runRow = this.database.prepare('SELECT schedule_id, status FROM schedule_runs WHERE id = ?').get(runId) as Row | undefined;
    if (items.length && (!runRow || !terminal.has(runRow.status as ScheduleRunStatus))) throw new Error('schedule_delivery_run_not_terminal');
    const schedule = runRow && this.getScheduleSync(stringValue(runRow.schedule_id, 'delivery schedule'));
    const insert = this.database.prepare(`INSERT INTO schedule_delivery_items (
      id, schedule_run_id, destination, destination_id, dedupe_key, state, created_at, next_attempt_at,
      expires_at, claim_expires_at, item_json, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of parsed) {
      const revoked = schedule && (schedule.deletedAt || !schedule.delivery?.voice?.enabled)
        ? revokeScheduleVoice(item, Date.parse(item.updatedAt)) : undefined;
      const next = revoked ?? item;
      try {
        insert.run(next.id, next.scheduleRunId, next.destination, next.destinationId, next.dedupeKey, next.state,
          epoch(next.createdAt), epoch(next.nextAttemptAt), epoch(next.expiresAt), epoch(next.claimExpiresAt), JSON.stringify(next), next.version);
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) throw new Error('schedule_delivery_conflict');
        throw error;
      }
    }
  }

  private saveDelivery(item: ScheduleDeliveryItem, expectedVersion: number): ScheduleDeliveryItem {
    ScheduleDeliveryItemSchema.parse(item);
    const result = this.database.prepare(`UPDATE schedule_delivery_items SET state = ?, next_attempt_at = ?,
      expires_at = ?, claim_expires_at = ?, item_json = ?, version = ? WHERE id = ? AND version = ?`).run(
      item.state, epoch(item.nextAttemptAt), epoch(item.expiresAt), epoch(item.claimExpiresAt), JSON.stringify(item), item.version,
      item.id, expectedVersion
    );
    if (result.changes !== 1) throw new Error(`schedule_delivery_revision_conflict: ${item.id}`);
    return structuredClone(item);
  }

  private revokeVoice(scheduleId: string, now: number): void {
    const rows = this.database.prepare(`SELECT items.* FROM schedule_delivery_items AS items
      JOIN schedule_runs AS runs ON runs.id = items.schedule_run_id
      WHERE runs.schedule_id = ? AND items.destination = 'voice'
        AND items.state IN ('pending', 'preparing', 'ready', 'claimed', 'failed')`).all(scheduleId) as Row[];
    for (const row of rows) {
      const item = this.deliveryFromRow(row);
      const next = revokeScheduleVoice(item, now);
      if (next) this.saveDelivery(next, item.version);
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((entry) => entry.name === column)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

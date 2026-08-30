import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
  ScheduleDelivery
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
  return {
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
  };
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
  return {
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
    version: integerValue(row.version, 'run version')
  };
}

function placeholders(values: readonly unknown[]): string { return values.map(() => '?').join(', '); }

export class SqliteScheduleStore implements ScheduleStore {
  private readonly database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL;');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec(SCHEMA);
    this.ensureColumn('schedules', 'delivery_json', 'TEXT');
    this.ensureColumn('schedule_runs', 'delivery_status', 'TEXT');
    this.ensureColumn('schedule_runs', 'delivery_message_id', 'TEXT');
    this.ensureColumn('schedule_runs', 'delivery_error', 'TEXT');
  }

  async create(schedule: Schedule): Promise<Schedule> {
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
    const expected = expectedRevision ?? schedule.revision;
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
      if (!await this.get(schedule.id)) throw new Error(`schedule_not_found: ${schedule.id}`);
      throw new Error(`schedule_revision_conflict: ${schedule.id}`);
    }
    return (await this.get(schedule.id))!;
  }

  async softDelete(id: string, now: string): Promise<Schedule> {
    const result = this.database.prepare(`
      UPDATE schedules SET enabled = 0, next_run_at = NULL, deleted_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND deleted_at IS NULL
    `).run(epoch(now), epoch(now), id);
    const schedule = await this.get(id);
    if (!schedule) throw new Error(`schedule_not_found: ${id}`);
    if (result.changes === 0 && !schedule.deletedAt) throw new Error(`scheduler_store_failed: ${id}`);
    return schedule;
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
      try { this.insertRun(input.run); }
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

  async createManualRun(run: Omit<ScheduleRun, 'version'>): Promise<ScheduleRun> {
    try { this.insertRun(run); }
    catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) throw new Error(`schedule_run_conflict: ${run.id}`);
      throw error;
    }
    return (await this.getRun(run.id))!;
  }

  async getRun(id: string): Promise<ScheduleRun | undefined> {
    const row = this.database.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  async listRuns(scheduleId: string, options: ScheduleRunListOptions = {}): Promise<ScheduleRun[]> {
    const states = options.states ?? [];
    const stateFilter = states.length > 0 ? ` AND status IN (${placeholders(states)})` : '';
    const limit = options.limit ?? 1_000;
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE schedule_id = ?${stateFilter} ORDER BY created_at DESC LIMIT ?
    `).all(scheduleId, ...states, limit) as Row[]).map(runFromRow);
  }

  async listRecoverableRuns(): Promise<ScheduleRun[]> {
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE status IN (${placeholders(recoverable)}) ORDER BY created_at ASC
    `).all(...recoverable) as Row[]).map(runFromRow);
  }

  async listPendingDeliveryRuns(): Promise<ScheduleRun[]> {
    return (this.database.prepare(`
      SELECT * FROM schedule_runs WHERE delivery_status = 'pending' ORDER BY created_at ASC
    `).all() as Row[]).map(runFromRow);
  }

  async transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun> {
    const current = await this.getRun(id);
    if (!current) throw new Error(`schedule_run_not_found: ${id}`);
    if (terminal.has(current.status) && transition.status !== current.status) {
      throw new Error(`schedule_run_transition_conflict: ${id}`);
    }
    const expected = expectedVersion ?? current.version;
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
    return (await this.getRun(id))!;
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
    this.database.prepare(`
      INSERT INTO schedule_runs (
        id, schedule_id, occurrence_key, scheduled_for, trigger_kind, status, target_kind,
        target_execution_id, target_snapshot_json, claimed_by, claim_expires_at, created_at,
        started_at, finished_at, error_code, error, result_preview, delivery_status,
        delivery_message_id, delivery_error, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      run.id, run.scheduleId, run.occurrenceKey, epoch(run.scheduledFor), run.trigger, run.status, run.targetKind,
      run.targetExecutionId ?? null, JSON.stringify(run.targetSnapshot), run.claimedBy ?? null, epoch(run.claimExpiresAt),
      epoch(run.createdAt), epoch(run.startedAt), epoch(run.finishedAt), run.errorCode ?? null, run.error ?? null,
      run.resultPreview?.slice(0, 4_096) ?? null, run.deliveryStatus ?? null,
      run.deliveryMessageId ?? null, run.deliveryError?.slice(0, 100_000) ?? null
    );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (columns.some((entry) => entry.name === column)) return;
    this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

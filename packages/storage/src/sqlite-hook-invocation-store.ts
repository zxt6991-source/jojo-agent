import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  HookEventName,
  HookFailure,
  HookInvocationRecord,
  HookInvocationStore
} from '@desktop-agent/contracts';

type Row = Record<string, unknown>;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`hook_sqlite_corrupted: ${label}`);
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function parseJson<T>(value: unknown, label: string): T | undefined {
  if (value === null || value === undefined) return undefined;
  try { return JSON.parse(requiredText(value, label)) as T; }
  catch { throw new Error(`hook_sqlite_corrupted: ${label}`); }
}

export class SqliteHookInvocationStore implements HookInvocationStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS hook_invocations (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        payload_json TEXT,
        result_json TEXT,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS hook_invocations_operation ON hook_invocations(operation_id, event);
    `);
    const columns = this.database.prepare('PRAGMA table_info(hook_invocations)').all() as Row[];
    if (!columns.some((column) => column.name === 'payload_json')) {
      this.database.exec('ALTER TABLE hook_invocations ADD COLUMN payload_json TEXT;');
    }
  }

  close(): void { this.database.close(); }

  async getInvocation(id: string): Promise<HookInvocationRecord | undefined> {
    const row = this.database.prepare('SELECT * FROM hook_invocations WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    const result = parseJson<unknown>(row.result_json, 'result');
    const payload = parseJson<unknown>(row.payload_json, 'payload');
    const error = parseJson<HookFailure>(row.error_json, 'error');
    const startedAt = optionalInteger(row.started_at);
    const completedAt = optionalInteger(row.completed_at);
    return {
      id: requiredText(row.id, 'id'),
      eventId: requiredText(row.event_id, 'event id'),
      hookId: requiredText(row.hook_id, 'hook id'),
      event: requiredText(row.event, 'event') as HookEventName,
      sessionId: requiredText(row.session_id, 'session id'),
      operationId: requiredText(row.operation_id, 'operation id'),
      subjectId: requiredText(row.subject_id, 'subject id'),
      state: requiredText(row.state, 'state') as HookInvocationRecord['state'],
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(row.result_json !== null ? { result } : {}),
      ...(row.payload_json !== null ? { payload } : {}),
      ...(error ? { error } : {})
    };
  }

  async beginInvocation(record: HookInvocationRecord): Promise<'created' | 'exists'> {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO hook_invocations(
        id, event_id, hook_id, event, session_id, operation_id, subject_id, state, started_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      record.id, record.eventId, record.hookId, record.event,
      record.sessionId, record.operationId, record.subjectId, Date.now(), JSON.stringify(record.payload ?? null)
    );
    return result.changes === 1 ? 'created' : 'exists';
  }

  async completeInvocation(id: string, result: unknown): Promise<void> {
    const changed = this.database.prepare(`
      UPDATE hook_invocations SET state = 'completed', result_json = ?, completed_at = ?, error_json = NULL
      WHERE id = ?
    `).run(JSON.stringify(result ?? null), Date.now(), id);
    if (changed.changes !== 1) throw new Error(`hook_invocation_not_found: ${id}`);
  }

  async failInvocation(id: string, error: HookFailure): Promise<void> {
    const changed = this.database.prepare(`
      UPDATE hook_invocations SET state = 'failed', error_json = ?, completed_at = ? WHERE id = ?
    `).run(JSON.stringify(error), Date.now(), id);
    if (changed.changes !== 1) throw new Error(`hook_invocation_not_found: ${id}`);
  }

  async listIncomplete(): Promise<HookInvocationRecord[]> {
    const rows = this.database.prepare(`
      SELECT id FROM hook_invocations WHERE state = 'pending' OR state = 'running' ORDER BY started_at, id
    `).all() as Row[];
    const records = await Promise.all(rows.map((row) => this.getInvocation(requiredText(row.id, 'id'))));
    return records.filter((record): record is HookInvocationRecord => record !== undefined);
  }
}

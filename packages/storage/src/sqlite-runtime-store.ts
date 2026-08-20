import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  assertOperationState,
  isTerminalState,
  type AgentRuntimeStore,
  type AppendEntryInput,
  type Clock,
  type LaneState,
  type OperationMeta,
  type OperationState,
  type Session,
  type SessionEntry,
  type StoredOperation,
  type UsageRecord
} from '@desktop-agent/agent-runtime';

const systemClock: Clock = { now: () => Date.now() };

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json<T>(value: unknown, label: string): T {
  if (typeof value !== 'string') throw new Error(`runtime_sqlite_corrupted: ${label}`);
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`runtime_sqlite_corrupted: ${label}`); }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`runtime_sqlite_corrupted: ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`runtime_sqlite_corrupted: ${label}`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return text(value, label);
}

function entryFromRow(row: Row): SessionEntry {
  const payload = json<Record<string, unknown>>(row.payload_json, 'entry payload');
  return {
    id: text(row.id, 'entry id'),
    sessionId: text(row.session_id, 'entry session'),
    seq: integer(row.seq, 'entry sequence'),
    parentId: nullableText(row.parent_id, 'entry parent'),
    type: text(row.type, 'entry type'),
    createdAt: integer(row.created_at, 'entry created_at'),
    ...payload
  } as SessionEntry;
}

function entryPayload(entry: SessionEntry): Record<string, unknown> {
  const payload = { ...entry } as Record<string, unknown>;
  for (const key of ['id', 'sessionId', 'seq', 'parentId', 'type', 'createdAt']) delete payload[key];
  return payload;
}

export class SqliteAgentRuntimeStore implements AgentRuntimeStore {
  private readonly database: DatabaseSync;

  constructor(
    readonly filename: string,
    private readonly clock: Clock = systemClock
  ) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const version = this.database.prepare('PRAGMA user_version').get() as Row | undefined;
    const userVersion = version ? Number(Object.values(version)[0]) : 0;
    if (userVersion > 1) {
      this.database.close();
      throw new Error(`runtime_sqlite_version_unsupported: ${userVersion}`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        parent_id TEXT REFERENCES entries(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS entries_session_parent ON entries(session_id, parent_id);
      CREATE TABLE IF NOT EXISTS lanes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        leaf_id TEXT REFERENCES entries(id),
        current_operation_id TEXT,
        PRIMARY KEY(session_id, name)
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        lane TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id, lane) REFERENCES lanes(session_id, name)
      );
      CREATE INDEX IF NOT EXISTS operations_session_lane ON operations(session_id, lane);
      CREATE TABLE IF NOT EXISTS usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        operation_id TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_session_created ON usage(session_id, created_at);
      PRAGMA user_version = 1;
    `);
  }

  close(): void {
    this.database.close();
  }

  async createSession(session: Session): Promise<void> {
    if (await this.getSession(session.id)) throw new Error(`runtime_session_exists: ${session.id}`);
    this.database.prepare('INSERT INTO sessions(id, metadata_json, created_at) VALUES (?, ?, ?)').run(
      session.id,
      session.metadata ? JSON.stringify(session.metadata) : null,
      session.createdAt
    );
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const row = this.database.prepare('SELECT id, metadata_json, created_at FROM sessions WHERE id = ?').get(sessionId) as Row | undefined;
    if (!row) return null;
    const metadata = row.metadata_json === null
      ? undefined
      : json<Session['metadata']>(row.metadata_json, 'session metadata');
    return {
      id: text(row.id, 'session id'),
      createdAt: integer(row.created_at, 'session created_at'),
      ...(metadata ? { metadata } : {})
    };
  }

  async appendEntry(input: AppendEntryInput): Promise<SessionEntry> {
    this.requireSession(input.sessionId);
    if (this.entryRow(input.id)) throw new Error(`runtime_entry_exists: ${input.id}`);
    if (input.parentId) {
      const parent = this.entryRow(input.parentId);
      if (!parent || parent.session_id !== input.sessionId) throw new Error(`runtime_parent_not_found: ${input.parentId}`);
    }
    const next = this.database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM entries WHERE session_id = ?')
      .get(input.sessionId) as Row;
    const entry = {
      ...clone(input),
      seq: integer(next.seq, 'next entry sequence'),
      createdAt: this.clock.now()
    } as SessionEntry;
    this.database.prepare(`
      INSERT INTO entries(id, session_id, seq, parent_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.sessionId, entry.seq, entry.parentId, entry.type,
      JSON.stringify(entryPayload(entry)), entry.createdAt
    );
    return clone(entry);
  }

  async getEntry(id: string): Promise<SessionEntry | null> {
    const row = this.entryRow(id);
    return row ? entryFromRow(row) : null;
  }

  async readPath(leafId: string | null): Promise<SessionEntry[]> {
    if (leafId === null) return [];
    const result: SessionEntry[] = [];
    const visited = new Set<string>();
    let id: string | null = leafId;
    let sessionId: string | null = null;
    while (id) {
      if (visited.has(id)) throw new Error(`runtime_entry_cycle: ${id}`);
      visited.add(id);
      const row = this.entryRow(id);
      if (!row) throw new Error(`runtime_entry_not_found: ${id}`);
      const entry = entryFromRow(row);
      if (sessionId && entry.sessionId !== sessionId) throw new Error(`runtime_entry_session_mismatch: ${id}`);
      sessionId = entry.sessionId;
      result.push(entry);
      id = entry.parentId;
    }
    return result.reverse();
  }

  async getLane(sessionId: string, lane: string): Promise<LaneState | null> {
    const row = this.database.prepare(`
      SELECT session_id, name, leaf_id, current_operation_id FROM lanes WHERE session_id = ? AND name = ?
    `).get(sessionId, lane) as Row | undefined;
    return row ? this.laneFromRow(row) : null;
  }

  async listLanes(sessionId: string): Promise<LaneState[]> {
    const rows = this.database.prepare(`
      SELECT session_id, name, leaf_id, current_operation_id FROM lanes WHERE session_id = ? ORDER BY name
    `).all(sessionId) as Row[];
    return rows.map((row) => this.laneFromRow(row));
  }

  async saveLane(lane: LaneState): Promise<void> {
    this.requireSession(lane.sessionId);
    if (!lane.name) throw new Error('runtime_lane_name_required');
    const existing = await this.getLane(lane.sessionId, lane.name);
    if (existing?.currentOperationId && lane.currentOperationId !== existing.currentOperationId) {
      throw new Error(`runtime_lane_busy: ${lane.name}`);
    }
    if (lane.leafId) {
      const leaf = this.entryRow(lane.leafId);
      if (!leaf || leaf.session_id !== lane.sessionId) throw new Error(`runtime_lane_leaf_not_found: ${lane.leafId}`);
    }
    if (lane.currentOperationId) {
      const operation = this.operationRow(lane.currentOperationId);
      if (!operation || operation.session_id !== lane.sessionId || operation.lane !== lane.name) {
        throw new Error(`runtime_lane_operation_not_found: ${lane.currentOperationId}`);
      }
    }
    this.database.prepare(`
      INSERT INTO lanes(session_id, name, leaf_id, current_operation_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, name) DO UPDATE SET leaf_id = excluded.leaf_id,
        current_operation_id = excluded.current_operation_id
    `).run(lane.sessionId, lane.name, lane.leafId, lane.currentOperationId);
  }

  async startOperation(meta: OperationMeta, initialState: OperationState): Promise<void> {
    this.requireSession(meta.sessionId);
    if (this.operationRow(meta.id)) throw new Error(`runtime_operation_exists: ${meta.id}`);
    if (initialState.operationId !== meta.id || initialState.lane !== meta.lane) {
      throw new Error('runtime_operation_identity_mismatch');
    }
    if (isTerminalState(initialState)) throw new Error('runtime_operation_initial_state_terminal');
    assertOperationState(initialState);
    this.transaction(() => {
      const lane = this.laneRow(meta.sessionId, meta.lane);
      if (!lane) throw new Error(`runtime_lane_not_found: ${meta.lane}`);
      if (lane.current_operation_id) throw new Error(`runtime_lane_busy: ${meta.lane}`);
      this.database.prepare(`
        INSERT INTO operations(id, session_id, lane, meta_json, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(meta.id, meta.sessionId, meta.lane, JSON.stringify(meta), JSON.stringify(initialState), this.clock.now());
      this.database.prepare(`
        UPDATE lanes SET current_operation_id = ? WHERE session_id = ? AND name = ?
      `).run(meta.id, meta.sessionId, meta.lane);
    });
  }

  async loadOperation(operationId: string): Promise<StoredOperation | null> {
    const row = this.operationRow(operationId);
    if (!row) return null;
    const meta = json<OperationMeta>(row.meta_json, 'operation meta');
    const state = json<OperationState>(row.state_json, 'operation state');
    assertOperationState(state);
    return clone({ meta, state });
  }

  async saveOperationState(state: OperationState): Promise<void> {
    assertOperationState(state);
    this.transaction(() => {
      const operation = this.operationRow(state.operationId);
      if (!operation) throw new Error(`runtime_operation_not_found: ${state.operationId}`);
      if (operation.lane !== state.lane) throw new Error('runtime_operation_lane_mismatch');
      this.database.prepare('UPDATE operations SET state_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(state), this.clock.now(), state.operationId);
      if (isTerminalState(state)) {
        this.database.prepare(`
          UPDATE lanes SET current_operation_id = NULL
          WHERE session_id = ? AND name = ? AND current_operation_id = ?
        `).run(operation.session_id as SQLInputValue, operation.lane as SQLInputValue, state.operationId);
      }
    });
  }

  async appendUsage(usage: UsageRecord): Promise<void> {
    this.requireSession(usage.sessionId);
    const existing = this.database.prepare('SELECT id FROM usage WHERE id = ?').get(usage.id);
    if (existing) throw new Error(`runtime_usage_exists: ${usage.id}`);
    this.database.prepare(`
      INSERT INTO usage(id, session_id, operation_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(
      usage.id, usage.sessionId, usage.operationId ?? null, JSON.stringify(usage), usage.createdAt
    );
  }

  async readUsage(sessionId: string): Promise<UsageRecord[]> {
    const rows = this.database.prepare(`
      SELECT payload_json FROM usage WHERE session_id = ? ORDER BY created_at, id
    `).all(sessionId) as Row[];
    return rows.map((row) => json<UsageRecord>(row.payload_json, 'usage payload'));
  }

  private entryRow(id: string): Row | undefined {
    return this.database.prepare(`
      SELECT id, session_id, seq, parent_id, type, payload_json, created_at FROM entries WHERE id = ?
    `).get(id) as Row | undefined;
  }

  private laneRow(sessionId: string, lane: string): Row | undefined {
    return this.database.prepare(`
      SELECT session_id, name, leaf_id, current_operation_id FROM lanes WHERE session_id = ? AND name = ?
    `).get(sessionId, lane) as Row | undefined;
  }

  private operationRow(operationId: string): Row | undefined {
    return this.database.prepare(`
      SELECT id, session_id, lane, meta_json, state_json, updated_at FROM operations WHERE id = ?
    `).get(operationId) as Row | undefined;
  }

  private laneFromRow(row: Row): LaneState {
    return {
      sessionId: text(row.session_id, 'lane session'),
      name: text(row.name, 'lane name'),
      leafId: nullableText(row.leaf_id, 'lane leaf'),
      currentOperationId: nullableText(row.current_operation_id, 'lane operation')
    };
  }

  private requireSession(sessionId: string): void {
    if (!this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) {
      throw new Error(`runtime_session_not_found: ${sessionId}`);
    }
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

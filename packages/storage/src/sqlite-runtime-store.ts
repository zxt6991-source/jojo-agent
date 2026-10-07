import { LEGACY_TRANSCRIPT_CUTOVER, LEGACY_TRANSCRIPT_MIGRATION, transcriptHash, validateLegacyTranscript, type LegacyTranscriptMigration, type LegacyTranscriptImportResult } from './legacy-transcript-migration.js';
import { MessageSchema, type Message } from '@desktop-agent/contracts';
import { BUILD_COMPATIBILITY } from '@desktop-agent/contracts/build-compatibility';
import { validateOperationExecution, MAX_OPERATION_META_BYTES } from '@desktop-agent/agent-runtime/spi';
import { isDeepStrictEqual } from 'node:util';
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
} from '@desktop-agent/agent-runtime/spi';

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
    if (userVersion > BUILD_COMPATIBILITY.runtimeSqliteSchema) {
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
      CREATE TABLE IF NOT EXISTS runtime_migrations (
        migration_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source_hash TEXT NOT NULL,
        imported_hash TEXT NOT NULL,
        source_count INTEGER NOT NULL,
        imported_count INTEGER NOT NULL,
        retained_count INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY(migration_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_deleted_sessions (
        session_id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_pending_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      PRAGMA user_version = ${BUILD_COMPATIBILITY.runtimeSqliteSchema};
    `);
  }

  close(): void {
    this.database.close();
  }

  async createSession(session: Session): Promise<void> {
    this.transaction(() => {
      if (this.database.prepare('SELECT session_id FROM runtime_deleted_sessions WHERE session_id = ?').get(session.id)) {
        throw new Error(`runtime_session_deleted: ${session.id}`);
      }
      if (this.database.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id)) throw new Error(`runtime_session_exists: ${session.id}`);
      this.database.prepare('INSERT INTO sessions(id, metadata_json, created_at) VALUES (?, ?, ?)').run(
        session.id, session.metadata ? JSON.stringify(session.metadata) : null, session.createdAt
      );
    });
  }

  deleteSessionPermanently(sessionId: string): void {
    this.transaction(() => {
      this.database.prepare('INSERT OR IGNORE INTO runtime_deleted_sessions(session_id, deleted_at) VALUES (?, ?)').run(sessionId, this.clock.now());
      this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    });
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

  async listSessions(): Promise<Session[]> {
    const rows = this.database.prepare(
      'SELECT id, metadata_json, created_at FROM sessions ORDER BY created_at DESC, id'
    ).all() as Row[];
    return rows.map((row) => {
      const metadata = row.metadata_json === null
        ? undefined
        : json<Session['metadata']>(row.metadata_json, 'session metadata');
      return {
        id: text(row.id, 'session id'),
        createdAt: integer(row.created_at, 'session created_at'),
        ...(metadata ? { metadata } : {})
      };
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  /** Atomic transition adapter: runtime messages win when a legacy projection differs. */
  importLegacyTranscript(sessionId: string, source: readonly Message[], options: { once?: boolean } = {}): LegacyTranscriptImportResult {
    const migrationId = options.once ? LEGACY_TRANSCRIPT_CUTOVER : LEGACY_TRANSCRIPT_MIGRATION;
    const messages = validateLegacyTranscript(source);
    const sourceHash = transcriptHash(messages);
    return this.transaction(() => {
      this.requireSession(sessionId);
      const row = this.database.prepare('SELECT * FROM lanes WHERE session_id = ? AND name = ?').get(sessionId, 'main') as Row | undefined;
      if (!row) throw new Error('runtime_lane_not_found: main');
      const lane = this.laneFromRow(row);
      if (lane.currentOperationId) return { status: 'busy', importedCount: 0, retainedCount: 0, sourceHash };
      const previous = this.getLegacyTranscriptMigration(sessionId, migrationId);
      if (previous && (options.once || previous.sourceHash === sourceHash)) return { status: 'unchanged', importedCount: 0, retainedCount: previous.retainedCount, sourceHash };
      const pathIds = new Set<string>();
      let cursor = lane.leafId;
      while (cursor) {
        if (pathIds.has(cursor)) throw new Error('runtime_path_cycle');
        pathIds.add(cursor);
        const entry = this.entryRow(cursor);
        if (!entry || entry.session_id !== sessionId) throw new Error(`runtime_parent_not_found: ${cursor}`);
        cursor = nullableText(entry.parent_id, 'entry parent');
      }
      const next = this.database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM entries WHERE session_id = ?').get(sessionId) as Row;
      let sequence = integer(next.seq, 'next entry sequence');
      let leaf = lane.leafId;
      let retainedCount = 0;
      const imported: Message[] = [];
      for (const message of messages) {
        const existing = this.entryRow(message.id);
        if (existing) {
          if (existing.session_id !== sessionId || existing.type !== 'message') throw new Error(`legacy_entry_collision: ${message.id}`);
          if (pathIds.has(message.id)) {
            retainedCount += 1;
            continue;
          }
          // Recover an entry left behind by the old appendEntry -> saveLane sequence.
          const value = entryFromRow(existing);
          if (existing.parent_id !== leaf || value.type !== 'message' || transcriptHash([value.message]) !== transcriptHash([message])) {
            throw new Error(`legacy_detached_entry_conflict: ${message.id}`);
          }
        } else {
          this.database.prepare('INSERT INTO entries(id, session_id, seq, parent_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(message.id, sessionId, sequence++, leaf, 'message', JSON.stringify({ message }), this.clock.now());
        }
        imported.push(message);
        pathIds.add(message.id);
        leaf = message.id;
      }
      this.database.prepare('UPDATE lanes SET leaf_id = ? WHERE session_id = ? AND name = ?').run(leaf, sessionId, 'main');
      const importedHash = transcriptHash(imported);
      const persisted = imported.map((message) => {
        const entry = entryFromRow(this.entryRow(message.id)!);
        if (entry.type !== 'message') throw new Error('legacy_transcript_verification_failed');
        return entry.message;
      });
      if (transcriptHash(persisted) !== importedHash) throw new Error('legacy_transcript_verification_failed');
      this.database.prepare(`INSERT INTO runtime_migrations(migration_id, session_id, source_hash, imported_hash, source_count, imported_count, retained_count, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(migration_id, session_id) DO UPDATE SET source_hash = excluded.source_hash,
        imported_hash = excluded.imported_hash, source_count = excluded.source_count,
        imported_count = excluded.imported_count, retained_count = excluded.retained_count, completed_at = excluded.completed_at`)
        .run(migrationId, sessionId, sourceHash, importedHash, messages.length, imported.length, retainedCount, this.clock.now());
      return { status: 'imported', importedCount: imported.length, retainedCount, sourceHash };
    });
  }

  getLegacyTranscriptMigration(sessionId: string, migrationId: string = LEGACY_TRANSCRIPT_MIGRATION): LegacyTranscriptMigration | null {
    const row = this.database.prepare('SELECT * FROM runtime_migrations WHERE migration_id = ? AND session_id = ?')
      .get(migrationId, sessionId) as Row | undefined;
    if (!row) return null;
    return {
      migrationId: text(row.migration_id, 'migration id'), sessionId: text(row.session_id, 'migration session'),
      sourceHash: text(row.source_hash, 'migration source hash'), importedHash: text(row.imported_hash, 'migration imported hash'),
      sourceCount: integer(row.source_count, 'migration source count'), importedCount: integer(row.imported_count, 'migration imported count'),
      retainedCount: integer(row.retained_count, 'migration retained count'), completedAt: integer(row.completed_at, 'migration completion')
    };
  }

  hasLegacyTranscriptCutover(sessionId: string): boolean {
    return this.getLegacyTranscriptMigration(sessionId, LEGACY_TRANSCRIPT_CUTOVER) !== null;
  }

  /** Durable external delivery; an active operation never loses its lane ownership. */
  appendConversationMessage(sessionId: string, input: Message): void {
    const message = MessageSchema.parse(input);
    this.transaction(() => {
      this.requireSession(sessionId);
      const existing = this.entryRow(message.id);
      if (existing) {
        const entry = entryFromRow(existing);
        if (entry.sessionId !== sessionId || entry.type !== 'message' || transcriptHash([entry.message]) !== transcriptHash([message])) {
          throw new Error(`runtime_message_conflict: ${message.id}`);
        }
        return;
      }
      const pending = this.database.prepare('SELECT * FROM runtime_pending_messages WHERE id = ?').get(message.id) as Row | undefined;
      if (pending) {
        if (pending.session_id !== sessionId || transcriptHash([json<Message>(pending.message_json, 'pending message')]) !== transcriptHash([message])) {
          throw new Error(`runtime_message_conflict: ${message.id}`);
        }
      } else {
        this.database.prepare('INSERT INTO runtime_pending_messages(id, session_id, message_json, created_at) VALUES (?, ?, ?, ?)')
          .run(message.id, sessionId, JSON.stringify(message), this.clock.now());
      }
      this.drainConversationMessages(sessionId);
    });
  }

  flushConversationMessages(sessionId: string): void {
    this.transaction(() => { this.drainConversationMessages(sessionId); });
  }

  private drainConversationMessages(sessionId: string): void {
    const row = this.database.prepare('SELECT * FROM lanes WHERE session_id = ? AND name = ?').get(sessionId, 'main') as Row | undefined;
    if (!row) throw new Error('runtime_lane_not_found: main');
    const lane = this.laneFromRow(row);
    if (lane.currentOperationId) return;
    const pending = this.database.prepare('SELECT * FROM runtime_pending_messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[];
    if (!pending.length) return;
    const next = this.database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM entries WHERE session_id = ?').get(sessionId) as Row;
    let sequence = integer(next.seq, 'next entry sequence');
    let leaf = lane.leafId;
    for (const item of pending) {
      const message = json<Message>(item.message_json, 'pending message');
      this.database.prepare('INSERT INTO entries(id, session_id, seq, parent_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(message.id, sessionId, sequence++, leaf, 'message', JSON.stringify({ message }), integer(item.created_at, 'pending timestamp'));
      leaf = message.id;
    }
    this.database.prepare('UPDATE lanes SET leaf_id = ? WHERE session_id = ? AND name = ?').run(leaf, sessionId, 'main');
    this.database.prepare('DELETE FROM runtime_pending_messages WHERE session_id = ?').run(sessionId);
  }

  /** One database snapshot prevents a concurrent inbox drain from duplicating or hiding messages. */
  readConversationMessages(sessionId: string): Message[] {
    return this.transaction(() => {
      const lane = this.database.prepare('SELECT leaf_id FROM lanes WHERE session_id = ? AND name = ?').get(sessionId, 'main') as Row | undefined;
      if (!lane) return [];
      let cursor = nullableText(lane.leaf_id, 'lane leaf');
      const messages: Message[] = [];
      const visited = new Set<string>();
      while (cursor) {
        if (visited.has(cursor)) throw new Error('runtime_path_cycle');
        visited.add(cursor);
        const row = this.entryRow(cursor);
        if (!row || row.session_id !== sessionId) throw new Error(`runtime_parent_not_found: ${cursor}`);
        const entry = entryFromRow(row);
        if (entry.type === 'message') messages.push(entry.message);
        cursor = entry.parentId;
      }
      messages.reverse();
      const pending = this.database.prepare('SELECT message_json FROM runtime_pending_messages WHERE session_id = ? ORDER BY rowid').all(sessionId) as Row[];
      return [...messages, ...pending.map((row) => json<Message>(row.message_json, 'pending message'))];
    });
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
    validateOperationExecution(meta, initialState);
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
    if (Buffer.byteLength(String(row.meta_json)) > MAX_OPERATION_META_BYTES) throw new Error('runtime_execution_snapshot_too_large');
    const meta = json<OperationMeta>(row.meta_json, 'operation meta');
    const state = json<OperationState>(row.state_json, 'operation state');
    assertOperationState(state);
    if (meta.id !== operationId || state.operationId !== operationId || meta.sessionId !== row.session_id || meta.lane !== row.lane || state.lane !== row.lane) {
      throw new Error('runtime_operation_identity_conflict');
    }
    validateOperationExecution(meta, state);
    return clone({ meta, state });
  }

  async saveOperationState(state: OperationState, options?: { expectedState: OperationState; expectedLaneOperationId: string }): Promise<void> {
    assertOperationState(state);
    this.transaction(() => {
      const operation = this.operationRow(state.operationId);
      if (!operation) throw new Error(`runtime_operation_not_found: ${state.operationId}`);
      if (operation.lane !== state.lane) throw new Error('runtime_operation_lane_mismatch');
      const previous = json<OperationState>(operation.state_json, 'operation state');
      const owner = this.laneRow(String(operation.session_id), String(operation.lane))?.current_operation_id;
      if (options && (!isDeepStrictEqual(previous, options.expectedState) || owner !== options.expectedLaneOperationId)) {
        throw new Error('runtime_operation_conflict');
      }
      if (isTerminalState(previous) && !isDeepStrictEqual(previous, state)) {
        throw new Error('runtime_operation_terminal');
      }
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

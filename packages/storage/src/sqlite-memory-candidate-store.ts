import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MemoryCandidateSchema,
  type MemoryCandidate,
  type MemoryCandidateState
} from '@desktop-agent/contracts';

type Row = Record<string, unknown>;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`memory_candidate_store_corrupted: ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`memory_candidate_store_corrupted: ${label}`);
  }
  return value;
}

function fromRow(row: Row): MemoryCandidate {
  let payload: unknown;
  try { payload = JSON.parse(text(row.payload_json, 'payload')); }
  catch { throw new Error('memory_candidate_store_corrupted: payload'); }
  return MemoryCandidateSchema.parse({
    ...(payload as Record<string, unknown>),
    state: text(row.state, 'state'),
    createdAt: integer(row.created_at, 'created_at'),
    expiresAt: integer(row.expires_at, 'expires_at'),
    ...(typeof row.resolved_at === 'number' ? { resolvedAt: integer(row.resolved_at, 'resolved_at') } : {})
  });
}

/** Candidate projection only. Markdown remains the sole authoritative Memory store. */
export class SqliteMemoryCandidateStore {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_candidate_jobs (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed')),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'accepted', 'rejected', 'expired', 'superseded')),
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE(operation_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS memory_candidates_state_created
        ON memory_candidates(state, created_at);
      CREATE INDEX IF NOT EXISTS memory_candidates_fingerprint_state
        ON memory_candidates(fingerprint, state, resolved_at);
    `);
  }

  close(): void { this.database.close(); }

  async claimExtraction(operationId: string, sessionId: string, now = Date.now()): Promise<boolean> {
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO memory_candidate_jobs(operation_id, session_id, state, started_at)
      VALUES (?, ?, 'running', ?)
    `).run(operationId, sessionId, now);
    return result.changes === 1;
  }

  async completeExtraction(operationId: string): Promise<void> {
    this.database.prepare(`
      UPDATE memory_candidate_jobs SET state = 'completed', completed_at = ?, error_code = NULL
      WHERE operation_id = ?
    `).run(Date.now(), operationId);
  }

  async failExtraction(operationId: string, errorCode: string): Promise<void> {
    this.database.prepare(`
      UPDATE memory_candidate_jobs SET state = 'failed', completed_at = ?, error_code = ?
      WHERE operation_id = ?
    `).run(Date.now(), errorCode, operationId);
  }

  async insert(candidate: MemoryCandidate): Promise<'created' | 'duplicate'> {
    const parsed = MemoryCandidateSchema.parse(candidate);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO memory_candidates(
        id, session_id, operation_id, scope_id, payload_json, state,
        fingerprint, created_at, expires_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id, parsed.sessionId, parsed.operationId, parsed.scopeId, JSON.stringify(parsed), parsed.state,
      parsed.fingerprint, parsed.createdAt, parsed.expiresAt, parsed.resolvedAt ?? null
    );
    return result.changes === 1 ? 'created' : 'duplicate';
  }

  async get(id: string): Promise<MemoryCandidate | undefined> {
    const row = this.database.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  async list(state: MemoryCandidateState = 'pending', limit = 100): Promise<MemoryCandidate[]> {
    await this.expire();
    const rows = this.database.prepare(`
      SELECT * FROM memory_candidates WHERE state = ? ORDER BY created_at DESC, id LIMIT ?
    `).all(state, limit) as Row[];
    return rows.map(fromRow);
  }

  async resolve(id: string, state: Exclude<MemoryCandidateState, 'pending'>, now = Date.now()): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE memory_candidates SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'
    `).run(state, now, id);
    return result.changes === 1;
  }

  async wasRejectedSince(fingerprint: string, since: number): Promise<boolean> {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM memory_candidates
      WHERE fingerprint = ? AND state = 'rejected' AND resolved_at >= ? LIMIT 1
    `).get(fingerprint, since) as Row | undefined;
    return Boolean(row);
  }

  async hasPendingFingerprint(fingerprint: string): Promise<boolean> {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM memory_candidates WHERE fingerprint = ? AND state = 'pending' LIMIT 1
    `).get(fingerprint) as Row | undefined;
    return Boolean(row);
  }

  async expire(now = Date.now()): Promise<number> {
    const result = this.database.prepare(`
      UPDATE memory_candidates SET state = 'expired', resolved_at = ?
      WHERE state = 'pending' AND expires_at <= ?
    `).run(now, now);
    return Number(result.changes);
  }
}

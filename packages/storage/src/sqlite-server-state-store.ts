import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  ApprovalStore,
  CreateApprovalRecord,
  CreateRunRecord,
  CreateSessionMetadataRecord,
  EnsureSessionMetadataRecord,
  PersistedApprovalRecord,
  PersistedRunRecord,
  PersistedRunStatus,
  PersistedApprovalPreview,
  RunRequestMeta,
  RunStore,
  ServerStateStore,
  SessionMetadataPatch,
  SessionMetadataRecord,
  SessionMetadataStore
} from '@desktop-agent/app-service';
import type { RunResult } from '@desktop-agent/agent-runtime';
import type { ApprovalDecision, ProtocolError } from '@desktop-agent/server-protocol';
import { SERVER_STATE_SCHEMA_SQL, SERVER_STATE_SCHEMA_VERSION } from './server-state-schema.js';

type Row = Record<string, unknown>;
type Clock = { now(): number };

const systemClock: Clock = { now: Date.now };
const terminal = new Set<PersistedRunStatus>(['completed', 'failed', 'cancelled', 'interrupted']);

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`server_state_corrupted: ${label}`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`server_state_corrupted: ${label}`);
  return value;
}

function nullableString(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  return stringValue(value, label);
}

function nullableNumber(value: unknown, label: string): number | undefined {
  if (value === null) return undefined;
  return numberValue(value, label);
}

function parsed<T>(value: unknown, label: string): T | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`server_state_corrupted: ${label}`);
  try { return JSON.parse(value) as T; }
  catch { throw new Error(`server_state_corrupted: ${label}`); }
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function sessionFromRow(row: Row): SessionMetadataRecord {
  const labels = parsed<unknown>(row.labels_json, 'session labels');
  if (!Array.isArray(labels) || !labels.every((item) => typeof item === 'string')) {
    throw new Error('server_state_corrupted: session labels');
  }
  const state = stringValue(row.state, 'session state');
  if (state !== 'creating' && state !== 'active') throw new Error('server_state_corrupted: session state');
  return {
    sessionId: stringValue(row.session_id, 'session id'),
    state,
    labels,
    favorite: numberValue(row.favorite, 'session favorite') === 1,
    revision: numberValue(row.revision, 'session revision'),
    createdAt: iso(numberValue(row.created_at, 'session created_at')),
    updatedAt: iso(numberValue(row.updated_at, 'session updated_at')),
    ...(nullableString(row.title, 'session title') !== undefined ? { title: stringValue(row.title, 'session title') } : {}),
    ...(nullableString(row.default_provider_id, 'session provider') !== undefined
      ? { defaultProviderId: stringValue(row.default_provider_id, 'session provider') } : {}),
    ...(nullableString(row.default_model, 'session model') !== undefined
      ? { defaultModel: stringValue(row.default_model, 'session model') } : {}),
    ...(nullableString(row.created_by, 'session creator') !== undefined
      ? { createdBy: stringValue(row.created_by, 'session creator') } : {})
  };
}

function runFromRow(row: Row): PersistedRunRecord {
  const status = stringValue(row.status, 'run status') as PersistedRunStatus;
  const requestMeta = parsed<RunRequestMeta>(row.request_meta_json, 'run request meta');
  const result = parsed<RunResult>(row.result_json, 'run result');
  const error = parsed<ProtocolError>(row.error_json, 'run error');
  return {
    id: stringValue(row.id, 'run id'),
    sessionId: stringValue(row.session_id, 'run session'),
    laneId: stringValue(row.lane_id, 'run lane'),
    status,
    providerId: stringValue(row.provider_id, 'run provider'),
    model: stringValue(row.model, 'run model'),
    inputHash: stringValue(row.input_hash, 'run input hash'),
    createdAt: iso(numberValue(row.created_at, 'run created_at')),
    updatedAt: iso(numberValue(row.updated_at, 'run updated_at')),
    version: numberValue(row.version, 'run version'),
    ...(requestMeta !== undefined ? { requestMeta } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(nullableNumber(row.started_at, 'run started_at') !== undefined
      ? { startedAt: iso(numberValue(row.started_at, 'run started_at')) } : {}),
    ...(nullableNumber(row.completed_at, 'run completed_at') !== undefined
      ? { completedAt: iso(numberValue(row.completed_at, 'run completed_at')) } : {})
  };
}

function approvalFromRow(row: Row): PersistedApprovalRecord {
  const decision = nullableString(row.decision, 'approval decision');
  const preview = parsed<PersistedApprovalPreview>(row.preview_json, 'approval preview');
  return {
    id: stringValue(row.id, 'approval id'),
    sessionId: stringValue(row.session_id, 'approval session'),
    laneId: stringValue(row.lane_id, 'approval lane'),
    runId: stringValue(row.run_id, 'approval run'),
    status: stringValue(row.status, 'approval status') as PersistedApprovalRecord['status'],
    toolCallId: stringValue(row.tool_call_id, 'approval tool call'),
    toolName: stringValue(row.tool_name, 'approval tool name'),
    reason: stringValue(row.reason, 'approval reason'),
    requestHash: stringValue(row.request_hash, 'approval request hash'),
    createdAt: iso(numberValue(row.created_at, 'approval created_at')),
    version: numberValue(row.version, 'approval version'),
    ...(preview !== undefined ? { preview } : {}),
    ...(decision !== undefined ? { decision: decision as ApprovalDecision } : {}),
    ...(nullableString(row.resolved_by, 'approval resolver') !== undefined
      ? { resolvedBy: stringValue(row.resolved_by, 'approval resolver') } : {}),
    ...(nullableNumber(row.resolved_at, 'approval resolved_at') !== undefined
      ? { resolvedAt: iso(numberValue(row.resolved_at, 'approval resolved_at')) } : {}),
    ...(nullableString(row.interrupted_reason, 'approval interruption') !== undefined
      ? { interruptedReason: stringValue(row.interrupted_reason, 'approval interruption') } : {})
  };
}

export class SqliteServerStateStore implements ServerStateStore {
  private readonly database: DatabaseSync;
  readonly sessions: SessionMetadataStore;
  readonly runs: RunStore;
  readonly approvals: ApprovalStore;

  constructor(readonly filename: string, private readonly clock: Clock = systemClock) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const versionRow = this.database.prepare('PRAGMA user_version').get() as Row | undefined;
    const version = versionRow ? Number(Object.values(versionRow)[0]) : 0;
    if (version > SERVER_STATE_SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`server_state_version_unsupported: ${version}`);
    }
    this.database.exec(SERVER_STATE_SCHEMA_SQL);
    this.database.exec(`PRAGMA user_version = ${SERVER_STATE_SCHEMA_VERSION};`);

    this.sessions = {
      createCreating: async (input) => this.createCreating(input),
      ensureActive: async (input) => this.ensureActive(input),
      activate: async (id) => this.activate(id),
      get: async (id) => this.session(id),
      list: async () => this.sessionRows().map(sessionFromRow),
      patch: async (id, patch) => this.patchSession(id, patch),
      deleteCreating: async (id) => { this.database.prepare("DELETE FROM server_sessions WHERE session_id = ? AND state = 'creating'").run(id); }
    };
    this.runs = {
      createAccepted: async (input) => this.createAccepted(input),
      get: async (id) => this.run(id),
      list: async (sessionId, options) => {
        const sql = options?.activeOnly
          ? "SELECT * FROM server_runs WHERE session_id = ? AND status IN ('accepted','starting','running') ORDER BY created_at, id"
          : 'SELECT * FROM server_runs WHERE session_id = ? ORDER BY created_at, id';
        return (this.database.prepare(sql).all(sessionId) as Row[]).map(runFromRow);
      },
      listRecoverable: async () => (this.database.prepare(
        "SELECT * FROM server_runs WHERE status IN ('accepted','starting','running') ORDER BY updated_at, id"
      ).all() as Row[]).map(runFromRow),
      markStarting: async (id, version) => this.transitionRun(id, ['accepted'], 'starting', {}, version),
      markRunning: async (id, version) => this.transitionRun(id, ['starting'], 'running', {}, version),
      markCompleted: async (id, result, version) => this.transitionRun(id, ['starting', 'running'], 'completed', { result }, version),
      markFailed: async (id, error, result, version) => this.transitionRun(
        id, ['accepted', 'starting', 'running'], 'failed', { error, ...(result ? { result } : {}) }, version
      ),
      markCancelled: async (id, result, version) => this.transitionRun(id, ['starting', 'running'], 'cancelled', { result }, version),
      markInterrupted: async (id, error, version) => this.transitionRun(
        id, ['accepted', 'starting', 'running'], 'interrupted', { error }, version
      )
    };
    this.approvals = {
      createPending: async (input) => this.createPending(input),
      get: async (id) => this.approval(id),
      listPending: async (sessionId) => {
        const rows = sessionId
          ? this.database.prepare("SELECT * FROM server_approvals WHERE status = 'pending' AND session_id = ? ORDER BY created_at, id").all(sessionId)
          : this.database.prepare("SELECT * FROM server_approvals WHERE status = 'pending' ORDER BY created_at, id").all();
        return (rows as Row[]).map(approvalFromRow);
      },
      listRecoverable: async () => (this.database.prepare(
        "SELECT * FROM server_approvals WHERE status = 'pending' ORDER BY updated_at, id"
      ).all() as Row[]).map(approvalFromRow),
      resolve: async (id, decision, principalId, version) => this.resolveApproval(id, decision, principalId, version),
      interrupt: async (id, reason, version) => this.interruptApproval(id, reason, version)
    };
  }

  async close(): Promise<void> {
    this.database.close();
  }

  private createCreating(input: CreateSessionMetadataRecord): SessionMetadataRecord {
    const now = this.clock.now();
    this.database.prepare(`
      INSERT INTO server_sessions(
        session_id, state, title, labels_json, favorite, default_provider_id,
        default_model, created_by, revision, created_at, updated_at
      ) VALUES (?, 'creating', ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.sessionId, input.title ?? null, JSON.stringify(input.labels ?? []), input.favorite ? 1 : 0,
      input.defaultProviderId ?? null, input.defaultModel ?? null, input.createdBy ?? null, now, now
    );
    return this.requireSession(input.sessionId);
  }

  private ensureActive(input: EnsureSessionMetadataRecord): SessionMetadataRecord {
    const existing = this.session(input.sessionId);
    if (existing) return existing;
    const now = this.clock.now();
    this.database.prepare(`
      INSERT OR IGNORE INTO server_sessions(
        session_id, state, title, labels_json, favorite, default_provider_id,
        default_model, created_by, revision, created_at, updated_at
      ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.sessionId, input.title ?? null, JSON.stringify(input.labels ?? []), input.favorite ? 1 : 0,
      input.defaultProviderId ?? null, input.defaultModel ?? null, input.createdBy ?? null, now, now
    );
    return this.requireSession(input.sessionId);
  }

  private activate(id: string): SessionMetadataRecord {
    const record = this.requireSession(id);
    if (record.state === 'active') return record;
    this.database.prepare(`
      UPDATE server_sessions SET state = 'active', revision = revision + 1, updated_at = ?
      WHERE session_id = ? AND state = 'creating'
    `).run(this.clock.now(), id);
    return this.requireSession(id);
  }

  private patchSession(id: string, patch: SessionMetadataPatch): SessionMetadataRecord {
    return this.transaction(() => {
      const current = this.requireSession(id);
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
        throw new Error(`revision_conflict: expected ${patch.expectedRevision}, actual ${current.revision}`);
      }
      const assignments = ['revision = revision + 1', 'updated_at = ?'];
      const values: SQLInputValue[] = [this.clock.now()];
      if (patch.title !== undefined) { assignments.push('title = ?'); values.push(patch.title); }
      if (patch.labels !== undefined) { assignments.push('labels_json = ?'); values.push(JSON.stringify(patch.labels)); }
      if (patch.favorite !== undefined) { assignments.push('favorite = ?'); values.push(patch.favorite ? 1 : 0); }
      if (patch.defaultProviderId !== undefined) {
        assignments.push('default_provider_id = ?'); values.push(patch.defaultProviderId);
      }
      if (patch.defaultModel !== undefined) { assignments.push('default_model = ?'); values.push(patch.defaultModel); }
      values.push(id);
      const result = this.database.prepare(
        `UPDATE server_sessions SET ${assignments.join(', ')} WHERE session_id = ?`
      ).run(...values);
      if (result.changes !== 1) throw new Error(`server_session_metadata_missing: ${id}`);
      return this.requireSession(id);
    });
  }

  private createAccepted(input: CreateRunRecord): PersistedRunRecord {
    return this.transaction(() => {
      const now = this.clock.now();
      this.database.prepare(`
        INSERT INTO server_runs(
          id, session_id, lane_id, status, provider_id, model, input_hash,
          request_meta_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, 1)
      `).run(
        input.id, input.sessionId, input.laneId, input.providerId, input.model, input.inputHash,
        input.requestMeta ? JSON.stringify(input.requestMeta) : null, now, now
      );
      this.bump(input.sessionId, now);
      return this.requireRun(input.id);
    });
  }

  private transitionRun(
    id: string,
    allowed: PersistedRunStatus[],
    target: PersistedRunStatus,
    patch: { result?: RunResult; error?: ProtocolError },
    expectedVersion?: number
  ): PersistedRunRecord {
    return this.transaction(() => {
      const current = this.requireRun(id);
      if (current.status === target) return current;
      if (terminal.has(current.status) || !allowed.includes(current.status)) {
        throw new Error(`run_transition_conflict: ${current.status} -> ${target}`);
      }
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new Error(`run_transition_conflict: expected version ${expectedVersion}, actual ${current.version}`);
      }
      const now = this.clock.now();
      const expectedStatuses = allowed.map(() => '?').join(',');
      const result = this.database.prepare(`
        UPDATE server_runs SET
          status = ?,
          result_json = COALESCE(?, result_json),
          error_json = COALESCE(?, error_json),
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('completed','failed','cancelled','interrupted') THEN ? ELSE completed_at END,
          updated_at = ?,
          version = version + 1
        WHERE id = ? AND status IN (${expectedStatuses}) AND version = ?
      `).run(
        target, patch.result ? JSON.stringify(patch.result) : null, patch.error ? JSON.stringify(patch.error) : null,
        target, now, target, now, now, id, ...allowed, current.version
      );
      if (result.changes !== 1) throw new Error(`run_transition_conflict: ${id}`);
      this.bump(current.sessionId, now);
      return this.requireRun(id);
    });
  }

  private createPending(input: CreateApprovalRecord): PersistedApprovalRecord {
    return this.transaction(() => {
      const existing = this.approval(input.id);
      if (existing) {
        if (existing.requestHash === input.requestHash) return existing;
        throw new Error(`approval_conflict: ${input.id}`);
      }
      const now = this.clock.now();
      this.database.prepare(`
        INSERT INTO server_approvals(
          id, session_id, run_id, lane_id, status, tool_call_id, tool_name, reason,
          request_hash, preview_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        input.id, input.sessionId, input.runId, input.laneId, input.toolCallId, input.toolName,
        input.reason, input.requestHash, input.preview ? JSON.stringify(input.preview) : null, now, now
      );
      this.bump(input.sessionId, now);
      return this.requireApproval(input.id);
    });
  }

  private resolveApproval(
    id: string,
    decision: ApprovalDecision,
    principalId?: string,
    expectedVersion?: number
  ): PersistedApprovalRecord {
    return this.transaction(() => {
      const current = this.requireApproval(id);
      const target = decision === 'allow' ? 'allowed' : 'denied';
      if (current.status === target && current.decision === decision) return current;
      if (current.status !== 'pending') throw new Error(`approval_already_resolved: ${id}`);
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new Error(`approval_transition_conflict: ${id}`);
      }
      const now = this.clock.now();
      const result = this.database.prepare(`
        UPDATE server_approvals SET status = ?, decision = ?, resolved_by = ?, resolved_at = ?,
          updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'pending' AND version = ?
      `).run(target, decision, principalId ?? null, now, now, id, current.version);
      if (result.changes !== 1) throw new Error(`approval_transition_conflict: ${id}`);
      this.bump(current.sessionId, now);
      return this.requireApproval(id);
    });
  }

  private interruptApproval(id: string, reason: string, expectedVersion?: number): PersistedApprovalRecord {
    return this.transaction(() => {
      const current = this.requireApproval(id);
      if (current.status === 'interrupted' || current.status !== 'pending') return current;
      if (expectedVersion !== undefined && expectedVersion !== current.version) {
        throw new Error(`approval_transition_conflict: ${id}`);
      }
      const now = this.clock.now();
      const result = this.database.prepare(`
        UPDATE server_approvals SET status = 'interrupted', interrupted_reason = ?, resolved_at = ?,
          updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'pending' AND version = ?
      `).run(reason, now, now, id, current.version);
      if (result.changes !== 1) throw new Error(`approval_transition_conflict: ${id}`);
      this.bump(current.sessionId, now);
      return this.requireApproval(id);
    });
  }

  private bump(sessionId: string, now: number): void {
    const result = this.database.prepare(`
      UPDATE server_sessions SET revision = revision + 1, updated_at = ? WHERE session_id = ?
    `).run(now, sessionId);
    if (result.changes !== 1) throw new Error(`server_session_metadata_missing: ${sessionId}`);
  }

  private sessionRows(): Row[] {
    return this.database.prepare('SELECT * FROM server_sessions ORDER BY updated_at DESC, session_id').all() as Row[];
  }

  private session(id: string): SessionMetadataRecord | undefined {
    const row = this.database.prepare('SELECT * FROM server_sessions WHERE session_id = ?').get(id) as Row | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  private run(id: string): PersistedRunRecord | undefined {
    const row = this.database.prepare('SELECT * FROM server_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  private approval(id: string): PersistedApprovalRecord | undefined {
    const row = this.database.prepare('SELECT * FROM server_approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? approvalFromRow(row) : undefined;
  }

  private requireSession(id: string): SessionMetadataRecord {
    const record = this.session(id);
    if (!record) throw new Error(`server_session_metadata_missing: ${id}`);
    return record;
  }

  private requireRun(id: string): PersistedRunRecord {
    const record = this.run(id);
    if (!record) throw new Error(`run_not_found: ${id}`);
    return record;
  }

  private requireApproval(id: string): PersistedApprovalRecord {
    const record = this.approval(id);
    if (!record) throw new Error(`approval_not_found: ${id}`);
    return record;
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

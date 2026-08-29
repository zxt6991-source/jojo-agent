import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  JsonValueSchema,
  type PermissionDecisionAuditItem,
  type PermissionPolicyProfileSnapshot
} from '@desktop-agent/contracts';
import {
  PermissionPolicyDocumentSchema,
  type GovernanceContext,
  type PermissionAuditRecord,
  type PermissionAuditSink,
  type PermissionMode,
  type PermissionPolicyDocument,
  type PermissionPolicyStore,
  type ResolvedPermissionPolicy
} from '@desktop-agent/permission-governance';

type Row = Record<string, unknown>;

export type PermissionPolicyProfileInput = {
  scope: 'global' | 'workspace';
  scopeKey?: string;
  mode: PermissionMode;
  document: PermissionPolicyDocument;
};

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`permission_governance_sqlite_corrupted: ${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`permission_governance_sqlite_corrupted: ${field}`);
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value, field);
}

function workspaceKey(workingDirectory: string): string {
  return createHash('sha256').update(path.resolve(workingDirectory)).digest('hex');
}

function parseDocument(row: Row): PermissionPolicyDocument {
  let value: unknown;
  try { value = JSON.parse(text(row.document_json, 'document_json')); }
  catch { throw new Error('permission_governance_sqlite_corrupted: document_json'); }
  return PermissionPolicyDocumentSchema.parse(value) as PermissionPolicyDocument;
}

function parseMetadata(value: unknown): PermissionDecisionAuditItem['metadata'] {
  if (value === null || value === undefined) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text(value, 'metadata_json')); }
  catch { throw new Error('permission_governance_sqlite_corrupted: metadata_json'); }
  return JsonValueSchema.parse(parsed);
}

export class SqlitePermissionGovernanceStore implements PermissionPolicyStore, PermissionAuditSink {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS permission_policy_profiles (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'workspace')),
        scope_key TEXT,
        mode TEXT NOT NULL CHECK(mode IN ('ask', 'auto', 'yolo')),
        document_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS permission_policy_scope
        ON permission_policy_profiles(scope, COALESCE(scope_key, ''));

      CREATE TABLE IF NOT EXISTS permission_decision_audit (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lane_id TEXT,
        run_id TEXT,
        actor_kind TEXT,
        actor_id TEXT,
        trigger_kind TEXT,
        tool_name TEXT NOT NULL,
        tool_source TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('allow', 'ask', 'deny')),
        locked INTEGER NOT NULL CHECK(locked IN (0, 1)),
        source TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        policy_rule_id TEXT,
        request_fingerprint TEXT NOT NULL,
        risk TEXT NOT NULL,
        metadata_json TEXT
      );
      CREATE INDEX IF NOT EXISTS permission_audit_session_created
        ON permission_decision_audit(session_id, created_at DESC);
    `);
  }

  close(): void { this.database.close(); }

  resolve(context: GovernanceContext): ResolvedPermissionPolicy {
    const global = this.database.prepare("SELECT * FROM permission_policy_profiles WHERE scope = 'global' ORDER BY revision DESC LIMIT 1").get() as Row | undefined;
    const workspace = context.workingDirectory
      ? this.database.prepare("SELECT * FROM permission_policy_profiles WHERE scope = 'workspace' AND scope_key = ? ORDER BY revision DESC LIMIT 1")
        .get(workspaceKey(context.workingDirectory)) as Row | undefined
      : undefined;
    return {
      mode: (workspace ? text(workspace.mode, 'mode') : global ? text(global.mode, 'mode') : 'ask') as PermissionMode,
      globalRules: global ? parseDocument(global).rules : [],
      workspaceRules: workspace ? parseDocument(workspace).rules : [],
      ...((workspace ?? global) ? { revision: integer((workspace ?? global)!.revision, 'revision') } : {})
    };
  }

  getProfile(scope: 'global' | 'workspace', scopeKey?: string): PermissionPolicyProfileSnapshot | undefined {
    if (scope === 'workspace' && !scopeKey) throw new Error('workspace policy requires a scopeKey');
    const row = scope === 'global'
      ? this.database.prepare("SELECT * FROM permission_policy_profiles WHERE scope = 'global' ORDER BY revision DESC LIMIT 1").get() as Row | undefined
      : this.database.prepare("SELECT * FROM permission_policy_profiles WHERE scope = 'workspace' AND scope_key = ? ORDER BY revision DESC LIMIT 1")
        .get(workspaceKey(scopeKey!)) as Row | undefined;
    if (!row) {
      return scope === 'global'
        ? { scope: 'global', mode: 'ask', document: { version: 1, rules: [] }, revision: 0 }
        : undefined;
    }
    return {
      scope,
      mode: text(row.mode, 'mode') as PermissionMode,
      document: parseDocument(row),
      revision: integer(row.revision, 'revision'),
      updatedAt: text(row.updated_at, 'updated_at')
    };
  }

  listAudit(input: { sessionId?: string; limit?: number } = {}): PermissionDecisionAuditItem[] {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = input.sessionId
      ? this.database.prepare('SELECT * FROM permission_decision_audit WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(input.sessionId, limit) as Row[]
      : this.database.prepare('SELECT * FROM permission_decision_audit ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as Row[];
    return rows.map((row) => {
      const laneId = optionalText(row.lane_id, 'lane_id');
      const runId = optionalText(row.run_id, 'run_id');
      const actorId = optionalText(row.actor_id, 'actor_id');
      const policyRuleId = optionalText(row.policy_rule_id, 'policy_rule_id');
      const metadata = parseMetadata(row.metadata_json);
      return {
        id: text(row.id, 'id'),
        createdAt: text(row.created_at, 'created_at'),
        sessionId: text(row.session_id, 'session_id'),
        ...(laneId ? { laneId } : {}),
        ...(runId ? { runId } : {}),
        actorKind: text(row.actor_kind, 'actor_kind') as PermissionDecisionAuditItem['actorKind'],
        ...(actorId ? { actorId } : {}),
        triggerKind: text(row.trigger_kind, 'trigger_kind') as PermissionDecisionAuditItem['triggerKind'],
        toolName: text(row.tool_name, 'tool_name'),
        toolSource: text(row.tool_source, 'tool_source') as PermissionDecisionAuditItem['toolSource'],
        effect: text(row.effect, 'effect') as PermissionDecisionAuditItem['effect'],
        locked: integer(row.locked, 'locked') === 1,
        source: text(row.source, 'source') as PermissionDecisionAuditItem['source'],
        reasonCode: text(row.reason_code, 'reason_code'),
        ...(policyRuleId ? { policyRuleId } : {}),
        requestFingerprint: text(row.request_fingerprint, 'request_fingerprint'),
        risk: text(row.risk, 'risk') as PermissionDecisionAuditItem['risk'],
        ...(metadata !== undefined ? { metadata } : {})
      };
    });
  }

  saveProfile(input: PermissionPolicyProfileInput): number {
    const document = PermissionPolicyDocumentSchema.parse(input.document);
    const scopeKey = input.scope === 'workspace'
      ? workspaceKey(input.scopeKey ?? '')
      : null;
    if (input.scope === 'workspace' && !input.scopeKey) throw new Error('workspace policy requires a scopeKey');
    const id = input.scope === 'global' ? 'global' : `workspace:${scopeKey}`;
    const existing = this.database.prepare('SELECT revision, created_at FROM permission_policy_profiles WHERE id = ?').get(id) as Row | undefined;
    if (existing) {
      const current = this.database.prepare('SELECT mode, document_json FROM permission_policy_profiles WHERE id = ?').get(id) as Row;
      if (text(current.mode, 'mode') === input.mode
        && text(current.document_json, 'document_json') === JSON.stringify(document)) {
        return integer(existing.revision, 'revision');
      }
    }
    const revision = existing ? integer(existing.revision, 'revision') + 1 : 1;
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO permission_policy_profiles(id, scope, scope_key, mode, document_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mode = excluded.mode,
        document_json = excluded.document_json,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `).run(id, input.scope, scopeKey, input.mode, JSON.stringify(document), revision, existing ? text(existing.created_at, 'created_at') : now, now);
    return revision;
  }

  setGlobalMode(mode: PermissionMode): number {
    const existing = this.database.prepare("SELECT * FROM permission_policy_profiles WHERE scope = 'global' ORDER BY revision DESC LIMIT 1").get() as Row | undefined;
    return this.saveProfile({
      scope: 'global',
      mode,
      document: existing ? parseDocument(existing) : { version: 1, rules: [] }
    });
  }

  record({ request, decision, createdAt }: PermissionAuditRecord): void {
    const metadata = {
      capabilities: request.facts.capabilities,
      operations: request.facts.operations,
      resourceScope: request.facts.resourceScope,
      ...(request.facts.terminal ? { terminal: request.facts.terminal } : {}),
      ...(request.facts.mcp ? { mcp: request.facts.mcp } : {}),
      ...(request.facts.browser ? { browser: request.facts.browser } : {})
    };
    this.database.prepare(`
      INSERT INTO permission_decision_audit(
        id, created_at, session_id, lane_id, run_id, actor_kind, actor_id, trigger_kind,
        tool_name, tool_source, effect, locked, source, reason_code, policy_rule_id,
        request_fingerprint, risk, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id, createdAt, request.context.sessionId, request.context.laneId, request.context.runId,
      request.context.actor.kind, request.context.actor.id ?? null, request.context.trigger.kind,
      request.call.name, request.facts.source, decision.effect, decision.locked ? 1 : 0,
      decision.source, decision.reasonCode, decision.policyRuleId ?? null,
      request.fingerprint, request.facts.risk, JSON.stringify(metadata)
    );
  }
}

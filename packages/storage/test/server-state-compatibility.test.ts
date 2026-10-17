import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isKnownCompatibleServerStateVersion } from '../src/server-state-compatibility.js';
import { SERVER_STATE_SCHEMA_SQL } from '../src/server-state-schema.js';
import { SqliteServerStateStore } from '../src/sqlite-server-state-store.js';

const roleColumn = "role_id TEXT CHECK(role_id IS NULL OR role_id IN ('personal', 'research', 'document', 'coding'))";
const contextColumn = 'personal_context_json TEXT CHECK(personal_context_json IS NULL OR json_valid(personal_context_json))';
const context = JSON.stringify({ version: 1, spaceId: 'space_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', revision: 4 });
const createV8 = SERVER_STATE_SCHEMA_SQL.replace('    created_by TEXT,', `    ${roleColumn},\n    ${contextColumn},\n    created_by TEXT,`);

async function databaseFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), 'jojo-server-compatibility-')), 'application.sqlite');
}

function initializeV8(database: DatabaseSync, layout: 'create' | 'alter'): void {
  database.exec(layout === 'create' ? createV8 : SERVER_STATE_SCHEMA_SQL);
  if (layout === 'alter') {
    database.exec(`ALTER TABLE server_sessions ADD COLUMN ${roleColumn};
      ALTER TABLE server_sessions ADD COLUMN ${contextColumn};`);
  }
  database.exec('PRAGMA user_version = 8');
}

function schemaSnapshot(database: DatabaseSync): unknown {
  return database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
}

describe('known additive server-state schema compatibility', () => {
  it.each(['create', 'alter'] as const)('preserves v8 %s metadata and durable records across new writes and reopen', async layout => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initializeV8(database, layout);
    database.prepare(`INSERT INTO server_sessions(session_id,state,title,role_id,personal_context_json,created_at,updated_at)
      VALUES ('legacy','active','kept','coding',?,1000,1000)`).run(context);
    database.prepare("INSERT INTO application_session_projects(session_id,metadata_json) VALUES ('legacy',?)")
      .run(JSON.stringify({ workingDirectory: path.dirname(filename), projectBound: false }));
    const result = { runId: 'legacy-run', sessionId: 'legacy', laneId: 'main', status: 'completed', finalText: 'kept result', messages: [] };
    database.prepare(`INSERT INTO server_runs(id,session_id,lane_id,status,provider_id,model,input_hash,result_json,created_at,updated_at)
      VALUES ('legacy-run','legacy','main','completed','p','m','kept-hash',?,1000,1000)`).run(JSON.stringify(result));
    database.exec(`INSERT INTO server_approvals(id,session_id,run_id,lane_id,status,tool_call_id,tool_name,reason,request_hash,
      decision,resolved_by,created_at,resolved_at,updated_at)
      VALUES ('legacy-approval','legacy','legacy-run','main','allowed','c','write','ask','kept-request','allow','owner',1000,2000,2000);
      INSERT INTO server_idempotency(principal_id,route,idempotency_key,request_hash,status,result_json,created_at,updated_at,expires_at)
      VALUES ('owner','run.start:legacy','kept-key','kept-request','completed','{"kept":true}',1000,1000,999999);`);
    const schema = schemaSnapshot(database);
    expect(isKnownCompatibleServerStateVersion(database, 8)).toBe(true);
    database.close();

    const store = new SqliteServerStateStore(filename, { now: () => 3_000 });
    try {
      expect(await store.sessions.get('legacy')).toMatchObject({ title: 'kept', state: 'active' });
      expect(store.getDesktopSessionMetadata('legacy')).toMatchObject({ title: 'kept', projectBound: false });
      expect(await store.runs.get('legacy-run')).toMatchObject({ inputHash: 'kept-hash', result });
      expect(await store.approvals.get('legacy-approval')).toMatchObject({ decision: 'allow', resolvedBy: 'owner' });
      await expect(store.idempotency.claim({ principalId: 'owner', route: 'run.start:legacy', key: 'kept-key',
        requestHash: 'kept-request', expiresAt: new Date(999999).toISOString() }))
        .resolves.toEqual({ status: 'completed', result: { kept: true } });
      await store.sessions.patch('legacy', { title: 'updated', favorite: true });
      await store.sessions.ensureActive({ sessionId: 'new', title: 'new session' });
      const accepted = await store.runs.createAccepted({ id: 'new-run', sessionId: 'new', laneId: 'main',
        providerId: 'p', model: 'm', inputHash: 'new-hash' });
      const starting = await store.runs.markStarting('new-run', accepted.version);
      const running = await store.runs.markRunning('new-run', starting.version);
      await store.runs.markCompleted('new-run', { runId: 'new-run', sessionId: 'new', laneId: 'main',
        status: 'completed', finalText: 'new result', messages: [] }, running.version);
      await store.approvals.createPending({ id: 'new-approval', sessionId: 'new', scope: 'session',
        toolCallId: 'new-call', toolName: 'hook', reason: 'trust', requestHash: 'new-request' });
      await store.approvals.resolve('new-approval', 'deny', 'owner');
      const claim = { principalId: 'owner', route: 'session.create', key: 'new-key', requestHash: 'new-request',
        expiresAt: new Date(999999).toISOString() };
      await store.idempotency.claim(claim);
      await store.idempotency.complete({ ...claim, result: { sessionId: 'new' } });
    } finally { await store.close(); }

    const reopened = new SqliteServerStateStore(filename, { now: () => 4_000 });
    try {
      expect(await reopened.sessions.get('legacy')).toMatchObject({ title: 'updated', favorite: true });
      expect(await reopened.sessions.get('new')).toMatchObject({ title: 'new session' });
      expect(await reopened.runs.get('new-run')).toMatchObject({ status: 'completed', result: { finalText: 'new result' } });
      expect(await reopened.approvals.get('new-approval')).toMatchObject({ scope: 'session', decision: 'deny' });
      await expect(reopened.idempotency.claim({ principalId: 'owner', route: 'session.create', key: 'new-key',
        requestHash: 'new-request', expiresAt: new Date(999999).toISOString() }))
        .resolves.toEqual({ status: 'completed', result: { sessionId: 'new' } });
    } finally { await reopened.close(); }
    const verified = new DatabaseSync(filename);
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(schemaSnapshot(verified)).toEqual(schema);
      expect(verified.prepare("SELECT role_id,personal_context_json FROM server_sessions WHERE session_id='legacy'").get())
        .toEqual({ role_id: 'coding', personal_context_json: context });
      expect(verified.prepare("SELECT role_id,personal_context_json FROM server_sessions WHERE session_id='new'").get())
        .toEqual({ role_id: null, personal_context_json: null });
    } finally { verified.close(); }
  });

  const incompatibleSchemas: [string, string][] = [
    ['missing role column', createV8.replace(`    ${roleColumn},\n`, '')],
    ['missing context column', createV8.replace(`    ${contextColumn},\n`, '')],
    ['required extra column', createV8.replace('    created_by TEXT,', '    incompatible TEXT NOT NULL,\n    created_by TEXT,')],
    ['optional unknown column', createV8.replace('    created_by TEXT,', '    incompatible TEXT,\n    created_by TEXT,')],
    ['changed core type', createV8.replace('    labels_json TEXT', '    labels_json BLOB')],
    ['changed core default', createV8.replace("labels_json TEXT NOT NULL DEFAULT '[]'", "labels_json TEXT NOT NULL DEFAULT '{}' ")],
    ['changed core nullability', createV8.replace('    labels_json TEXT NOT NULL', '    labels_json TEXT')],
    ['changed role check literal', createV8.replace("'coding'))", "'Coding'))")],
    ['changed context constraint', createV8.replace('json_valid(personal_context_json)', 'length(personal_context_json) > 0')],
    ['changed approval scope constraint', createV8.replace("CHECK(scope IN ('run', 'session'))", "CHECK(scope IN ('run', 'session', 'other'))")],
    ['changed foreign key', createV8.replace('session_id TEXT NOT NULL REFERENCES server_sessions(session_id) ON DELETE CASCADE',
      'session_id TEXT NOT NULL REFERENCES server_sessions(session_id) ON DELETE RESTRICT')],
    ['changed trigger', createV8.replace("'application_session_deleted'", "'application_session_unavailable'")],
    ['unknown trigger on core table', `${createV8}\nCREATE TRIGGER unknown_core_trigger AFTER INSERT ON server_sessions BEGIN DELETE FROM server_runs; END;`],
    ['unknown unique index on core table', `${createV8}\nCREATE UNIQUE INDEX unknown_core_index ON server_sessions(title);`],
    ['missing core table', createV8.replace(/ {2}CREATE TABLE IF NOT EXISTS application_session_projects \([\s\S]*? {2}\);/u, '')]
  ];

  it.each(incompatibleSchemas)('rejects v8 with %s without changing the schema, version, or journal mode', async (_name, schema) => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    database.exec(`${schema}\nPRAGMA user_version = 8;`);
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    const before = schemaSnapshot(database);
    expect(isKnownCompatibleServerStateVersion(database, 8)).toBe(false);
    database.close();
    expect(() => new SqliteServerStateStore(filename)).toThrow('server_state_version_unsupported: 8');
    const verified = new DatabaseSync(filename);
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 });
      expect(verified.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      expect(schemaSnapshot(verified)).toEqual(before);
    } finally { verified.close(); }
  });

  it.each([7, 9, 99])('rejects an unknown schema %s even when its tables have the known extension', async version => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initializeV8(database, 'alter');
    database.exec(`PRAGMA user_version = ${version}`);
    expect(isKnownCompatibleServerStateVersion(database, version)).toBe(false);
    database.close();
    expect(() => new SqliteServerStateStore(filename)).toThrow(`server_state_version_unsupported: ${version}`);
    const verified = new DatabaseSync(filename);
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: version });
      expect(verified.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally { verified.close(); }
  });

  it('does not authorize a current schema merely labelled version 8', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(SERVER_STATE_SCHEMA_SQL);
      expect(isKnownCompatibleServerStateVersion(database, 8)).toBe(false);
    } finally { database.close(); }
  });

  it('allows unrelated tables while rejecting changed core constraints', () => {
    const database = new DatabaseSync(':memory:');
    try {
      initializeV8(database, 'alter');
      database.exec('CREATE TABLE unrelated_metadata (value TEXT); CREATE INDEX unrelated_index ON unrelated_metadata(value);');
      expect(isKnownCompatibleServerStateVersion(database, 8)).toBe(true);
    } finally { database.close(); }
  });
});

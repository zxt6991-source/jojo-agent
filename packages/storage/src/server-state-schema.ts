export const SERVER_STATE_SCHEMA_VERSION = 2;

export const SERVER_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS server_sessions (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK(state IN ('creating', 'active')),
    title TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
    default_provider_id TEXT,
    default_model TEXT,
    created_by TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS server_sessions_updated ON server_sessions(updated_at DESC);

  CREATE TABLE IF NOT EXISTS server_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES server_sessions(session_id) ON DELETE CASCADE,
    lane_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'accepted', 'starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    request_meta_json TEXT,
    result_json TEXT,
    error_json TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS server_runs_session_created ON server_runs(session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS server_runs_recovery ON server_runs(status, updated_at);
  CREATE INDEX IF NOT EXISTS server_runs_session_status ON server_runs(session_id, status);

  CREATE TABLE IF NOT EXISTS server_approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES server_sessions(session_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES server_runs(id) ON DELETE CASCADE,
    lane_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'allowed', 'denied', 'expired', 'interrupted')),
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    preview_json TEXT,
    decision TEXT CHECK(decision IS NULL OR decision IN ('allow', 'deny')),
    resolved_by TEXT,
    interrupted_reason TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS server_approvals_session_status ON server_approvals(session_id, status);
  CREATE INDEX IF NOT EXISTS server_approvals_run ON server_approvals(run_id);
  CREATE INDEX IF NOT EXISTS server_approvals_recovery ON server_approvals(status, updated_at);

  CREATE TABLE IF NOT EXISTS server_idempotency (
    principal_id TEXT NOT NULL,
    route TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY(principal_id, route, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS server_idempotency_expiry ON server_idempotency(expires_at);
`;

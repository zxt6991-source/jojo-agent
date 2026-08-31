export const CHANNEL_SCHEMA_VERSION = 1;

export const CHANNEL_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS channel_instances (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  config_json TEXT NOT NULL, secret_refs_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, conversation_id TEXT NOT NULL, thread_id TEXT,
  conversation_type TEXT NOT NULL, session_mode TEXT NOT NULL, session_id TEXT,
  workspace_root TEXT, provider_id TEXT, model TEXT, routing_json TEXT NOT NULL, policy_json TEXT NOT NULL,
  revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(instance_id) REFERENCES channel_instances(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_binding_address
  ON channel_bindings(instance_id, conversation_id, IFNULL(thread_id, ''));
CREATE TABLE IF NOT EXISTS channel_inbound_events (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, sender_id TEXT,
  conversation_id TEXT NOT NULL, received_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
  UNIQUE(instance_id, dedupe_key)
);
CREATE TABLE IF NOT EXISTS channel_outbox (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, binding_id TEXT, conversation_id TEXT NOT NULL,
  thread_id TEXT, payload_json TEXT NOT NULL, mode TEXT NOT NULL, correlation_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL, attempt_count INTEGER NOT NULL,
  next_attempt_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT, native_message_id TEXT, last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_outbox_pending ON channel_outbox(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS channel_pairings (
  id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
  code_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_pairing_lookup
  ON channel_pairings(instance_id, conversation_id, sender_id, status);
CREATE TABLE IF NOT EXISTS channel_action_tokens (
  token_hash TEXT PRIMARY KEY, action_type TEXT NOT NULL, payload_json TEXT NOT NULL,
  allowed_sender_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_action_tokens_expiry ON channel_action_tokens(expires_at, used_at);
`;

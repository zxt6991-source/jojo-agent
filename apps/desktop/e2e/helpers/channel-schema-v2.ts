import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CHANNEL_SCHEMA_SQL } from '../../../../packages/channel-runtime/src/store/schema';

export const HISTORICAL_CHANNEL_INSTANCE = 'historical-feishu';
export const HISTORICAL_CHANNEL_BINDING = 'historical-feishu-binding';

/** Reproduce the v1 ALTER migration, including the earlier pairing table without an instance FK. */
export function seedHistoricalChannelSchema(databasePath: string, sessionId: string, createdAt: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(CHANNEL_SCHEMA_SQL.replace(
      /(CREATE TABLE IF NOT EXISTS channel_pairings \([\s\S]*?resolved_at TEXT),\s*FOREIGN KEY\(instance_id\) REFERENCES channel_instances\(id\) ON DELETE CASCADE/u,
      '$1'
    ));
    database.exec(`
      PRAGMA user_version = 1;
      ALTER TABLE channel_outbox ADD COLUMN batch_id TEXT;
      ALTER TABLE channel_outbox ADD COLUMN part_index INTEGER;
      CREATE TABLE channel_delivery_batches (
        batch_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
        expected_parts INTEGER NOT NULL CHECK(expected_parts > 0), status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_channel_outbox_batch_part ON channel_outbox(batch_id, part_index);
      PRAGMA user_version = 2;
    `);
    database.prepare(`INSERT INTO channel_instances
      (id, kind, name, enabled, config_json, secret_refs_json, fingerprint, revision, created_at, updated_at)
      VALUES (?, 'feishu', 'Offline historical Feishu', 0, ?, '{}', 'offline-fixture-fingerprint', 1, ?, ?)`)
      .run(HISTORICAL_CHANNEL_INSTANCE, JSON.stringify({ appId: 'offline-app', transport: 'websocket' }), createdAt, createdAt);
    const routing = { sessionMode: 'persistent', sessionId, instructions: ['Historical routing instruction'] };
    const policy = { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false };
    database.prepare(`INSERT INTO channel_bindings
      (id, instance_id, conversation_id, conversation_type, session_mode, session_id,
       routing_json, policy_json, revision, created_at, updated_at)
      VALUES (?, ?, 'offline-conversation', 'direct', 'persistent', ?, ?, ?, 1, ?, ?)`)
      .run(HISTORICAL_CHANNEL_BINDING, HISTORICAL_CHANNEL_INSTANCE, sessionId,
        JSON.stringify(routing), JSON.stringify(policy), createdAt, createdAt);
    for (const status of ['delivered', 'pending'] as const) {
      const batchId = `historical-${status}-batch`;
      const requests = Array.from({ length: status === 'delivered' ? 1 : 2 }, (_, index) => ({
        id: `${batchId}-part-${index}`,
        target: { instanceId: HISTORICAL_CHANNEL_INSTANCE, conversationId: 'offline-conversation' },
        content: [{ type: 'text', text: `${status} historical part ${index}` }],
        correlation: { sessionId }, mode: 'reply'
      }));
      database.prepare(`INSERT INTO channel_delivery_batches
        (batch_id, idempotency_key, request_hash, expected_parts, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(batchId, `${batchId}-key`, createHash('sha256').update(JSON.stringify(requests)).digest('hex'),
          requests.length, status, createdAt);
      for (const [index, request] of requests.entries()) {
        database.prepare(`INSERT INTO channel_outbox
          (id, instance_id, binding_id, conversation_id, payload_json, mode, correlation_json,
           idempotency_key, status, attempt_count, created_at, delivered_at, native_message_id, batch_id, part_index)
          VALUES (?, ?, ?, 'offline-conversation', ?, 'reply', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(request.id, HISTORICAL_CHANNEL_INSTANCE, HISTORICAL_CHANNEL_BINDING, JSON.stringify(request),
            JSON.stringify(request.correlation), `${batchId}-key:${index}`, status, status === 'delivered' ? 1 : 0,
            createdAt, status === 'delivered' ? createdAt : null,
            status === 'delivered' ? 'historical-native-message' : null, batchId, index);
      }
    }
  } finally { database.close(); }
}

/** Read the complete schema and rows so compatibility cannot silently drop v2 fields or rewrite hashes. */
export function readHistoricalChannelState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      version: database.prepare('PRAGMA user_version').get()?.user_version,
      schema: database.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name').all(),
      outboxColumns: database.prepare('PRAGMA table_info(channel_outbox)').all().map(column => column.name),
      pairingForeignKeys: database.prepare('PRAGMA foreign_key_list(channel_pairings)').all(),
      instances: database.prepare('SELECT * FROM channel_instances ORDER BY id').all(),
      bindings: database.prepare('SELECT * FROM channel_bindings ORDER BY id').all(),
      batches: database.prepare('SELECT * FROM channel_delivery_batches ORDER BY batch_id').all(),
      outbox: database.prepare('SELECT * FROM channel_outbox ORDER BY id').all()
    };
  } finally { database.close(); }
}

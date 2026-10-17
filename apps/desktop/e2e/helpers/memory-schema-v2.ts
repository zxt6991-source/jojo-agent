import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MemoryIndex } from '@desktop-agent/memory';

const HISTORICAL_SPACE_SCOPE = 'space:historical-fixture';

/** Reproduce the historical v2 CHECK expansion while keeping the existing entries and FTS schema. */
export function seedHistoricalMemorySchema(databasePath: string, sessionId: string, createdAt: string): void {
  const index = new MemoryIndex(databasePath);
  const ftsMode = index.ftsMode;
  index.close();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE memory_scopes_v2 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('global','project','space')),
        canonical_path TEXT, display_name TEXT NOT NULL, content_version INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
      INSERT INTO memory_scopes_v2 SELECT id,kind,canonical_path,display_name,content_version,content_hash,updated_at,dirty FROM memory_scopes;
      DROP TABLE memory_scopes; ALTER TABLE memory_scopes_v2 RENAME TO memory_scopes;
      PRAGMA user_version = 2; COMMIT; PRAGMA foreign_keys = ON;
    `);
    database.prepare(`INSERT INTO memory_scopes
      (id, kind, canonical_path, display_name, content_version, content_hash, updated_at, dirty)
      VALUES (?, 'space', NULL, 'Historical space', 7, 'historical-space-hash', ?, 1)`)
      .run(HISTORICAL_SPACE_SCOPE, Date.parse(createdAt));
    const content = 'Preserve this historical space memory across startup and restart.';
    database.prepare(`INSERT INTO memory_entries
      (id, scope_id, kind, status, title, content, tags_json, source_file, source_session_id,
       created_at, updated_at, content_hash, unknown_metadata_json)
      VALUES ('historical-space-entry', ?, 'fact', 'confirmed', 'Historical space memory', ?,
        '["historical","offline"]', 'MEMORY.md', ?, ?, ?, ?, '{"fixture":"space-v2"}')`)
      .run(HISTORICAL_SPACE_SCOPE, content, sessionId, Date.parse(createdAt), Date.parse(createdAt),
        createHash('sha256').update(content).digest('hex'));
    if (ftsMode !== 'none') {
      database.prepare(`INSERT INTO memory_fts(entry_id, scope_id, title, content, tags)
        VALUES ('historical-space-entry', ?, 'Historical space memory', ?, 'historical offline')`)
        .run(HISTORICAL_SPACE_SCOPE, content);
    }
  } finally { database.close(); }
}

/** Only snapshot the historical space: initialization may legitimately add the global scope. */
export function readHistoricalMemoryState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const hasFts = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_fts'").get());
    return {
      version: database.prepare('PRAGMA user_version').get()?.user_version,
      scopeSchema: database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_scopes'").get()?.sql,
      scope: database.prepare('SELECT * FROM memory_scopes WHERE id = ?').get(HISTORICAL_SPACE_SCOPE),
      entries: database.prepare('SELECT * FROM memory_entries WHERE scope_id = ? ORDER BY id').all(HISTORICAL_SPACE_SCOPE),
      ftsEntries: hasFts
        ? database.prepare('SELECT entry_id, scope_id, title, content, tags FROM memory_fts WHERE scope_id = ? ORDER BY entry_id')
          .all(HISTORICAL_SPACE_SCOPE)
        : []
    };
  } finally { database.close(); }
}

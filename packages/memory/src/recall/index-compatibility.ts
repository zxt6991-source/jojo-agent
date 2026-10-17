import { DatabaseSync } from 'node:sqlite';

export const MEMORY_INDEX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS memory_scopes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('global', 'project')),
    canonical_path TEXT,
    display_name TEXT NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_session_id TEXT,
    source_operation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    rule_mode TEXT,
    triggers_json TEXT,
    unknown_metadata_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_entries_scope ON memory_entries(scope_id);
`;

type Row = Record<string, unknown>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type CanonicalSchema = { objects: SchemaObject[]; tables: Map<string, string> };
type FtsMode = 'trigram' | 'unicode61' | 'none';
const canonical = new Map<FtsMode, CanonicalSchema>();

/** Preserve literals and constraints; the historical table rename quotes identifiers. */
function fingerprint(sql: string): string {
  const parts = sql.match(/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z0-9_]*|[^\s]/giu) ?? [];
  return JSON.stringify(parts.filter(part => !/^\s|^--|^\/\*/u.test(part)).map(part => {
    if (/^"[a-z_][a-z0-9_]*"$/iu.test(part)) return part.slice(1, -1).toUpperCase();
    return /^[a-z_][a-z0-9_]*$/iu.test(part) ? part.toUpperCase() : part;
  }));
}

function schemaObjects(database: DatabaseSync): SchemaObject[] {
  return database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name')
    .all() as SchemaObject[];
}

function tableShape(database: DatabaseSync, name: string): string {
  // Names are only taken from the canonical schema, never from the saved database.
  const columns = (database.prepare(`PRAGMA table_info(${name})`).all() as Row[])
    .map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
  const foreignKeys = (database.prepare(`PRAGMA foreign_key_list(${name})`).all() as Row[])
    .map(row => [row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match]);
  return JSON.stringify({ columns, foreignKeys });
}

function canonicalSchema(mode: FtsMode): CanonicalSchema {
  const cached = canonical.get(mode);
  if (cached) return cached;
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(MEMORY_INDEX_SCHEMA_SQL.replace("('global', 'project')", "('global', 'project', 'space')"));
    if (mode !== 'none') database.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      entry_id UNINDEXED, scope_id UNINDEXED, title, content, tags, tokenize = '${mode}'
    );`);
    const objects = schemaObjects(database);
    const result = {
      objects,
      tables: new Map(objects.filter(object => object.type === 'table')
        .map(object => [object.name, tableShape(database, object.name)]))
    };
    canonical.set(mode, result);
    return result;
  } finally { database.close(); }
}

/** Version 2 from personal-agent commit 0c92c70 only permits the additional space scope kind. */
export function getKnownCompatibleMemoryIndexFtsMode(database: DatabaseSync, version: number): FtsMode | undefined {
  if (version !== 2) return undefined;
  try {
    const actual = schemaObjects(database).filter(object =>
      ['memory_scopes', 'memory_entries', 'memory_fts'].includes(object.tbl_name)
      || object.tbl_name.startsWith('memory_fts_'));
    const fts = actual.find(object => object.type === 'table' && object.name === 'memory_fts');
    const mode: FtsMode = !fts ? 'none' : fingerprint(fts.sql).includes("'unicode61'") ? 'unicode61' : 'trigram';
    const expected = canonicalSchema(mode);
    if (actual.length !== expected.objects.length) return undefined;
    for (const object of expected.objects) {
      const saved = actual.find(candidate => candidate.type === object.type && candidate.name === object.name);
      if (!saved || saved.tbl_name !== object.tbl_name || fingerprint(saved.sql) !== fingerprint(object.sql)) return undefined;
    }
    for (const [name, shape] of expected.tables) {
      if (tableShape(database, name) !== shape) return undefined;
    }
    return mode;
  } catch { return undefined; }
}

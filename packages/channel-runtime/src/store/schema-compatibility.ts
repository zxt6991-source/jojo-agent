import { DatabaseSync } from 'node:sqlite';
import { CHANNEL_SCHEMA_SQL } from './schema.js';

type Row = Record<string, unknown>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type TableShape = { columns: string; foreignKeys: string };
type CanonicalSchema = { objects: SchemaObject[]; tables: Map<string, TableShape>; legacyPairing: string };

const extensions = new Map([
  ['BATCH_ID', 'batch_id TEXT'],
  ['PART_INDEX', 'part_index INTEGER']
]);

const batchSchema = `
CREATE TABLE channel_delivery_batches (
  batch_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  expected_parts INTEGER NOT NULL CHECK(expected_parts > 0), status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_channel_outbox_batch_part ON channel_outbox(batch_id, part_index);
`;

let canonical: CanonicalSchema | undefined;

/** Normalize formatting without discarding literals, constraints, or expressions. */
function tokens(sql: string): string[] {
  const parts = sql.match(/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z0-9_]*|[^\s]/giu) ?? [];
  return parts.filter(part => !/^\s|^--|^\/\*/u.test(part))
    .map(part => /^[a-z_][a-z0-9_]*$/iu.test(part) ? part.toUpperCase() : part);
}

function fingerprint(sql: string): string { return JSON.stringify(tokens(sql)); }

function schemaObjects(database: DatabaseSync): SchemaObject[] {
  return database.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name')
    .all() as SchemaObject[];
}

function tableShape(database: DatabaseSync, name: string, omitExtensions = false): TableShape {
  // Names are from the canonical schema, never an untrusted database value.
  const columns = (database.prepare(`PRAGMA table_info(${name})`).all() as Row[])
    .filter(row => !omitExtensions || !extensions.has(String(row.name).toUpperCase()))
    .map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const foreignKeys = (database.prepare(`PRAGMA foreign_key_list(${name})`).all() as Row[])
    .map(row => JSON.stringify([row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match])).sort();
  return { columns: JSON.stringify(columns), foreignKeys: JSON.stringify(foreignKeys) };
}

function canonicalSchema(): CanonicalSchema {
  if (canonical) return canonical;
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(CHANNEL_SCHEMA_SQL);
    const outboxShape = tableShape(database, 'channel_outbox');
    database.exec('ALTER TABLE channel_outbox ADD COLUMN batch_id TEXT; ALTER TABLE channel_outbox ADD COLUMN part_index INTEGER;');
    database.exec(batchSchema);
    const objects = schemaObjects(database);
    canonical = {
      objects,
      tables: new Map(objects.filter(object => object.type === 'table')
        .map(object => [object.name, object.name === 'channel_outbox' ? outboxShape : tableShape(database, object.name)])),
      // Early v1 databases lacked this FK and retained that exact table through v2 migration.
      legacyPairing: fingerprint(objects.find(object => object.name === 'channel_pairings')!.sql
        .replace(/,\s*FOREIGN KEY\(instance_id\) REFERENCES channel_instances\(id\) ON DELETE CASCADE/u, ''))
    };
    return canonical;
  } finally { database.close(); }
}

/** Fresh v2 inserts the columns in the middle; a v1 migration appends them. */
function withoutKnownExtensions(sql: string): string | undefined {
  const parts = tokens(sql);
  const opening = parts.indexOf('(');
  if (opening === -1) return undefined;
  const definitions: string[][] = [];
  let definition: string[] = [];
  let depth = 1;
  let closing = -1;
  for (let index = opening + 1; index < parts.length; index++) {
    const part = parts[index]!;
    if (part === '(') depth++;
    if (part === ')') depth--;
    if (depth === 0) { definitions.push(definition); closing = index; break; }
    if (part === ',' && depth === 1) { definitions.push(definition); definition = []; }
    else definition.push(part);
  }
  if (closing === -1) return undefined;
  const found = new Set<string>();
  const retained: string[][] = [];
  for (const column of definitions) {
    const name = column[0] ?? '';
    const expected = extensions.get(name);
    if (!expected) { retained.push(column); continue; }
    if (found.has(name) || JSON.stringify(column) !== fingerprint(expected)) return undefined;
    found.add(name);
  }
  if (found.size !== extensions.size) return undefined;
  return JSON.stringify([
    ...parts.slice(0, opening + 1),
    ...retained.flatMap((column, index) => index ? [',', ...column] : column),
    ...parts.slice(closing)
  ]);
}

/** Only the complete schema-2 shape from personal-agent commit 0c92c70 is supported. */
export function isKnownCompatibleChannelVersion(database: DatabaseSync, version: number): boolean {
  if (version !== 2) return false;
  try {
    const expected = canonicalSchema();
    const actual = schemaObjects(database);
    if (actual.length !== expected.objects.length) return false;
    for (const object of expected.objects) {
      const saved = actual.find(candidate => candidate.type === object.type && candidate.name === object.name);
      if (!saved || saved.tbl_name !== object.tbl_name) return false;
      const savedFingerprint = object.type === 'table' && object.name === 'channel_outbox'
        ? withoutKnownExtensions(saved.sql) : fingerprint(saved.sql);
      const expectedFingerprint = object.type === 'table' && object.name === 'channel_outbox'
        ? withoutKnownExtensions(object.sql) : fingerprint(object.sql);
      if (savedFingerprint !== expectedFingerprint
        && !(object.name === 'channel_pairings' && savedFingerprint === expected.legacyPairing)) return false;
    }
    for (const [name, shape] of expected.tables) {
      const actualShape = tableShape(database, name, name === 'channel_outbox');
      if (actualShape.columns !== shape.columns || (actualShape.foreignKeys !== shape.foreignKeys
        && !(name === 'channel_pairings' && actualShape.foreignKeys === '[]'))) return false;
    }
    return true;
  } catch { return false; }
}

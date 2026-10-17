import { DatabaseSync } from 'node:sqlite';
import { SERVER_STATE_SCHEMA_SQL } from './server-state-schema.js';

type Row = Record<string, unknown>;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string };
type TableShape = { columns: string; foreignKeys: string };
type CanonicalSchema = { objects: SchemaObject[]; tables: Map<string, TableShape> };

const extensions = new Map([
  ['ROLE_ID', "role_id TEXT CHECK(role_id IS NULL OR role_id IN ('personal', 'research', 'document', 'coding'))"],
  ['PERSONAL_CONTEXT_JSON', 'personal_context_json TEXT CHECK(personal_context_json IS NULL OR json_valid(personal_context_json))']
]);

let canonical: CanonicalSchema | undefined;

/** Ignore formatting while preserving string literals and every schema constraint. */
function tokens(sql: string): string[] {
  const parts = sql.match(/\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z0-9_]*|[^\s]/giu) ?? [];
  return parts.filter(part => !/^\s|^--|^\/\*/u.test(part))
    .map(part => /^[a-z_][a-z0-9_]*$/iu.test(part) ? part.toUpperCase() : part);
}

function fingerprint(sql: string): string {
  return JSON.stringify(tokens(sql));
}

function schemaObjects(database: DatabaseSync): SchemaObject[] {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all() as SchemaObject[];
}

function tableShape(database: DatabaseSync, name: string, omitExtensions = false): TableShape {
  // All names come from the canonical schema, never from a caller or database row.
  const columns = (database.prepare(`PRAGMA table_info(${name})`).all() as Row[])
    .filter(row => !omitExtensions || !extensions.has(String(row.name).toUpperCase()))
    .map(row => [row.name, row.type, row.notnull, row.dflt_value, row.pk])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const foreignKeys = (database.prepare(`PRAGMA foreign_key_list(${name})`).all() as Row[])
    .map(row => [row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match])
    .map(row => JSON.stringify(row)).sort();
  return { columns: JSON.stringify(columns), foreignKeys: JSON.stringify(foreignKeys) };
}

function canonicalSchema(): CanonicalSchema {
  if (canonical) return canonical;
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(SERVER_STATE_SCHEMA_SQL);
    const objects = schemaObjects(database);
    canonical = {
      objects,
      tables: new Map(objects.filter(object => object.type === 'table')
        .map(object => [object.name, tableShape(database, object.name)]))
    };
    return canonical;
  } finally { database.close(); }
}

/** CREATE inserts the columns in the middle; the historical migration appends them. */
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
    if (depth === 0) {
      definitions.push(definition);
      closing = index;
      break;
    }
    if (part === ',' && depth === 1) {
      definitions.push(definition);
      definition = [];
    } else definition.push(part);
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

/**
 * Schema 8 from personal-agent commit 0c92c70 only adds two nullable session
 * columns. This is a narrowly verified compatibility path, not permission to
 * migrate, relabel, or accept an otherwise unknown newer database.
 */
function matchesKnownVersion(database: DatabaseSync, version: number): boolean {
  if (version !== 8) return false;
  const expected = canonicalSchema();
  const actual = schemaObjects(database);
  const relevant = actual.filter(object => expected.tables.has(object.tbl_name));
  if (relevant.length !== expected.objects.length) return false;
  for (const object of expected.objects) {
    const saved = relevant.find(candidate => candidate.type === object.type && candidate.name === object.name);
    if (!saved || saved.tbl_name !== object.tbl_name) return false;
    const savedFingerprint = object.type === 'table' && object.name === 'server_sessions'
      ? withoutKnownExtensions(saved.sql) : fingerprint(saved.sql);
    if (savedFingerprint !== fingerprint(object.sql)) return false;
  }
  for (const [name, expectedShape] of expected.tables) {
    const savedShape = tableShape(database, name, name === 'server_sessions');
    if (savedShape.columns !== expectedShape.columns || savedShape.foreignKeys !== expectedShape.foreignKeys) return false;
  }
  const sessionColumns = database.prepare('PRAGMA table_info(server_sessions)').all() as Row[];
  return [...extensions.keys()].every(name => {
    const column = sessionColumns.find(row => String(row.name).toUpperCase() === name);
    return column?.type === 'TEXT' && column.notnull === 0 && column.dflt_value === null && column.pk === 0;
  });
}

export function isKnownCompatibleServerStateVersion(database: DatabaseSync, version: number): boolean {
  try { return matchesKnownVersion(database, version); }
  catch { return false; }
}

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, MemoryScope } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryIndex } from '../src/recall/index.js';

// Independent historical schema from personal-agent commit 0c92c70.
const createV2 = `
  CREATE TABLE memory_scopes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('global', 'project', 'space')),
    canonical_path TEXT,
    display_name TEXT NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE memory_entries (
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
  CREATE INDEX memory_entries_scope ON memory_entries(scope_id);
`;

const directories: string[] = [];
async function databaseFile(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-index-compatibility-'));
  directories.push(directory);
  return path.join(directory, 'memory.sqlite');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function initialize(database: DatabaseSync, schema = createV2, version = 2): void {
  database.exec(`${schema}\nPRAGMA user_version = ${version};`);
}

function seedSpace(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO memory_scopes VALUES ('space:historical', 'space', NULL, 'Historical space', 7, 'space-hash', 1000, 0);
    INSERT INTO memory_entries VALUES ('historical-entry', 'space:historical', 'fact', 'confirmed', 'Space fact',
      'Historical memory survives.', '[]', 'MEMORY.md', NULL, NULL, 1000, 1000, 'entry-hash', NULL, NULL, '{}');
  `);
}

const globalScope: MemoryScope = { id: 'global', kind: 'global', directory: '/test/memory', displayName: 'Global' };
const globalEntry: MemoryEntry = {
  id: 'new-entry', scopeId: 'global', kind: 'fact', status: 'confirmed', content: 'New global memory.',
  tags: [], sourceFile: 'MEMORY.md', createdAt: 2000, updatedAt: 2000, contentHash: 'global-entry-hash', unknownMetadata: {}
};

describe('MemoryIndex historical schema compatibility', () => {
  it.each(['create', 'alter'] as const)('keeps a known v2 %s schema, space history, and current writes across reopen', async variant => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database);
    if (variant === 'alter') {
      // The historical v1 migration creates a temporary table and renames it;
      // SQLite stores the renamed table identifier with double quotes.
      database.exec(`
        DROP TABLE memory_scopes;
        CREATE TABLE memory_scopes_v2 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('global','project','space')),
          canonical_path TEXT, display_name TEXT NOT NULL, content_version INTEGER NOT NULL DEFAULT 0,
          content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
        ALTER TABLE memory_scopes_v2 RENAME TO memory_scopes;
      `);
    }
    seedSpace(database);
    const originalSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_scopes'").get()?.sql;
    database.close();

    const index = new MemoryIndex(filename);
    try {
      expect(index.entries(['space:historical'])).toEqual([expect.objectContaining({
        id: 'historical-entry', scopeId: 'space:historical', content: 'Historical memory survives.'
      })]);
      index.markDirty('space:historical');
      expect(index.rebuildScope(globalScope, [globalEntry], 'global-hash')).toBe(1);
    } finally { index.close(); }

    const reopened = new MemoryIndex(filename);
    try {
      expect(reopened.scopeStatus('space:historical')).toEqual({ version: 7, hash: 'space-hash', dirty: true });
      expect(reopened.entries(['space:historical'])).toHaveLength(1);
      expect(reopened.search('New global', ['global'], undefined, 5)[0]?.entry).toEqual(globalEntry);
    } finally { reopened.close(); }

    const verified = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(verified.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_scopes'").get()?.sql).toBe(originalSql);
      expect(verified.prepare("SELECT kind FROM memory_scopes WHERE id = 'space:historical'").get()?.kind).toBe('space');
    } finally { verified.close(); }
  });

  it.each(['trigram', 'unicode61'] as const)('accepts and preserves historical %s FTS data', async tokenizer => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database);
    seedSpace(database);
    database.exec(`CREATE VIRTUAL TABLE memory_fts USING fts5(
      entry_id UNINDEXED, scope_id UNINDEXED, title, content, tags, tokenize = '${tokenizer}'
    ); INSERT INTO memory_fts VALUES ('historical-entry','space:historical','Space fact','Historical memory survives.','');`);
    const original = database.prepare('SELECT * FROM memory_fts').all();
    database.close();
    const index = new MemoryIndex(filename);
    try {
      expect(index.ftsMode).toBe(tokenizer);
      expect(index.search('Historical', ['space:historical'], undefined, 5)[0]?.entry.id).toBe('historical-entry');
    }
    finally { index.close(); }
    const verified = new DatabaseSync(filename, { readOnly: true });
    try { expect(verified.prepare('SELECT * FROM memory_fts').all()).toEqual(original); }
    finally { verified.close(); }
  });

  const incompatible: [string, string][] = [
    ['v1 merely labelled v2', createV2.replace("'project', 'space'", "'project'")],
    ['changed space literal', createV2.replace("'space'", "'Space'")],
    ['changed nullability', createV2.replace('content_hash TEXT NOT NULL', 'content_hash TEXT')],
    ['changed default', createV2.replace('dirty INTEGER NOT NULL DEFAULT 0', 'dirty INTEGER NOT NULL DEFAULT 1')],
    ['changed foreign key', createV2.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')],
    ['missing index', createV2.replace('CREATE INDEX memory_entries_scope ON memory_entries(scope_id);', '')],
    ['unknown column', createV2.replace('title TEXT,', 'title TEXT, extra TEXT,')],
    ['unknown trigger', `${createV2} CREATE TRIGGER unknown_trigger AFTER INSERT ON memory_entries BEGIN DELETE FROM memory_scopes; END;`],
    ['unknown unique index', `${createV2} CREATE UNIQUE INDEX unknown_index ON memory_entries(content);`],
    ['fake FTS table', `${createV2} CREATE TABLE memory_fts (entry_id, scope_id, title, content, tags);`],
    ['unknown FTS shadow table', `${createV2} CREATE TABLE memory_fts_unknown (value TEXT);`],
    ['missing core tables', 'CREATE TABLE unrelated (value TEXT);']
  ];
  it.each(incompatible)('rejects %s before changing database bytes, journal mode, or sidecar files', async (_name, schema) => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database, schema);
    database.close();
    const before = await readFile(filename);
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    expect(() => new MemoryIndex(filename)).toThrow('unsupported schema');
    expect((close.mock.contexts.at(-1) as DatabaseSync).isOpen).toBe(false);
    expect(await readFile(filename)).toEqual(before);
    expect(await readdir(path.dirname(filename))).toEqual(['memory.sqlite']);
    const verified = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(verified.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    } finally { verified.close(); }
  });

  it.each([3, 99])('rejects unknown version %s without modifying the file or opening WAL', async version => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database, createV2, version);
    database.close();
    const before = await readFile(filename);
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    expect(() => new MemoryIndex(filename)).toThrow('newer version');
    expect(close.mock.contexts).toHaveLength(1);
    expect((close.mock.contexts[0] as DatabaseSync).isOpen).toBe(false);
    expect(await readFile(filename)).toEqual(before);
    expect(await readdir(path.dirname(filename))).toEqual(['memory.sqlite']);
  });

  it('creates new databases as v1 with the existing global/project scope constraint', async () => {
    const filename = await databaseFile();
    const index = new MemoryIndex(filename);
    try { index.rebuildScope(globalScope, [globalEntry], 'global-hash'); }
    finally { index.close(); }
    const verified = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      const sql = String(verified.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_scopes'").get()?.sql);
      expect(sql).toContain("('global', 'project')");
      expect(sql).not.toContain("'space'");
    } finally { verified.close(); }
  });

  it('retains v1 headers on an existing space-capable schema', async () => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database, createV2, 1);
    seedSpace(database);
    database.close();
    const index = new MemoryIndex(filename);
    try { expect(index.entries(['space:historical'])).toHaveLength(1); }
    finally { index.close(); }
    const verified = new DatabaseSync(filename, { readOnly: true });
    try { expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 }); }
    finally { verified.close(); }
  });

  it.each([0, 1])('keeps the legacy dirty-column migration for version %s', async version => {
    const filename = await databaseFile();
    const database = new DatabaseSync(filename);
    initialize(database, createV2.replace(",\n    dirty INTEGER NOT NULL DEFAULT 0", '').replace("'project', 'space'", "'project'"), version);
    database.close();
    const index = new MemoryIndex(filename);
    try { index.rebuildScope(globalScope, [globalEntry], 'global-hash'); }
    finally { index.close(); }
    const verified = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(verified.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(verified.prepare('PRAGMA table_info(memory_scopes)').all()).toContainEqual(expect.objectContaining({ name: 'dirty', dflt_value: '0' }));
    } finally { verified.close(); }
  });
});

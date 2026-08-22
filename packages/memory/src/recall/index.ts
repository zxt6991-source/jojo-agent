import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { MemoryEntry, MemoryKind, MemorySearchResult, MemoryScope } from '@desktop-agent/contracts';

type Row = Record<string, unknown>;

function snippet(content: string, query: string): string {
  const normalized = content.toLocaleLowerCase();
  const offset = normalized.indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, offset < 0 ? 0 : offset - 80);
  const end = Math.min(content.length, start + 320);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function rowEntry(row: Row): MemoryEntry {
  const optional = (key: string): string | undefined => typeof row[key] === 'string' && row[key] ? row[key] as string : undefined;
  const title = optional('title');
  const sourceSessionId = optional('source_session_id');
  const sourceOperationId = optional('source_operation_id');
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    kind: String(row.kind) as MemoryKind,
    status: String(row.status) as MemoryEntry['status'],
    ...(title ? { title } : {}),
    content: String(row.content),
    tags: JSON.parse(String(row.tags_json ?? '[]')) as string[],
    sourceFile: String(row.source_file),
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceOperationId ? { sourceOperationId } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    contentHash: String(row.content_hash),
    ...(row.rule_mode === 'always' || row.rule_mode === 'triggered' ? { ruleMode: row.rule_mode } : {}),
    ...(row.triggers_json ? { triggers: JSON.parse(String(row.triggers_json)) as string[] } : {}),
    unknownMetadata: JSON.parse(String(row.unknown_metadata_json ?? '{}')) as Record<string, string>
  };
}

export class MemoryIndex {
  private readonly database: DatabaseSync;
  readonly ftsMode: 'trigram' | 'unicode61' | 'none';

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
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
    `);
    const scopeColumns = this.database.prepare('PRAGMA table_info(memory_scopes)').all() as Row[];
    if (!scopeColumns.some((column) => column.name === 'dirty')) {
      this.database.exec('ALTER TABLE memory_scopes ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;');
    }
    this.database.exec('PRAGMA user_version = 1;');
    this.ftsMode = this.ensureFts();
  }

  close(): void { this.database.close(); }

  private ensureFts(): 'trigram' | 'unicode61' | 'none' {
    try {
      this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        entry_id UNINDEXED, scope_id UNINDEXED, title, content, tags, tokenize = 'trigram'
      );`);
      return 'trigram';
    } catch {
      try {
        this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          entry_id UNINDEXED, scope_id UNINDEXED, title, content, tags, tokenize = 'unicode61'
        );`);
        return 'unicode61';
      } catch { return 'none'; }
    }
  }

  scopeVersion(scopeId: string): number {
    const row = this.database.prepare('SELECT content_version FROM memory_scopes WHERE id = ?').get(scopeId) as Row | undefined;
    return Number(row?.content_version ?? 0);
  }

  scopeStatus(scopeId: string): { version: number; hash: string; dirty: boolean } | undefined {
    const row = this.database.prepare(
      'SELECT content_version, content_hash, dirty FROM memory_scopes WHERE id = ?'
    ).get(scopeId) as Row | undefined;
    return row ? { version: Number(row.content_version), hash: String(row.content_hash), dirty: Boolean(row.dirty) } : undefined;
  }

  markDirty(scopeId: string): void {
    this.database.prepare('UPDATE memory_scopes SET dirty = 1 WHERE id = ?').run(scopeId);
  }

  rebuildScope(scope: MemoryScope, entries: MemoryEntry[], contentHash: string, increment = false): number {
    const current = this.scopeVersion(scope.id);
    const version = increment ? current + 1 : Math.max(current, 1);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO memory_scopes(
        id, kind, canonical_path, display_name, content_version, content_hash, updated_at, dirty
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, canonical_path=excluded.canonical_path, display_name=excluded.display_name,
        content_version=excluded.content_version, content_hash=excluded.content_hash,
        updated_at=excluded.updated_at, dirty=0`).run(
          scope.id, scope.kind, scope.projectIdentity?.canonicalPath ?? null, scope.displayName,
          version, contentHash, Date.now()
        );
      const existing = this.database.prepare('SELECT id FROM memory_entries WHERE scope_id = ?').all(scope.id) as Row[];
      if (this.ftsMode !== 'none') {
        const removeFts = this.database.prepare('DELETE FROM memory_fts WHERE entry_id = ?');
        for (const row of existing) removeFts.run(String(row.id));
      }
      this.database.prepare('DELETE FROM memory_entries WHERE scope_id = ?').run(scope.id);
      const insert = this.database.prepare(`INSERT INTO memory_entries(
        id, scope_id, kind, status, title, content, tags_json, source_file, source_session_id,
        source_operation_id, created_at, updated_at, content_hash, rule_mode, triggers_json,
        unknown_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFts = this.ftsMode === 'none' ? undefined
        : this.database.prepare('INSERT INTO memory_fts(entry_id, scope_id, title, content, tags) VALUES (?, ?, ?, ?, ?)');
      for (const entry of entries) {
        insert.run(
          entry.id, entry.scopeId, entry.kind, entry.status, entry.title ?? null, entry.content,
          JSON.stringify(entry.tags), entry.sourceFile, entry.sourceSessionId ?? null,
          entry.sourceOperationId ?? null, entry.createdAt, entry.updatedAt, entry.contentHash,
          entry.ruleMode ?? null, entry.triggers ? JSON.stringify(entry.triggers) : null,
          JSON.stringify(entry.unknownMetadata)
        );
        insertFts?.run(entry.id, entry.scopeId, entry.title ?? '', entry.content, entry.tags.join(' '));
      }
      this.database.exec('COMMIT');
      return version;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  entries(scopeIds: string[]): MemoryEntry[] {
    if (scopeIds.length === 0) return [];
    const placeholders = scopeIds.map(() => '?').join(',');
    return (this.database.prepare(`SELECT * FROM memory_entries WHERE scope_id IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...scopeIds) as Row[]).map(rowEntry);
  }

  search(query: string, scopeIds: string[], kinds: MemoryKind[] | undefined, limit: number): MemorySearchResult[] {
    if (scopeIds.length === 0) return [];
    const all = this.entries(scopeIds).filter((entry) => !kinds?.length || kinds.includes(entry.kind));
    const normalized = query.normalize('NFKC').toLocaleLowerCase();
    const substring = all
      .filter((entry) => `${entry.title ?? ''}\n${entry.content}\n${entry.tags.join(' ')}`.normalize('NFKC').toLocaleLowerCase().includes(normalized))
      .map((entry) => ({ entry, score: 1, snippet: snippet(entry.content, query) }));
    if (this.ftsMode === 'none' || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query)) {
      return substring.slice(0, limit);
    }
    try {
      const scopePlaceholders = scopeIds.map(() => '?').join(',');
      const kindClause = kinds?.length ? ` AND e.kind IN (${kinds.map(() => '?').join(',')})` : '';
      const safeQuery = query.split(/\s+/u).filter(Boolean).map((term) => `"${term.replace(/"/gu, '""')}"`).join(' AND ');
      const params: SQLInputValue[] = [safeQuery, ...scopeIds, ...(kinds ?? []), limit];
      const rows = this.database.prepare(`SELECT e.*, bm25(memory_fts) AS rank
        FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.entry_id
        WHERE memory_fts MATCH ? AND e.scope_id IN (${scopePlaceholders})${kindClause}
        ORDER BY rank LIMIT ?`).all(...params) as Row[];
      const fts = rows.map((row) => ({
        entry: rowEntry(row), score: 1 / (1 + Math.max(0, Number(row.rank))), snippet: snippet(String(row.content), query)
      }));
      const seen = new Set(fts.map((item) => item.entry.id));
      return [...fts, ...substring.filter((item) => !seen.has(item.entry.id))].slice(0, limit);
    } catch {
      return substring.slice(0, limit);
    }
  }
}

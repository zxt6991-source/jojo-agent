import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MemoryError, type MemoryChunk, type SemanticSearchHit } from '@desktop-agent/contracts';
import type {
  SemanticIndexRequest,
  SemanticIndexResult,
  SemanticMemoryBackend,
  SemanticSearchRequest
} from '@desktop-agent/memory';

type Row = Record<string, unknown>;

function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function decodeVector(value: unknown, dimensions: number): Float32Array | undefined {
  if (!(value instanceof Uint8Array) || value.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return undefined;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  const vector = new Float32Array(copy.buffer);
  return [...vector].every(Number.isFinite) ? vector : undefined;
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : Number.NaN;
}

function jobKey(chunk: Pick<MemoryChunk, 'id' | 'contentHash'>, request: SemanticIndexRequest): string {
  return `semantic_index:${chunk.id}:${chunk.contentHash}:${request.provider.id}:${request.provider.model}:${request.chunkingVersion}:${request.normalizationVersion}`;
}

export class SqliteSemanticMemoryBackend implements SemanticMemoryBackend {
  private readonly database: DatabaseSync;

  constructor(readonly filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        chunk_id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        heading TEXT,
        kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding_provider TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dimensions INTEGER NOT NULL,
        chunking_version INTEGER NOT NULL,
        normalization_version INTEGER NOT NULL,
        embedding_blob BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_embeddings_scope ON memory_embeddings(scope_id);
      CREATE INDEX IF NOT EXISTS memory_embeddings_entry ON memory_embeddings(entry_id);
      CREATE TABLE IF NOT EXISTS memory_semantic_jobs (
        dedupe_key TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        embedding_provider TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        reason TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS memory_semantic_jobs_state ON memory_semantic_jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS memory_semantic_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void { this.database.close(); }

  async capabilities(providerId: string, model: string) {
    const row = this.database.prepare(`
      SELECT embedding_dimensions FROM memory_embeddings
      WHERE embedding_provider = ? AND embedding_model = ? LIMIT 1
    `).get(providerId, model) as Row | undefined;
    return {
      enabled: true,
      mode: 'local-linear' as const,
      embeddingProviderId: providerId,
      embeddingModel: model,
      ...(typeof row?.embedding_dimensions === 'number' ? { dimensions: row.embedding_dimensions } : {}),
      supportsIncrementalIndex: true
    };
  }

  async ensureIndexed(input: SemanticIndexRequest): Promise<SemanticIndexResult> {
    return this.index(input, false);
  }

  async rebuild(input: SemanticIndexRequest): Promise<SemanticIndexResult> {
    return this.index(input, true);
  }

  private async index(input: SemanticIndexRequest, rebuilding: boolean): Promise<SemanticIndexResult> {
    const now = Date.now();
    const unchanged: MemoryChunk[] = [];
    const changed: MemoryChunk[] = [];
    for (const chunk of input.chunks) {
      const row = this.database.prepare(`
        SELECT 1 AS found FROM memory_embeddings WHERE chunk_id = ? AND content_hash = ?
          AND embedding_provider = ? AND embedding_model = ?
          AND chunking_version = ? AND normalization_version = ?
      `).get(
        chunk.id, chunk.contentHash, input.provider.id, input.provider.model,
        input.chunkingVersion, input.normalizationVersion
      ) as Row | undefined;
      (row ? unchanged : changed).push(chunk);
    }
    const enqueue = this.database.prepare(`
      INSERT INTO memory_semantic_jobs(
        dedupe_key, chunk_id, entry_id, scope_id, embedding_provider, embedding_model, state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET state = CASE
        WHEN memory_semantic_jobs.state = 'completed' THEN 'completed' ELSE 'pending' END, reason = NULL
    `);
    for (const chunk of changed) enqueue.run(
      jobKey(chunk, input), chunk.id, chunk.entryId, chunk.scopeId,
      input.provider.id, input.provider.model, now
    );
    for (const chunk of input.skipped) {
      this.database.prepare('DELETE FROM memory_embeddings WHERE chunk_id = ?').run(chunk.id);
      this.database.prepare(`
        INSERT INTO memory_semantic_jobs(
          dedupe_key, chunk_id, entry_id, scope_id, embedding_provider, embedding_model,
          state, reason, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'secret', ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET state = 'skipped', reason = 'secret', completed_at = excluded.completed_at
      `).run(
        `semantic_index:${chunk.id}:${chunk.contentHash}:${input.provider.id}:${input.provider.model}:secret`,
        chunk.id, chunk.entryId, chunk.scopeId, input.provider.id, input.provider.model, now, now
      );
    }
    let dimensions: number | undefined;
    if (changed.length) {
      const keys = changed.map((chunk) => jobKey(chunk, input));
      const updateJobs = (state: 'running' | 'completed' | 'failed', reason?: string) => {
        const statement = this.database.prepare(`
          UPDATE memory_semantic_jobs SET state = ?, reason = ?, completed_at = ? WHERE dedupe_key = ?
        `);
        for (const key of keys) statement.run(state, reason ?? null, state === 'running' ? null : Date.now(), key);
      };
      updateJobs('running');
      try {
        const embedded = await input.provider.embed(changed.map((chunk) => chunk.content), { ...(input.signal ? { signal: input.signal } : {}) });
        if (embedded.vectors.length !== changed.length) throw new MemoryError('memory_embedding_failed', 'Embedding vector count did not match chunks.');
        dimensions = embedded.vectors[0]?.length;
        if (!dimensions || embedded.vectors.some((vector) => vector.length !== dimensions || [...vector].some((value) => !Number.isFinite(value)))) {
          throw new MemoryError('memory_embedding_invalid_dimension', 'Embedding vectors have invalid or inconsistent dimensions.');
        }
        this.database.exec('BEGIN IMMEDIATE');
        try {
          const upsert = this.database.prepare(`
            INSERT INTO memory_embeddings(
              chunk_id, entry_id, scope_id, source_file, heading, kind, content_hash,
              embedding_provider, embedding_model, embedding_dimensions, chunking_version,
              normalization_version, embedding_blob, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id) DO UPDATE SET
              entry_id=excluded.entry_id, scope_id=excluded.scope_id, source_file=excluded.source_file,
              heading=excluded.heading, kind=excluded.kind, content_hash=excluded.content_hash,
              embedding_provider=excluded.embedding_provider, embedding_model=excluded.embedding_model,
              embedding_dimensions=excluded.embedding_dimensions, chunking_version=excluded.chunking_version,
              normalization_version=excluded.normalization_version, embedding_blob=excluded.embedding_blob,
              updated_at=excluded.updated_at
          `);
          changed.forEach((chunk, index) => upsert.run(
            chunk.id, chunk.entryId, chunk.scopeId, chunk.file, chunk.headingPath.join(' / ') || null,
            chunk.kind, chunk.contentHash, input.provider.id, input.provider.model, dimensions!,
            input.chunkingVersion, input.normalizationVersion, vectorBytes(embedded.vectors[index]!), now, Date.now()
          ));
          this.database.exec('COMMIT');
        } catch (error) {
          this.database.exec('ROLLBACK');
          throw error;
        }
        updateJobs('completed');
        input.onUsage?.({ ...embedded.usage, indexedChunks: changed.length });
      } catch (error) {
        updateJobs('failed', error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500));
        throw error;
      }
    }
    let removed = 0;
    if (rebuilding && input.replaceScopeIds?.length) {
      const active = new Set([...input.chunks, ...input.skipped].map((chunk) => chunk.id));
      const placeholders = input.replaceScopeIds.map(() => '?').join(',');
      const rows = this.database.prepare(`SELECT chunk_id FROM memory_embeddings WHERE scope_id IN (${placeholders})`)
        .all(...input.replaceScopeIds) as Row[];
      const remove = this.database.prepare('DELETE FROM memory_embeddings WHERE chunk_id = ?');
      for (const row of rows) if (!active.has(String(row.chunk_id))) {
        removed += Number(remove.run(String(row.chunk_id)).changes);
      }
      this.database.prepare(`
        INSERT INTO memory_semantic_meta(key, value) VALUES ('last_rebuild_at', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(Date.now()));
    }
    return { indexed: changed.length, unchanged: unchanged.length, removed, skippedSecret: input.skipped.length, ...(dimensions ? { dimensions } : {}) };
  }

  async search(input: SemanticSearchRequest): Promise<SemanticSearchHit[]> {
    if (!input.scopeIds.length) return [];
    const scopePlaceholders = input.scopeIds.map(() => '?').join(',');
    const kindClause = input.kinds?.length ? ` AND kind IN (${input.kinds.map(() => '?').join(',')})` : '';
    const params: SQLInputValue[] = [
      input.providerId, input.model, input.chunkingVersion, input.normalizationVersion,
      ...input.scopeIds, ...(input.kinds ?? [])
    ];
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_embeddings
      WHERE embedding_provider = ? AND embedding_model = ? AND chunking_version = ?
        AND normalization_version = ? AND scope_id IN (${scopePlaceholders})${kindClause}
    `).get(...params) as Row;
    if (Number(count.count) > input.maxCandidates) {
      throw new MemoryError('memory_semantic_backend_capacity_exceeded', 'Semantic vector capacity exceeded.');
    }
    const rows = this.database.prepare(`
      SELECT chunk_id, entry_id, scope_id, content_hash, embedding_dimensions, embedding_blob
      FROM memory_embeddings
      WHERE embedding_provider = ? AND embedding_model = ? AND chunking_version = ?
        AND normalization_version = ? AND scope_id IN (${scopePlaceholders})${kindClause}
    `).all(...params) as Row[];
    const corrupt: string[] = [];
    const hits = rows.flatMap((row) => {
      const dimensions = Number(row.embedding_dimensions);
      const vector = decodeVector(row.embedding_blob, dimensions);
      if (!vector || vector.length !== input.vector.length) {
        corrupt.push(String(row.chunk_id));
        return [];
      }
      const similarity = cosine(input.vector, vector);
      if (!Number.isFinite(similarity)) {
        corrupt.push(String(row.chunk_id));
        return [];
      }
      return [{
        chunkId: String(row.chunk_id), entryId: String(row.entry_id), scopeId: String(row.scope_id),
        contentHash: String(row.content_hash), similarity
      }];
    });
    const remove = this.database.prepare('DELETE FROM memory_embeddings WHERE chunk_id = ?');
    for (const id of corrupt) remove.run(id);
    return hits.filter((hit) => hit.similarity >= 0.35)
      .sort((left, right) => right.similarity - left.similarity).slice(0, input.limit);
  }

  async remove(input: { entryIds: string[] }): Promise<void> {
    if (!input.entryIds.length) return;
    const placeholders = input.entryIds.map(() => '?').join(',');
    this.database.prepare(`DELETE FROM memory_embeddings WHERE entry_id IN (${placeholders})`).run(...input.entryIds);
  }

  async status(input: { enabled: boolean; mode: 'local-linear' | 'plugin-vector'; providerId?: string; model?: string }) {
    const providerFilter = input.providerId && input.model ? ' WHERE embedding_provider = ? AND embedding_model = ?' : '';
    const params = input.providerId && input.model ? [input.providerId, input.model] : [];
    const indexed = this.database.prepare(`SELECT COUNT(*) AS count FROM memory_embeddings${providerFilter}`).get(...params) as Row;
    const jobCount = (state: string, reason?: string) => {
      const prefix = providerFilter ? `${providerFilter} AND` : ' WHERE';
      return Number((this.database.prepare(`
        SELECT COUNT(*) AS count FROM memory_semantic_jobs${prefix} state = ?${reason ? ' AND reason = ?' : ''}
      `).get(...params, state, ...(reason ? [reason] : [])) as Row).count);
    };
    const stale = input.providerId && input.model
      ? Number((this.database.prepare(`
        SELECT COUNT(*) AS count FROM memory_embeddings
        WHERE embedding_provider != ? OR embedding_model != ?
      `).get(input.providerId, input.model) as Row).count)
      : 0;
    const meta = this.database.prepare(`SELECT value FROM memory_semantic_meta WHERE key = 'last_rebuild_at'`).get() as Row | undefined;
    return {
      enabled: input.enabled,
      mode: input.mode,
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.model ? { model: input.model } : {}),
      indexedChunks: Number(indexed.count),
      pending: jobCount('pending') + jobCount('running'),
      failed: jobCount('failed'),
      skippedSecret: jobCount('skipped', 'secret'),
      stale,
      ...(meta ? { lastRebuildAt: Number(meta.value) } : {})
    };
  }
}

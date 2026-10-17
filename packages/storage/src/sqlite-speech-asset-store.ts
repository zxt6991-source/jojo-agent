import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AudioAssetOwnerSchema, AudioAssetSchema, SPEECH_LIMITS, SpeechProviderError } from '@desktop-agent/contracts';
import type { AudioAsset, AudioAssetOwner, AudioAssetWriter, SpeechAssetStore } from '@desktop-agent/contracts';

export interface SqliteSpeechAssetStoreOptions {
  assetsDirectory?: string;
  maxCacheBytes?: number;
  maxAssetBytes?: number;
  cacheAgeMs?: number;
  orphanAgeMs?: number;
  now?: () => number;
}
export interface ReadySpeechAsset { asset: AudioAsset; path: string }

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CACHE_KEY = /^sha256:[0-9a-f]{64}$/u;
const MANAGED_FILE = /^[0-9a-f-]{36}\.(?:mp3|wav|part)$/iu;
function failure(message = 'Speech audio asset storage failed.'): SpeechProviderError {
  return new SpeechProviderError('protocol_error', message);
}
function cancelled(): SpeechProviderError { return new SpeechProviderError('cancelled', 'Speech audio asset writer is closed.'); }
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

interface PendingWriter {
  owner: AudioAssetOwner;
  cancel(): void;
}

/** Worker-owned manifest and cache. Only ready entities have rows; owners receive
 * independent opaque authorization references. No credentials or source text persist.
 * Synchronous FS/SQLite sections keep publication, clear and cancellation serialized.
 */
export class SqliteSpeechAssetStore implements SpeechAssetStore {
  readonly assetsDirectory: string;
  private readonly database: DatabaseSync;
  private readonly writers = new Set<PendingWriter>();
  private readonly maxCacheBytes: number;
  private readonly maxAssetBytes: number;
  private readonly cacheAgeMs: number;
  private readonly orphanAgeMs: number;
  private readonly now: () => number;
  private closed = false;
  private generation = 0;

  constructor(readonly filename: string, options: SqliteSpeechAssetStoreOptions = {}) {
    this.maxCacheBytes = options.maxCacheBytes ?? SPEECH_LIMITS.cacheBytes;
    this.maxAssetBytes = options.maxAssetBytes ?? SPEECH_LIMITS.ttsBytes;
    this.cacheAgeMs = options.cacheAgeMs ?? SPEECH_LIMITS.cacheAgeMs;
    this.orphanAgeMs = options.orphanAgeMs ?? 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (![this.maxCacheBytes, this.maxAssetBytes, this.cacheAgeMs, this.orphanAgeMs]
      .every((value) => Number.isSafeInteger(value) && value > 0) || this.maxAssetBytes > SPEECH_LIMITS.ttsBytes) {
      throw new RangeError('Speech asset limits must be positive integers within the audio limit.');
    }
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const directory = path.resolve(options.assetsDirectory ?? path.join(path.dirname(filename), 'speech-assets'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw failure('Invalid speech asset directory.');
    this.assetsDirectory = realpathSync(directory);
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS speech_asset_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS speech_audio_entities (
          entity_id TEXT PRIMARY KEY,
          cache_key TEXT NOT NULL UNIQUE,
          format TEXT NOT NULL DEFAULT 'mp3' CHECK(format IN ('mp3', 'wav')),
          bytes INTEGER NOT NULL CHECK(bytes > 0),
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          last_accessed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS speech_audio_refs (
          id TEXT PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES speech_audio_entities(entity_id) ON DELETE CASCADE,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('session', 'schedule', 'test')),
          owner_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS speech_audio_refs_owner ON speech_audio_refs(owner_kind, owner_id);
        CREATE INDEX IF NOT EXISTS speech_audio_entities_lru ON speech_audio_entities(last_accessed_at, created_at);
      `);
      const version = this.database.prepare("SELECT value FROM speech_asset_meta WHERE key = 'schema_version'").get() as Row | undefined;
      if (version && version.value !== '1' && version.value !== '2') throw failure('Unsupported speech asset schema version.');
      this.transaction(() => {
        const columns = this.database.prepare('PRAGMA table_info(speech_audio_entities)').all() as Row[];
        if (!columns.some(column => column.name === 'format')) {
          if (version?.value === '2') throw failure('Invalid speech asset schema.');
          this.database.exec("ALTER TABLE speech_audio_entities ADD COLUMN format TEXT NOT NULL DEFAULT 'mp3' CHECK(format IN ('mp3', 'wav'));");
        }
        this.database.prepare("INSERT INTO speech_asset_meta(key,value) VALUES ('schema_version','2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
      });
      this.prune();
      this.cleanOrphans();
    } catch (error) { this.database.close(); throw error instanceof SpeechProviderError ? error : failure(); }
  }

  private assertOpen(): void { if (this.closed) throw cancelled(); }
  private validateKey(cacheKey: string): void { if (!CACHE_KEY.test(cacheKey)) throw failure('Invalid speech cache key.'); }
  private validateOwner(owner: AudioAssetOwner): AudioAssetOwner {
    const parsed = AudioAssetOwnerSchema.safeParse(owner);
    if (!parsed.success) throw failure('Invalid speech asset owner.');
    return parsed.data;
  }
  private checkDirectory(): void {
    const stat = lstatSync(this.assetsDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.assetsDirectory) !== this.assetsDirectory) {
      throw failure('Invalid speech asset directory.');
    }
  }
  private entityPath(id: unknown, format: unknown): string | undefined {
    return typeof id === 'string' && UUID.test(id) && (format === 'mp3' || format === 'wav')
      ? path.join(this.assetsDirectory, `${id}.${format}`) : undefined;
  }
  private unlink(file: string): void {
    try { unlinkSync(file); } catch (error) { if (!isMissing(error)) throw failure(); }
  }
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE;');
    try { const result = action(); this.database.exec('COMMIT;'); return result; }
    catch (error) { this.database.exec('ROLLBACK;'); throw error; }
  }
  private validEntity(row: Row): boolean {
    const file = this.entityPath(row.entity_id, row.format);
    if (!file || typeof row.cache_key !== 'string' || !CACHE_KEY.test(row.cache_key) ||
      ![row.bytes, row.created_at, row.expires_at, row.last_accessed_at].every((value) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
      (row.bytes as number) < 1 || (row.bytes as number) > this.maxAssetBytes ||
      (row.expires_at as number) <= this.now()) return false;
    this.checkDirectory();
    try {
      const stat = lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size === row.bytes;
    } catch (error) { if (isMissing(error)) return false; throw failure(); }
  }
  private removeEntity(row: Row): void {
    this.database.prepare('DELETE FROM speech_audio_entities WHERE entity_id = ?').run(String(row.entity_id));
    const file = this.entityPath(row.entity_id, row.format);
    if (file) { this.checkDirectory(); this.unlink(file); }
  }
  private prune(protectedId?: string): void {
    const rows = this.database.prepare('SELECT * FROM speech_audio_entities ORDER BY last_accessed_at, created_at, entity_id').all() as Row[];
    let bytes = 0;
    const ready: Row[] = [];
    for (const row of rows) {
      if (!this.validEntity(row)) this.removeEntity(row);
      else { bytes += row.bytes as number; ready.push(row); }
    }
    for (const row of ready) {
      if (bytes <= this.maxCacheBytes) break;
      if (row.entity_id === protectedId) continue;
      this.removeEntity(row); bytes -= row.bytes as number;
    }
  }
  private cleanOrphans(): void {
    this.checkDirectory();
    const entities = new Set((this.database.prepare('SELECT entity_id, format FROM speech_audio_entities').all() as Row[])
      .map((row) => `${String(row.entity_id)}.${String(row.format)}`));
    for (const name of readdirSync(this.assetsDirectory)) {
      if (!MANAGED_FILE.test(name) || entities.has(name)) continue;
      const file = path.join(this.assetsDirectory, name);
      const stat = lstatSync(file);
      if (stat.mtimeMs <= this.now() - this.orphanAgeMs && !stat.isDirectory()) this.unlink(file);
    }
  }
  private reference(row: Row, owner: AudioAssetOwner): AudioAsset {
    const now = this.now();
    return this.transaction(() => {
      const id = randomUUID();
      this.database.prepare('INSERT INTO speech_audio_refs(id, entity_id, owner_kind, owner_id) VALUES (?, ?, ?, ?)')
        .run(id, String(row.entity_id), owner.kind, owner.id);
      this.database.prepare('UPDATE speech_audio_entities SET last_accessed_at = ? WHERE entity_id = ?').run(now, String(row.entity_id));
      return AudioAssetSchema.parse({ id, owner, format: row.format, sampleRate: 24000, bytes: row.bytes,
        createdAt: row.created_at, expiresAt: row.expires_at });
    });
  }
  private releaseReference(id: string, owner: AudioAssetOwner): void {
    const orphan = this.transaction(() => {
      const row = this.database.prepare(`SELECT e.*, r.owner_kind, r.owner_id FROM speech_audio_refs r
        JOIN speech_audio_entities e ON e.entity_id = r.entity_id WHERE r.id = ?`).get(id) as Row | undefined;
      if (!row) return undefined;
      if (row.owner_kind !== owner.kind || row.owner_id !== owner.id) {
        throw new SpeechProviderError('resource_denied', 'Speech asset reference belongs to another owner.');
      }
      this.database.prepare('DELETE FROM speech_audio_refs WHERE id = ? AND owner_kind = ? AND owner_id = ?')
        .run(id, owner.kind, owner.id);
      if (this.database.prepare('SELECT 1 FROM speech_audio_refs WHERE entity_id = ? LIMIT 1').get(String(row.entity_id))) return undefined;
      this.database.prepare('DELETE FROM speech_audio_entities WHERE entity_id = ?').run(String(row.entity_id));
      return row;
    });
    if (orphan) {
      const file = this.entityPath(orphan.entity_id, orphan.format);
      if (file) { this.checkDirectory(); this.unlink(file); }
    }
  }

  async find(cacheKey: string, owner: AudioAssetOwner): Promise<AudioAsset | undefined> {
    this.assertOpen(); this.validateKey(cacheKey); owner = this.validateOwner(owner);
    this.prune();
    const row = this.database.prepare('SELECT * FROM speech_audio_entities WHERE cache_key = ?').get(cacheKey) as Row | undefined;
    return row ? this.reference(row, owner) : undefined;
  }

  async getReadyAsset(id: string, owner: AudioAssetOwner): Promise<ReadySpeechAsset | undefined> {
    this.assertOpen(); owner = this.validateOwner(owner);
    if (!UUID.test(id)) return undefined;
    const row = this.database.prepare(`SELECT e.*, r.id AS reference_id FROM speech_audio_refs r
      JOIN speech_audio_entities e ON e.entity_id = r.entity_id WHERE r.id = ? AND r.owner_kind = ? AND r.owner_id = ?`)
      .get(id, owner.kind, owner.id) as Row | undefined;
    if (!row) return undefined;
    if (!this.validEntity(row)) { this.removeEntity(row); return undefined; }
    const asset = AudioAssetSchema.parse({ id: row.reference_id, owner, format: row.format, sampleRate: 24000,
      bytes: row.bytes, createdAt: row.created_at, expiresAt: row.expires_at });
    this.database.prepare('UPDATE speech_audio_entities SET last_accessed_at = ? WHERE entity_id = ?').run(this.now(), String(row.entity_id));
    return { asset, path: this.entityPath(row.entity_id, row.format)! };
  }

  async release(asset: AudioAsset): Promise<void> {
    this.assertOpen();
    const parsed = AudioAssetSchema.safeParse(asset);
    if (!parsed.success) throw failure('Invalid speech asset reference.');
    this.releaseReference(parsed.data.id, parsed.data.owner);
  }

  async begin(cacheKey: string, owner: AudioAssetOwner, format: AudioAsset['format'] = 'mp3'): Promise<AudioAssetWriter> {
    this.assertOpen(); this.validateKey(cacheKey); owner = this.validateOwner(owner); this.checkDirectory();
    if (format !== 'mp3' && format !== 'wav') throw failure('Invalid speech audio format.');
    const entityId = randomUUID();
    const temporary = path.join(this.assetsDirectory, `${entityId}.part`);
    const destination = this.entityPath(entityId, format)!;
    const generation = this.generation;
    let descriptor: number | undefined;
    try { descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch { throw failure(); }
    let state: 'writing' | 'completed' | 'aborted' = 'writing';
    let bytes = 0;
    let published: AudioAsset | undefined;
    let renamed = false;
    const abort = (): void => {
      if (state === 'aborted') return;
      if (state === 'completed') {
        state = 'aborted';
        if (!published || this.closed || this.generation !== generation) return;
        this.releaseReference(published.id, owner);
        return;
      }
      state = 'aborted';
      if (descriptor !== undefined) { try { closeSync(descriptor); } finally { descriptor = undefined; } }
      this.writers.delete(pending);
      this.unlink(temporary);
      if (renamed) this.unlink(destination);
    };
    const pending: PendingWriter = { owner, cancel: abort };
    this.writers.add(pending);
    const check = (): void => {
      if (this.closed || this.generation !== generation || state !== 'writing' || descriptor === undefined) throw cancelled();
      this.checkDirectory();
    };
    return {
      append: async (chunk) => {
        try {
          check();
          if (!(chunk instanceof Uint8Array) || bytes + chunk.byteLength > this.maxAssetBytes ||
            bytes + chunk.byteLength > this.maxCacheBytes) throw failure('Speech audio exceeded its storage limit.');
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = writeSync(descriptor!, chunk, offset, chunk.byteLength - offset);
            if (!written) throw failure();
            offset += written;
          }
          bytes += chunk.byteLength;
        } catch (error) {
          try { abort(); } catch { /* Preserve the original write error. */ }
          throw error instanceof SpeechProviderError ? error : failure();
        }
      },
      complete: async () => {
        if (state === 'completed' && published && !this.closed && this.generation === generation) return published;
        try {
          check();
          if (!bytes) throw new SpeechProviderError('empty_result', 'Speech audio asset is empty.');
          fsyncSync(descriptor!);
          const opened = fstatSync(descriptor!);
          const actual = lstatSync(temporary);
          if (!actual.isFile() || actual.isSymbolicLink() || actual.size !== bytes ||
            actual.ino !== opened.ino || actual.dev !== opened.dev) throw failure('Invalid speech audio temporary file.');
          closeSync(descriptor!); descriptor = undefined;
          this.prune();
          let entity = this.database.prepare('SELECT * FROM speech_audio_entities WHERE cache_key = ?').get(cacheKey) as Row | undefined;
          if (!entity) {
            renameSync(temporary, destination); renamed = true;
            const now = this.now();
            try {
              this.database.prepare(`INSERT INTO speech_audio_entities(entity_id, cache_key, format, bytes, created_at, expires_at, last_accessed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(entityId, cacheKey, format, bytes, now, now + this.cacheAgeMs, now);
              entity = { entity_id: entityId, cache_key: cacheKey, format, bytes, created_at: now, expires_at: now + this.cacheAgeMs, last_accessed_at: now };
            } catch (error) {
              // Another writer may have committed this cache key first; its entity wins.
              this.unlink(destination); renamed = false;
              entity = this.database.prepare('SELECT * FROM speech_audio_entities WHERE cache_key = ?').get(cacheKey) as Row | undefined;
              if (!entity || !this.validEntity(entity)) throw error;
            }
          }
          if (entity.format !== format) throw failure('Speech cache identity has a different audio format.');
          published = this.reference(entity, owner);
          this.unlink(temporary);
          this.prune(String(entity.entity_id));
          state = 'completed'; this.writers.delete(pending);
          return published;
        } catch (error) {
          if (renamed) {
            const entity = this.database.prepare('SELECT * FROM speech_audio_entities WHERE entity_id = ?').get(entityId) as Row | undefined;
            if (entity) this.removeEntity(entity);
          }
          try { abort(); } catch { /* Preserve the original publication error. */ }
          throw error instanceof SpeechProviderError ? error : failure();
        }
      },
      abort: async () => { abort(); }
    };
  }

  async releaseOwner(owner: AudioAssetOwner): Promise<void> {
    this.assertOpen(); owner = this.validateOwner(owner);
    for (const writer of this.writers) if (writer.owner.kind === owner.kind && writer.owner.id === owner.id) writer.cancel();
    this.database.prepare('DELETE FROM speech_audio_refs WHERE owner_kind = ? AND owner_id = ?').run(owner.kind, owner.id);
    const orphaned = this.database.prepare(`SELECT e.* FROM speech_audio_entities e
      WHERE NOT EXISTS (SELECT 1 FROM speech_audio_refs r WHERE r.entity_id = e.entity_id)`).all() as Row[];
    for (const row of orphaned) this.removeEntity(row);
  }

  async clear(): Promise<void> {
    this.assertOpen(); this.generation++;
    for (const writer of this.writers) writer.cancel();
    const entities = this.database.prepare('SELECT * FROM speech_audio_entities').all() as Row[];
    for (const row of entities) this.removeEntity(row);
    this.checkDirectory();
    for (const name of readdirSync(this.assetsDirectory)) {
      if (MANAGED_FILE.test(name)) this.unlink(path.join(this.assetsDirectory, name));
    }
  }

  close(): void {
    if (this.closed) return;
    this.generation++;
    for (const writer of this.writers) writer.cancel();
    this.database.close(); this.closed = true;
  }
}

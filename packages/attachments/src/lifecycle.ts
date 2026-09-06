import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { FileAttachmentRefSchema } from '@desktop-agent/contracts';

export const DEFAULT_ATTACHMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const idPattern = /^att_[0-9a-f-]{36}$/u;

/** Scan all records, not only the active lane: forks and recovery states also retain refs. */
function mark(value: unknown, ids: Set<string>): void {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    const record = item as Record<string, unknown>;
    if (typeof record.attachmentId === 'string') ids.add(record.attachmentId);
    for (const child of Object.values(record)) pending.push(child);
  }
}

export async function scanAttachmentReferences(sources: string[]): Promise<Set<string>> {
  if (!sources.length) throw new Error('Provide all JSONL directories/files and runtime SQLite databases used by this attachment store.');
  const ids = new Set<string>();
  async function scan(source: string): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Symbolic link in reference sources: ${source}`);
    if (info.isDirectory()) {
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink() || /\.(jsonl|sqlite)$/u.test(entry.name)) await scan(path.join(source, entry.name));
      }
      return;
    }
    if (!info.isFile()) throw new Error(`Not a regular reference source: ${source}`);
    if (source.endsWith('.jsonl')) {
      const stream = createReadStream(source);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try { for await (const line of lines) if (line.trim()) mark(JSON.parse(line), ids); }
      finally { lines.close(); stream.destroy(); }
    } else if (source.endsWith('.sqlite')) {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        // Require the runtime schema; never interpret an unrelated DB as an empty session store.
        db.exec('BEGIN');
        for (const query of [
          'SELECT metadata_json AS value FROM sessions',
          'SELECT payload_json AS value FROM entries',
          'SELECT meta_json AS value FROM operations',
          'SELECT state_json AS value FROM operations'
        ]) {
          for (const row of db.prepare(query).iterate()) if (row.value !== null) mark(JSON.parse(String(row.value)), ids);
        }
        db.exec('COMMIT');
      } finally { db.close(); }
    } else throw new Error(`Unsupported reference source: ${source}`);
  }
  for (const source of new Set(sources.map((source) => path.resolve(source)))) await scan(source);
  return ids;
}

type Candidate = { path: string; bytes: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number };
export interface AttachmentGcOptions {
  roots: string[];
  sources: string[];
  graceMs?: number;
  now?: number;
  /** Must only be set while all writers using these roots/sources are stopped. */
  offline?: boolean;
  apply?: boolean;
}
export interface AttachmentGcReport {
  references: number;
  objects: number;
  objectBytes: number;
  orphanReferences: number;
  candidateReferences: number;
  candidateObjects: number;
  reclaimableBytes: number;
  removedReferences: number;
  removedObjects: number;
  dryRun: boolean;
}

/** Offline mark/sweep. The caller must supply every reference source, including backups to retain. */
export async function collectAttachmentGarbage(options: AttachmentGcOptions): Promise<AttachmentGcReport> {
  if (options.apply && !options.offline) throw new Error('Stop all attachment/session writers and specify offline before applying GC.');
  const graceMs = options.graceMs ?? DEFAULT_ATTACHMENT_GRACE_MS;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(graceMs) || graceMs < 0 || !Number.isFinite(now)) throw new Error('Invalid GC time or grace period');
  if (!options.roots.length) throw new Error('At least one attachment root is required');
  const marked = await scanAttachmentReferences(options.sources);
  const refs: Candidate[] = [];
  const objects: Candidate[] = [];
  const report: AttachmentGcReport = { references: 0, objects: 0, objectBytes: 0, orphanReferences: 0,
    candidateReferences: 0, candidateObjects: 0, reclaimableBytes: 0, removedReferences: 0, removedObjects: 0, dryRun: !options.apply };
  const old = (info: { mtimeMs: number; ctimeMs: number }) => Math.max(info.mtimeMs, info.ctimeMs) <= now - graceMs;
  const removalsByInode = new Map<string, number>();
  const inode = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`;
  async function entries(directory: string) {
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error(`Unsafe attachment directory: ${directory}`);
      return await readdir(directory, { withFileTypes: true });
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []; throw cause; }
  }
  for (const root of new Set(options.roots.map((root) => path.resolve(root)))) {
    if (!(await lstat(root)).isDirectory()) throw new Error(`Unsafe attachment root: ${root}`);
    for (const layout of ['refs', 'files']) {
      for (const entry of await entries(path.join(root, layout))) {
        // Staging cleanup is deliberately deferred: it may contain an interrupted producer's state.
        if (entry.name.startsWith('.pending-')) continue;
        if (!entry.isDirectory() || !idPattern.test(entry.name)) throw new Error(`Unknown attachment entry: ${entry.name}`);
        const directory = path.join(root, layout, entry.name);
        const metadataPath = path.join(directory, 'metadata.json');
        if (!(await lstat(metadataPath)).isFile()) throw new Error(`Unsafe metadata: ${metadataPath}`);
        const { schemaVersion, ...data } = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (layout === 'refs' ? schemaVersion !== 2 : schemaVersion !== undefined && schemaVersion !== 1) throw new Error('Unsupported attachment metadata version');
        const ref = FileAttachmentRefSchema.parse(data);
        if (ref.attachmentId !== entry.name || (layout === 'refs' && !ref.digest)) throw new Error('Corrupted attachment metadata');
        if (path.basename(ref.name) !== ref.name || ref.name.includes('\\')) throw new Error('Unsafe attachment name');
        const originals = path.join(directory, 'original');
        if (!(await lstat(originals)).isDirectory()) throw new Error('Unsafe original directory');
        const info = await lstat(path.join(originals, ref.name));
        if (!info.isFile() || info.size !== ref.bytes) throw new Error('Corrupted original attachment');
        const expectedObject = layout === 'refs'
          ? path.join(root, 'objects', ref.digest!.slice(7, 9), ref.digest!.slice(7))
          : path.join(root, 'objects', ref.attachmentId);
        const objectInfo = await lstat(expectedObject);
        if (!objectInfo.isFile() || inode(objectInfo) !== inode(info)) throw new Error('Corrupted attachment object link');
        report.references++;
        if (marked.has(ref.attachmentId)) continue;
        report.orphanReferences++;
        const dirInfo = await lstat(directory);
        if (!old(dirInfo) || !old(await lstat(metadataPath))) continue;
        refs.push({ path: directory, bytes: ref.bytes, ...dirInfo });
        removalsByInode.set(inode(info), (removalsByInode.get(inode(info)) ?? 0) + 1);
      }
    }
    async function inspectObject(filePath: string): Promise<void> {
      const info = await lstat(filePath);
      if (!info.isFile()) throw new Error(`Unsafe object: ${filePath}`);
      report.objects++; report.objectBytes += info.size;
      // Count actual hard links as well as metadata: surviving refs, staging and external links protect objects.
      if (old(info) && info.nlink - (removalsByInode.get(inode(info)) ?? 0) === 1) objects.push({ path: filePath, bytes: info.size, ...info });
    }
    for (const entry of await entries(path.join(root, 'objects'))) {
      if (entry.isFile() && idPattern.test(entry.name)) await inspectObject(path.join(root, 'objects', entry.name));
      else if (entry.isDirectory() && /^[0-9a-f]{2}$/u.test(entry.name)) {
        for (const object of await entries(path.join(root, 'objects', entry.name))) {
          if (!/^[0-9a-f]{64}$/u.test(object.name) || !object.name.startsWith(entry.name)) throw new Error('Unknown digest object');
          await inspectObject(path.join(root, 'objects', entry.name, object.name));
        }
      } else throw new Error(`Unknown object entry: ${entry.name}`);
    }
  }
  report.candidateReferences = refs.length;
  report.candidateObjects = objects.length;
  report.reclaimableBytes = objects.reduce((sum, item) => sum + item.bytes, 0);
  if (!options.apply) return report;
  // Finish all validation before the first deletion. Offline mode is a caller guarantee, not a process lock.
  for (const item of [...refs, ...objects]) {
    const info = await lstat(item.path);
    if (info.dev !== item.dev || info.ino !== item.ino || info.mtimeMs !== item.mtimeMs || info.ctimeMs !== item.ctimeMs) throw new Error('Attachment changed during GC; stop all writers');
  }
  for (const item of refs) { await rm(item.path, { recursive: true }); report.removedReferences++; }
  for (const item of objects) {
    const info = await lstat(item.path);
    if (info.isFile() && info.dev === item.dev && info.ino === item.ino && info.nlink === 1) {
      await rm(item.path); report.removedObjects++;
    }
  }
  return report;
}

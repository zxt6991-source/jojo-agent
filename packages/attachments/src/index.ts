import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, lstatSync, readFileSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileAttachmentRefSchema, MAX_FILE_BYTES, type AttachmentId, type FileAttachmentRef } from '@desktop-agent/contracts';

export interface SaveAttachmentInput { path: string; name?: string; signal?: AbortSignal }
export interface SaveAttachmentStreamInput {
  name: string;
  stream: AsyncIterable<Uint8Array>;
  expectedBytes?: number;
  signal?: AbortSignal;
}
export class AttachmentStoreError extends Error {
  constructor(
    readonly code: 'ATTACHMENT_STORE_FAILED' | 'ATTACHMENT_TOO_LARGE' | 'ATTACHMENT_CANCELLED' | 'ATTACHMENT_CORRUPTED',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AttachmentStoreError';
  }
}
function storeError(cause: unknown, signal?: AbortSignal): AttachmentStoreError {
  if (signal?.aborted) return new AttachmentStoreError('ATTACHMENT_CANCELLED', 'Attachment import cancelled', { cause });
  if (cause instanceof AttachmentStoreError) return cause;
  return new AttachmentStoreError('ATTACHMENT_STORE_FAILED', cause instanceof Error ? cause.message : String(cause), { cause });
}
function checkSize(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid attachment byte count');
  if (bytes > MAX_FILE_BYTES) throw new AttachmentStoreError('ATTACHMENT_TOO_LARGE', 'Attachment exceeds 512 MB');
}
export interface AttachmentStore {
  saveStream(input: SaveAttachmentStreamInput): Promise<FileAttachmentRef>;
  saveFile(input: SaveAttachmentInput): Promise<FileAttachmentRef>;
  openFile(id: AttachmentId, options?: { strict?: boolean; signal?: AbortSignal }): Promise<NodeJS.ReadableStream>;
  getPath(id: AttachmentId): Promise<string | undefined>;
  getMetadata(id: AttachmentId): Promise<FileAttachmentRef>;
  exists(id: AttachmentId): Promise<boolean>;
  verify(id: AttachmentId, signal?: AbortSignal): Promise<{ digest: string; verified: boolean }>;
}

/** Do not let an uncooperative producer's pending next() prevent cancellation. */
async function* cancellableBytes(source: AsyncIterable<Uint8Array>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      signal.throwIfAborted();
      let abort!: () => void;
      const interrupted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      let next: IteratorResult<Uint8Array>;
      try { next = await Promise.race([iterator.next(), interrupted]); }
      finally { signal.removeEventListener('abort', abort); }
      if (next.done) { finished = true; return; }
      yield next.value;
    }
  } finally {
    if (!finished) {
      // Node streams can be actively closed; generic producers must implement return/signal cleanup.
      if ('destroy' in source && typeof source.destroy === 'function') source.destroy();
      try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* preserve the import failure */ }
    }
  }
}

export function sanitizeAttachmentName(name: string): string {
  const base = Array.from(path.posix.basename(name.replaceAll('\\', '/')), (character) =>
    character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? '_' : character).join('');
  const safe = base === '.' || base === '..' || !base ? 'attachment' : base;
  // Keep the filename within filesystem byte limits, including Unicode names.
  let result = '';
  for (const character of safe) {
    if (Buffer.byteLength(result + character) > 240) break;
    result += character;
  }
  return result;
}

export const defaultAttachmentRoot = (): string => process.env.JOJO_ATTACHMENT_ROOT ? path.resolve(process.env.JOJO_ATTACHMENT_ROOT) : path.join(homedir(), '.jojo', 'attachments', 'v2');
const defaultLegacyRoot = (): string => path.join(homedir(), '.jojo', 'attachments', 'v1');
function validateId(id: AttachmentId): void {
  if (!/^att_[0-9a-f-]{36}$/u.test(id)) throw new Error('Invalid attachment ID');
}
function corrupted(): AttachmentStoreError {
  return new AttachmentStoreError('ATTACHMENT_CORRUPTED', 'Corrupted attachment');
}
function objectPath(root: string, digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) throw corrupted();
  const hash = digest.slice(7);
  return path.join(root, 'objects', hash.slice(0, 2), hash);
}
function parseMetadata(raw: string, id: AttachmentId, version: 1 | 2): FileAttachmentRef {
  try {
    const { schemaVersion, ...data } = JSON.parse(raw);
    if (version === 2 ? schemaVersion !== 2 : schemaVersion !== undefined && schemaVersion !== 1) throw corrupted();
    const ref = FileAttachmentRefSchema.parse(data);
    if (ref.attachmentId !== id || (version === 2 && !ref.digest)) throw corrupted();
    return ref;
  } catch { throw corrupted(); }
}
function locations(root: string, legacyRoot: string | undefined, id: AttachmentId) {
  validateId(id);
  return [
    { root, directory: path.join(root, 'refs', id), version: 2 as const },
    { root, directory: path.join(root, 'files', id), version: 1 as const },
    ...(legacyRoot && legacyRoot !== root ? [{ root: legacyRoot, directory: path.join(legacyRoot, 'files', id), version: 1 as const }] : [])
  ];
}
async function hashFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { ...(signal ? { signal } : {}) });
  for await (const chunk of stream) hash.update(chunk);
  return `sha256:${hash.digest('hex')}`;
}

/** A resource is published only after both the bytes and metadata have been written. */
export class LocalAttachmentStore implements AttachmentStore {
  constructor(
    readonly root = defaultAttachmentRoot(),
    readonly legacyRoot = !process.env.JOJO_ATTACHMENT_ROOT && root === defaultAttachmentRoot() ? defaultLegacyRoot() : undefined
  ) {}

  private async locate(id: AttachmentId) {
    for (const location of locations(this.root, this.legacyRoot, id)) {
      let raw: string;
      try { raw = await readFile(path.join(location.directory, 'metadata.json'), 'utf8'); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw cause;
      }
      return { ...location, ref: parseMetadata(raw, id, location.version) };
    }
    return undefined;
  }

  async saveFile(input: SaveAttachmentInput): Promise<FileAttachmentRef> {
    try {
      input.signal?.throwIfAborted();
      const source = await lstat(input.path);
      if (!source.isFile()) throw new Error('Only regular files may be attached');
      // Reject a symlink swapped in after lstat, and verify the opened inode.
      const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== source.dev || opened.ino !== source.ino) throw new Error('Source changed during attachment import');
        checkSize(opened.size);
        const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
        try {
          return await this.saveStream({
            name: input.name ?? input.path, stream, expectedBytes: opened.size,
            ...(input.signal ? { signal: input.signal } : {})
          });
        } finally { stream.destroy(); }
      } finally { await handle.close(); }
    } catch (cause) { throw storeError(cause, input.signal); }
  }

  async saveStream(input: SaveAttachmentStreamInput): Promise<FileAttachmentRef> {
    const id = `att_${randomUUID()}`;
    const name = sanitizeAttachmentName(input.name);
    const extension = path.extname(name).slice(1).toLowerCase();
    const directory = path.join(this.root, 'refs', id);
    const staging = path.join(this.root, 'refs', `.pending-${id}`);
    const temporary = path.join(staging, 'bytes');
    let ownsStaging = false;
    try {
      input.signal?.throwIfAborted();
      if (input.expectedBytes !== undefined) checkSize(input.expectedBytes);
      await mkdir(path.join(this.root, 'objects'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(this.root, 'refs'), { recursive: true, mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      ownsStaging = true;
      await mkdir(path.join(staging, 'original'), { mode: 0o700 });
      let bytes = 0;
      const hash = createHash('sha256');
      // Pipeline propagates backpressure, abort and producer/disk errors. Never buffer the whole resource.
      const controller = new AbortController();
      const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
      const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      output.once('error', (cause) => controller.abort(cause));
      await pipeline(cancellableBytes(input.stream, signal), async function* (source) {
        for await (const chunk of source) {
          input.signal?.throwIfAborted();
          if (!(chunk instanceof Uint8Array)) throw new Error('Attachment stream must contain bytes');
          bytes += chunk.byteLength;
          checkSize(bytes);
          if (input.expectedBytes !== undefined && bytes > input.expectedBytes) throw new Error('Source length mismatch');
          // Bound individual writes even when a producer supplies a large chunk.
          for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
            const part = Buffer.from(chunk.subarray(offset, offset + 64 * 1024));
            hash.update(part);
            yield part;
          }
        }
      }, output, { signal });
      if (input.expectedBytes !== undefined && bytes !== input.expectedBytes) throw new Error('Source length mismatch');
      input.signal?.throwIfAborted();
      const file = await open(temporary, 'r+');
      try { await file.chmod(0o444); await file.sync(); } finally { await file.close(); }
      const digest = `sha256:${hash.digest('hex')}`;
      const object = objectPath(this.root, digest);
      const ref: FileAttachmentRef = { type: 'file', attachmentId: id, digest, name, bytes, ...(extension ? { extension } : {}) };
      const metadata = await open(path.join(staging, 'metadata.json'), 'wx', 0o400);
      try { await metadata.writeFile(JSON.stringify({ schemaVersion: 2, ...ref })); await metadata.sync(); } finally { await metadata.close(); }
      await mkdir(path.dirname(object), { recursive: true, mode: 0o700 });
      try { await link(temporary, object); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        const existing = await lstat(object);
        if (!existing.isFile() || existing.size !== bytes || (existing.mode & 0o222) !== 0
          || await hashFile(object, input.signal) !== digest) throw corrupted();
      }
      // link is an atomic no-clobber publish across processes. Never overwrite an existing object.
      await link(object, path.join(staging, 'original', name));
      await rm(temporary);
      input.signal?.throwIfAborted();
      // Commit point: successful rename publishes the complete ref, even if cancellation arrives afterward.
      await rename(staging, directory);
      return ref;
    } catch (cause) {
      const cleanup = await Promise.allSettled([
        ...(ownsStaging ? [rm(staging, { recursive: true, force: true })] : [])
      ]);
      const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AttachmentStoreError('ATTACHMENT_STORE_FAILED', 'Attachment import failed and staging cleanup was incomplete', {
        cause: new AggregateError([cause, ...failures.map((result) => result.reason)])
      });
      throw storeError(cause, input.signal);
    }
  }

  async getMetadata(id: AttachmentId): Promise<FileAttachmentRef> {
    const resource = await this.locate(id);
    if (!resource) throw new Error('Attachment is missing');
    return resource.ref;
  }
  async getPath(id: AttachmentId): Promise<string | undefined> {
    const resource = await this.locate(id);
    if (!resource) return undefined;
    const filePath = path.join(resource.directory, 'original', sanitizeAttachmentName(resource.ref.name));
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.size !== resource.ref.bytes) throw corrupted();
      if (resource.version === 2) {
        const object = await lstat(objectPath(resource.root, resource.ref.digest!));
        if (!object.isFile() || object.size !== info.size || object.dev !== info.dev || object.ino !== info.ino) throw corrupted();
      }
      return filePath;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
  }
  async exists(id: AttachmentId): Promise<boolean> { return (await this.getPath(id)) !== undefined; }
  async verify(id: AttachmentId, signal?: AbortSignal): Promise<{ digest: string; verified: boolean }> {
    signal?.throwIfAborted();
    const ref = await this.getMetadata(id);
    const filePath = await this.getPath(id);
    if (!filePath) throw new Error('Attachment is missing');
    const digest = await hashFile(filePath, signal);
    if (ref.digest && ref.digest !== digest) throw corrupted();
    return { digest, verified: Boolean(ref.digest) };
  }
  async openFile(id: AttachmentId, options: { strict?: boolean; signal?: AbortSignal } = {}): Promise<NodeJS.ReadableStream> {
    if (options.strict) await this.verify(id, options.signal);
    const filePath = await this.getPath(id);
    if (!filePath) throw new Error('Attachment is missing');
    return createReadStream(filePath, { ...(options.signal ? { signal: options.signal } : {}) });
  }
}

/** Compatibility helper; providers use request-scoped AttachmentAccessResolver instead. */
export function resolveAttachmentPath(id: AttachmentId, root = defaultAttachmentRoot()): string | undefined {
  try {
    const legacyRoot = !process.env.JOJO_ATTACHMENT_ROOT && root === defaultAttachmentRoot() ? defaultLegacyRoot() : undefined;
    for (const location of locations(root, legacyRoot, id)) {
      let raw: string;
      try { raw = readFileSync(path.join(location.directory, 'metadata.json'), 'utf8'); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; throw cause; }
      const ref = parseMetadata(raw, id, location.version);
      const filePath = path.join(location.directory, 'original', sanitizeAttachmentName(ref.name));
      const info = lstatSync(filePath);
      if (!info.isFile() || info.size !== ref.bytes) return undefined;
      if (location.version === 2) {
        const object = lstatSync(objectPath(location.root, ref.digest!));
        if (!object.isFile() || object.size !== info.size || object.dev !== info.dev || object.ino !== info.ino) return undefined;
      }
      return filePath;
    }
  } catch { /* Compatibility API represents unavailable or corrupted resources as undefined. */ }
  return undefined;
}

export { collectAttachmentGarbage, scanAttachmentReferences, DEFAULT_ATTACHMENT_GRACE_MS } from './lifecycle';
export type { AttachmentGcOptions, AttachmentGcReport } from './lifecycle';

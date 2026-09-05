import { randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { FileAttachmentRefSchema, MAX_FILE_BYTES, type AttachmentId, type FileAttachmentRef } from '@desktop-agent/contracts';

export interface SaveAttachmentInput { path: string; name?: string }
export interface AttachmentStore {
  saveFile(input: SaveAttachmentInput): Promise<FileAttachmentRef>;
  openFile(id: AttachmentId): Promise<NodeJS.ReadableStream>;
  getPath(id: AttachmentId): Promise<string | undefined>;
  getMetadata(id: AttachmentId): Promise<FileAttachmentRef>;
  exists(id: AttachmentId): Promise<boolean>;
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

export const defaultAttachmentRoot = (): string => process.env.JOJO_ATTACHMENT_ROOT ? path.resolve(process.env.JOJO_ATTACHMENT_ROOT) : path.join(homedir(), '.jojo', 'attachments', 'v1');
function validateId(id: AttachmentId): void {
  if (!/^att_[0-9a-f-]{36}$/u.test(id)) throw new Error('Invalid attachment ID');
}
function metadataPath(root: string, id: AttachmentId): string {
  validateId(id);
  return path.join(root, 'files', id, 'metadata.json');
}
function resourcePath(root: string, ref: FileAttachmentRef): string {
  validateId(ref.attachmentId);
  return path.join(root, 'files', ref.attachmentId, 'original', sanitizeAttachmentName(ref.name));
}
function parseMetadata(raw: string, id: AttachmentId): FileAttachmentRef {
  const ref = FileAttachmentRefSchema.parse(JSON.parse(raw));
  if (ref.attachmentId !== id) throw new Error('Corrupted attachment metadata');
  return ref;
}

/** A resource is published only after both the bytes and metadata have been written. */
export class LocalAttachmentStore implements AttachmentStore {
  constructor(readonly root = defaultAttachmentRoot()) {}

  async saveFile(input: SaveAttachmentInput): Promise<FileAttachmentRef> {
    const source = await lstat(input.path);
    if (!source.isFile()) throw new Error('Only regular files may be attached');
    if (source.size > MAX_FILE_BYTES) throw new Error('Attachment exceeds 512 MB');
    const id = `att_${randomUUID()}`;
    const name = sanitizeAttachmentName(input.name ?? input.path);
    const extension = path.extname(name).slice(1).toLowerCase();
    const object = path.join(this.root, 'objects', id);
    const directory = path.join(this.root, 'files', id);
    const staging = path.join(this.root, 'files', `.pending-${id}`);
    await mkdir(path.join(this.root, 'objects'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(staging, 'original'), { recursive: true, mode: 0o700 });
    try {
      // copyFile copies in the OS without loading the file into JS memory.
      await copyFile(input.path, object);
      const copied = await stat(object);
      if (copied.size !== source.size || copied.size > MAX_FILE_BYTES) throw new Error('Source changed during attachment import');
      await chmod(object, 0o444);
      await link(object, path.join(staging, 'original', name));
      const ref: FileAttachmentRef = { type: 'file', attachmentId: id, name, bytes: copied.size, ...(extension ? { extension } : {}) };
      await writeFile(path.join(staging, 'metadata.json'), JSON.stringify(ref), { mode: 0o400, flag: 'wx' });
      await rename(staging, directory);
      return ref;
    } catch (cause) {
      await rm(staging, { recursive: true, force: true });
      await rm(object, { force: true });
      throw cause;
    }
  }

  async getMetadata(id: AttachmentId): Promise<FileAttachmentRef> {
    return parseMetadata(await readFile(metadataPath(this.root, id), 'utf8'), id);
  }
  async getPath(id: AttachmentId): Promise<string | undefined> {
    try {
      const ref = await this.getMetadata(id);
      const filePath = resourcePath(this.root, ref);
      const info = await lstat(filePath);
      if (!info.isFile() || info.size !== ref.bytes) throw new Error('Corrupted attachment');
      return filePath;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw cause;
    }
  }
  async exists(id: AttachmentId): Promise<boolean> { return (await this.getPath(id)) !== undefined; }
  async openFile(id: AttachmentId): Promise<NodeJS.ReadableStream> {
    const filePath = await this.getPath(id);
    if (!filePath) throw new Error('Attachment is missing');
    return createReadStream(filePath);
  }
}

/** Resolve only store metadata, never a filesystem path supplied in a message. */
export function resolveAttachmentPath(id: AttachmentId, root = defaultAttachmentRoot()): string | undefined {
  try {
    const ref = parseMetadata(readFileSync(metadataPath(root, id), 'utf8'), id);
    const filePath = resourcePath(root, ref);
    const info = lstatSync(filePath);
    return info.isFile() && info.size === ref.bytes ? filePath : undefined;
  } catch { return undefined; }
}

import { afterEach, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileAttachmentRefSchema } from '@desktop-agent/contracts';
import { LocalAttachmentStore, resolveAttachmentPath } from '../src';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'digest-store-'));
  roots.push(root);
  return new LocalAttachmentStore(root);
}
const save = (store: LocalAttachmentStore, name = 'report.bin', bytes = 'abc') => store.saveStream({ name, stream: Readable.from([Buffer.from(bytes)]) });
const object = (store: LocalAttachmentStore, digest: string) => path.join(store.root, 'objects', digest.slice(7, 9), digest.slice(7));

it('deduplicates concurrent uploads across store instances while keeping names and IDs independent', async () => {
  const store = await setup();
  const refs = await Promise.all(Array.from({ length: 8 }, (_, i) => save(new LocalAttachmentStore(store.root), `file-${i}.txt`)));
  expect(new Set(refs.map((ref) => ref.attachmentId)).size).toBe(8);
  const digest = `sha256:${createHash('sha256').update('abc').digest('hex')}`;
  expect(new Set(refs.map((ref) => ref.digest))).toEqual(new Set([digest]));
  const info = await stat(object(store, digest));
  expect(info.nlink).toBe(9);
  expect(info.mode & 0o222).toBe(0);
  for (const ref of refs) {
    const original = (await store.getPath(ref.attachmentId))!;
    expect(path.basename(original)).toBe(ref.name);
    expect((await stat(original)).ino).toBe(info.ino);
    expect(await store.verify(ref.attachmentId)).toEqual({ digest, verified: true });
    expect(JSON.parse(await readFile(path.join(store.root, 'refs', ref.attachmentId, 'metadata.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, digest });
  }
});

it('hashes empty and different content and exposes digest through contracts', async () => {
  const store = await setup();
  const empty = await save(store, 'empty', '');
  expect(empty.digest).toBe(`sha256:${createHash('sha256').digest('hex')}`);
  expect((await save(store)).digest).not.toBe(empty.digest);
  expect(FileAttachmentRefSchema.parse(empty).digest).toBe(empty.digest);
  expect(() => FileAttachmentRefSchema.parse({ ...empty, digest: '../../bad' })).toThrow();
});

it('detects same-size corruption in strict reads and refuses reuse of a corrupt object', async () => {
  const store = await setup();
  const ref = await save(store);
  const file = object(store, ref.digest!);
  await chmod(file, 0o600);
  await writeFile(file, 'xyz');
  await chmod(file, 0o444);
  expect(await store.getPath(ref.attachmentId)).toBeDefined(); // fast path does not rehash
  await expect(store.verify(ref.attachmentId)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPTED' });
  await expect(store.openFile(ref.attachmentId, { strict: true })).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPTED' });
  await expect(save(store)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPTED' });
  expect(await readFile(file, 'utf8')).toBe('xyz');
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([ref.attachmentId]);
});

it('rejects metadata digest mismatches even when the other object has the same size', async () => {
  const store = await setup();
  const first = await save(store);
  const second = await save(store, 'other', 'xyz');
  const metadata = path.join(store.root, 'refs', first.attachmentId, 'metadata.json');
  await chmod(metadata, 0o600);
  await writeFile(metadata, JSON.stringify({ schemaVersion: 2, ...first, digest: second.digest }));
  await expect(store.getPath(first.attachmentId)).rejects.toMatchObject({ code: 'ATTACHMENT_CORRUPTED' });
  expect(resolveAttachmentPath(first.attachmentId, store.root)).toBeUndefined();
});

async function legacy(root: string) {
  const ref = { type: 'file' as const, attachmentId: `att_${randomUUID()}`, name: 'legacy.txt', bytes: 3 };
  const dir = path.join(root, 'files', ref.attachmentId);
  await mkdir(path.join(dir, 'original'), { recursive: true });
  await mkdir(path.join(root, 'objects'), { recursive: true });
  await writeFile(path.join(root, 'objects', ref.attachmentId), 'old', { mode: 0o444 });
  await link(path.join(root, 'objects', ref.attachmentId), path.join(dir, 'original', ref.name));
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(ref));
  return ref;
}

it('reads historical v1 refs alongside v2 without rewriting old bytes or metadata', async () => {
  const store = await setup();
  const ref = await legacy(store.root);
  const metadata = path.join(store.root, 'files', ref.attachmentId, 'metadata.json');
  const before = await readFile(metadata);
  const newer = await save(store);
  expect(newer.digest).toBeDefined();
  expect(await store.getMetadata(ref.attachmentId)).toEqual(ref);
  expect(await readFile((await store.getPath(ref.attachmentId))!, 'utf8')).toBe('old');
  expect(resolveAttachmentPath(ref.attachmentId, store.root)).toBe(await store.getPath(ref.attachmentId));
  expect(await store.verify(ref.attachmentId)).toMatchObject({ verified: false });
  expect(await readFile(metadata)).toEqual(before);
});

it('supports a separate legacy root and keeps explicit environment roots compatible', async () => {
  const store = await setup();
  const oldRoot = path.join(store.root, 'v1');
  const ref = await legacy(oldRoot);
  const migrated = new LocalAttachmentStore(path.join(store.root, 'v2'), oldRoot);
  expect(await readFile((await migrated.getPath(ref.attachmentId))!, 'utf8')).toBe('old');
  vi.stubEnv('JOJO_ATTACHMENT_ROOT', oldRoot);
  const configured = new LocalAttachmentStore();
  expect(await configured.exists(ref.attachmentId)).toBe(true);
  expect((await save(configured)).digest).toBeDefined();
});

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { collectAttachmentGarbage, LocalAttachmentStore, scanAttachmentReferences } from '../src';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'attachment-gc-'));
  roots.push(root);
  const sessions = path.join(root, 'sessions');
  await mkdir(sessions);
  const store = new LocalAttachmentStore(path.join(root, 'attachments'));
  const save = (name: string, content = name) => store.saveStream({ name, stream: Readable.from([Buffer.from(content)]) });
  return { root, sessions, store, save };
}

it('previews without mutation, protects referenced/shared objects, and removes only old orphan refs', async () => {
  const { sessions, store, save } = await setup();
  const kept = await save('kept', 'shared');
  const shared = await save('orphan-shared', 'shared');
  const orphan = await save('orphan');
  await writeFile(path.join(sessions, 'branch.jsonl'), JSON.stringify({ entry: { message: { content: [{ type: 'file', attachment: kept }] } } }) + '\n');
  const options = { roots: [store.root], sources: [sessions], now: Date.now() + 8 * 86_400_000 };
  const preview = await collectAttachmentGarbage(options);
  expect(preview).toMatchObject({ references: 3, objects: 2, candidateReferences: 2, candidateObjects: 1, removedReferences: 0, dryRun: true });
  expect(await store.exists(orphan.attachmentId)).toBe(true);
  const result = await collectAttachmentGarbage({ ...options, apply: true, offline: true });
  expect(result).toMatchObject({ removedReferences: 2, removedObjects: 1 });
  expect(await store.verify(kept.attachmentId)).toMatchObject({ verified: true });
  expect(await store.exists(shared.attachmentId)).toBe(false);
  expect(await store.exists(orphan.attachmentId)).toBe(false);
});

it('honors grace and releases resources after their session is deleted', async () => {
  const { sessions, store, save } = await setup();
  const ref = await save('draft');
  const options = { roots: [store.root], sources: [sessions] };
  expect(await collectAttachmentGarbage(options)).toMatchObject({ orphanReferences: 1, candidateReferences: 0, candidateObjects: 0 });
  const journal = path.join(sessions, 'session.jsonl');
  await writeFile(journal, JSON.stringify({ attachmentId: ref.attachmentId }));
  const later = { ...options, now: Date.now() + 8 * 86_400_000 };
  expect(await collectAttachmentGarbage(later)).toMatchObject({ candidateReferences: 0 });
  await rm(journal);
  expect(await collectAttachmentGarbage({ ...later, apply: true, offline: true })).toMatchObject({ removedReferences: 1, removedObjects: 1 });
});

it('aborts before deletion for corrupt/missing reference sources and requires offline assertion', async () => {
  const { sessions, store, save } = await setup();
  const ref = await save('safe');
  const options = { roots: [store.root], sources: [sessions], graceMs: 0, apply: true, offline: true };
  await expect(collectAttachmentGarbage({ ...options, offline: false })).rejects.toThrow(/Stop all/);
  await writeFile(path.join(sessions, 'broken.jsonl'), '{incomplete');
  await expect(collectAttachmentGarbage(options)).rejects.toThrow();
  await expect(collectAttachmentGarbage({ ...options, sources: ['/nonexistent-attachment-sessions'] })).rejects.toThrow();
  expect(await store.exists(ref.attachmentId)).toBe(true);
});

it('scans every SQLite entry and operation plus nested JSONL branches and backups', async () => {
  const { root, sessions } = await setup();
  const file = path.join(root, 'runtime.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sessions(metadata_json TEXT); CREATE TABLE entries(payload_json TEXT); CREATE TABLE operations(meta_json TEXT, state_json TEXT)');
  db.prepare('INSERT INTO entries VALUES (?)').run(JSON.stringify({ message: { attachmentId: 'from-branch' } }));
  db.prepare('INSERT INTO operations VALUES (?, ?)').run('{}', JSON.stringify({ input: { attachmentId: 'from-recovery' } }));
  db.close();
  await mkdir(path.join(sessions, 'backup'));
  await writeFile(path.join(sessions, 'backup', 'old.jsonl'), JSON.stringify({ attachmentId: 'from-backup' }));
  expect(await scanAttachmentReferences([sessions, file])).toEqual(new Set(['from-branch', 'from-recovery', 'from-backup']));
  const bad = path.join(root, 'unrelated.sqlite');
  new DatabaseSync(bad).close();
  await expect(scanAttachmentReferences([bad])).rejects.toThrow();
});

it('fails closed on damaged attachment metadata', async () => {
  const { sessions, store, save } = await setup();
  const ref = await save('safe');
  const metadata = path.join(store.root, 'refs', ref.attachmentId, 'metadata.json');
  const { chmod } = await import('node:fs/promises');
  await chmod(metadata, 0o600);
  await writeFile(metadata, '{}');
  await expect(collectAttachmentGarbage({ roots: [store.root], sources: [sessions], graceMs: 0, apply: true, offline: true })).rejects.toThrow();
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([ref.attachmentId]);
});

it('collects v1 refs and unlinked objects but protects objects linked from staging', async () => {
  const { sessions, store, save } = await setup();
  const ref = await save('staged');
  const { link } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const staging = path.join(store.root, 'refs', '.pending-test');
  await mkdir(staging);
  await link((await store.getPath(ref.attachmentId))!, path.join(staging, 'bytes'));
  const legacyId = `att_${randomUUID()}`;
  const legacyObject = path.join(store.root, 'objects', legacyId);
  const dir = path.join(store.root, 'files', legacyId);
  await mkdir(path.join(dir, 'original'), { recursive: true });
  await writeFile(legacyObject, 'old');
  await link(legacyObject, path.join(dir, 'original', 'old.txt'));
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ type: 'file', attachmentId: legacyId, name: 'old.txt', bytes: 3 }));
  const orphanId = `att_${randomUUID()}`;
  await writeFile(path.join(store.root, 'objects', orphanId), 'orphan');
  const report = await collectAttachmentGarbage({ roots: [store.root], sources: [sessions], now: Date.now() + 8 * 86_400_000, apply: true, offline: true });
  expect(report).toMatchObject({ removedReferences: 2, removedObjects: 2 });
  expect(await readdir(staging)).toEqual(['bytes']);
  expect(await readdir(path.join(store.root, 'objects', ref.digest!.slice(7, 9)))).toEqual([ref.digest!.slice(7)]);
});

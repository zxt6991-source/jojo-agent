import { mkdtemp, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { JsonlSessionStore, SqliteServerStateStore } from '@desktop-agent/storage';
import { DesktopSessionMetadataStore } from './session-metadata';

it('imports legacy titles once and shares subsequent changes across Main, Worker and application metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-metadata-'));
  const legacyDirectory = path.join(directory, 'sessions');
  const database = path.join(directory, 'application.sqlite');
  const legacy = new JsonlSessionStore(legacyDirectory);
  const original = await legacy.create('legacy title', directory);
  const main = new DesktopSessionMetadataStore(legacyDirectory, database);
  const worker = new DesktopSessionMetadataStore(legacyDirectory, database);
  const before = await readFile(path.join(legacyDirectory, `${original.id}.jsonl`), 'utf8');
  expect((await main.get(original.id))?.title).toBe('legacy title');
  expect((await main.get(original.id))?.updatedAt).toBe(original.updatedAt);
  await worker.rename(original.id, 'worker title');
  expect((await main.list())[0]?.title).toBe('worker title');
  expect(await readFile(path.join(legacyDirectory, `${original.id}.jsonl`), 'utf8')).toBe(before);
  const state = new SqliteServerStateStore(database);
  try {
    expect(await state.sessions.get(original.id)).toMatchObject({ title: 'worker title' });
    await state.sessions.patch(original.id, { title: 'application title' });
    expect((await worker.get(original.id))?.title).toBe('application title');
    await state.sessions.patch(original.id, { title: null });
    expect((await main.get(original.id))?.title).toBe('新会话');
    expect((await worker.list())[0]?.title).toBe('新会话');
    await main.delete(original.id);
    state.deleteSessionPermanently(original.id);
    expect(await worker.get(original.id)).toBeNull();
    await expect(worker.rename(original.id, 'resurrect')).rejects.toThrow('session_unavailable');
    expect(await state.sessions.get(original.id)).toBeUndefined();
  } finally { await state.close(); }
});

it('preserves existing application titles during legacy import and indexes newly created sessions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-metadata-existing-'));
  const database = path.join(directory, 'application.sqlite');
  const legacyDirectory = path.join(directory, 'sessions');
  const legacy = new JsonlSessionStore(legacyDirectory);
  const original = await legacy.create('obsolete', directory);
  const state = new SqliteServerStateStore(database);
  try {
    await state.sessions.ensureActive({ sessionId: original.id, title: 'current' });
    const metadata = new DesktopSessionMetadataStore(legacyDirectory, database);
    expect((await metadata.get(original.id))?.title).toBe('current');
    const created = await metadata.create('new title', directory);
    expect(await state.sessions.get(created.id)).toMatchObject({ title: 'new title' });
  } finally { await state.close(); }
});

it('shares project binding without JSONL writes, including the first transcript migration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-project-metadata-'));
  const legacyDirectory = path.join(directory, 'sessions');
  const database = path.join(directory, 'application.sqlite');
  const main = new DesktopSessionMetadataStore(legacyDirectory, database);
  const worker = new DesktopSessionMetadataStore(legacyDirectory, database);
  const original = await main.create('project session', directory, undefined, false);
  const file = path.join(legacyDirectory, `${original.id}.jsonl`);
  const before = await readFile(file, 'utf8');
  const project = { id: `prj_${'a'.repeat(64)}`, displayName: 'Bound project', canonicalPath: path.join(directory, 'project') };
  const bound = await main.bindProject(original.id, project.canonicalPath, project);
  expect(bound).toMatchObject({ workingDirectory: project.canonicalPath, projectBound: true, projectIdentity: project });
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await worker.get(original.id)).toMatchObject({ projectIdentity: project, workingDirectory: project.canonicalPath });
  expect((await worker.loadForMigration(original.id)).meta).toMatchObject({ projectIdentity: project, workingDirectory: project.canonicalPath });
  const reopened = new DesktopSessionMetadataStore(legacyDirectory, database);
  expect((await reopened.list())[0]).toMatchObject({ projectIdentity: project });
  const state = new SqliteServerStateStore(database);
  try {
    state.deleteSessionPermanently(original.id);
    await expect(worker.bindProject(original.id, directory, project)).rejects.toThrow('session_unavailable');
  } finally { await state.close(); }
});


it('discovers imported sessions from SQLite when JSONL is absent and sees new sessions from another adapter', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-discovery-'));
  const legacyDirectory = path.join(directory, 'sessions');
  const database = path.join(directory, 'application.sqlite');
  const legacy = new JsonlSessionStore(legacyDirectory);
  const imported = await legacy.create('imported', directory);
  const main = new DesktopSessionMetadataStore(legacyDirectory, database);
  expect((await main.list()).map(meta => meta.id)).toEqual([imported.id]);
  const file = path.join(legacyDirectory, `${imported.id}.jsonl`);
  await rename(file, `${file}.backup`);
  const worker = new DesktopSessionMetadataStore(legacyDirectory, database);
  expect((await worker.list()).map(meta => meta.id)).toEqual([imported.id]);
  await main.rename(imported.id, 'renamed without JSONL');
  expect((await worker.get(imported.id))?.title).toBe('renamed without JSONL');
  const added = await worker.create('second', directory);
  expect((await main.list()).map(meta => meta.id)).toContain(added.id);
  await worker.delete(imported.id);
  // A file tombstone hides stale application rows during interrupted cross-store deletion.
  expect(await main.get(imported.id)).toBeNull();
  expect((await main.list()).map(meta => meta.id)).not.toContain(imported.id);
  await rename(`${file}.backup`, file);
  expect((await new DesktopSessionMetadataStore(legacyDirectory, database).list()).map(meta => meta.id)).not.toContain(imported.id);
});

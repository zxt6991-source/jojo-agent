import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalAttachmentStore, resolveAttachmentPath, sanitizeAttachmentName } from '../src/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'attachment-store-'));
  directories.push(root);
  const source = path.join(root, 'source.bin');
  await writeFile(source, Buffer.from([0, 1, 255, 0, 128]));
  return { root, source, store: new LocalAttachmentStore(path.join(root, 'store')) };
}

describe('LocalAttachmentStore', () => {
  it('persists immutable original bytes, reopens after restart and ignores source deletion', async () => {
    const { source, store } = await setup();
    const ref = await store.saveFile({ path: source, name: '报告.bin' });
    await rm(source);
    const restarted = new LocalAttachmentStore(store.root);
    expect(await restarted.getMetadata(ref.attachmentId)).toEqual(ref);
    const filePath = (await restarted.getPath(ref.attachmentId))!;
    expect(path.basename(filePath)).toBe('报告.bin');
    expect(resolveAttachmentPath(ref.attachmentId, store.root)).toBe(filePath);
    expect((await stat(filePath)).mode & 0o222).toBe(0);
    expect(await readFile(filePath)).toEqual(Buffer.from([0, 1, 255, 0, 128]));
    const chunks: Buffer[] = [];
    for await (const chunk of await restarted.openFile(ref.attachmentId)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 1, 255, 0, 128]));
  });

  it('keeps duplicate names and empty files as independent resources', async () => {
    const { source, store } = await setup();
    const first = await store.saveFile({ path: source });
    await writeFile(source, '');
    const second = await store.saveFile({ path: source });
    expect(first.attachmentId).not.toBe(second.attachmentId);
    expect(second.bytes).toBe(0);
    expect((await readFile((await store.getPath(first.attachmentId))!)).length).toBe(5);
  });

  it('sanitizes names and refuses path traversal through IDs', async () => {
    const { source, store } = await setup();
    const ref = await store.saveFile({ path: source, name: '../../windows\\报告\u0000.txt' });
    expect(ref.name).toBe('报告_.txt');
    expect(sanitizeAttachmentName('..')).toBe('attachment');
    expect(Buffer.byteLength(sanitizeAttachmentName('文'.repeat(255)))).toBeLessThanOrEqual(240);
    await expect(store.getMetadata('../../outside')).rejects.toThrow('Invalid attachment ID');
    expect(resolveAttachmentPath('../../outside', store.root)).toBeUndefined();
  });

  it('distinguishes missing and corrupted resources', async () => {
    const { source, store } = await setup();
    const ref = await store.saveFile({ path: source });
    const filePath = (await store.getPath(ref.attachmentId))!;
    await chmod(filePath, 0o600);
    await writeFile(filePath, 'changed-size');
    await expect(store.getPath(ref.attachmentId)).rejects.toThrow('Corrupted attachment');
    expect(resolveAttachmentPath(ref.attachmentId, store.root)).toBeUndefined();
    await rm(filePath);
    expect(await store.exists(ref.attachmentId)).toBe(false);
    await expect(store.openFile(ref.attachmentId)).rejects.toThrow('missing');
  });
});

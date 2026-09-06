import { afterEach, expect, it, vi } from 'vitest';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, symlink, writeFile, open, rename } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_FILE_BYTES } from '@desktop-agent/contracts';
import { LocalAttachmentStore } from '../src';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) };
});
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), rename: vi.fn(fs.rename) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockClear();
  vi.mocked(rename).mockClear();
  vi.mocked(createWriteStream).mockClear();
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'streaming-attachment-'));
  directories.push(root);
  return new LocalAttachmentStore(root);
}
async function empty(store: LocalAttachmentStore) {
  for (const name of ['refs', 'objects']) {
    expect(await readdir(path.join(store.root, name)).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).toEqual([]);
  }
}
const stream = (...chunks: Uint8Array[]) => Readable.from(chunks);

it.each([0, 1, 100_003])('saves %i bytes from chunks and reopens through the v2 store', async (bytes) => {
  const store = await setup();
  const data = Buffer.alloc(bytes, 123);
  const ref = await store.saveStream({ name: '../报告.bin', expectedBytes: bytes, stream: stream(data.subarray(0, 1), data.subarray(1)) });
  expect(ref).toMatchObject({ bytes, name: '报告.bin' });
  expect(await readFile((await new LocalAttachmentStore(store.root).getPath(ref.attachmentId))!)).toEqual(data);
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([ref.attachmentId]);
});

it('accepts exactly 512 MiB with a reused bounded chunk and rejects one byte more', async () => {
  const store = await setup();
  const chunk = Buffer.alloc(1024 * 1024, 42);
  async function* produce(extra: boolean) {
    for (let i = 0; i < MAX_FILE_BYTES / chunk.length; i++) yield chunk;
    if (extra) yield Buffer.from('x');
  }
  const ref = await store.saveStream({ name: 'boundary.bin', stream: produce(false) });
  expect(ref.bytes).toBe(MAX_FILE_BYTES);
  expect(await store.exists(ref.attachmentId)).toBe(true);
  await expect(store.saveStream({ name: 'too-big.bin', stream: produce(true) })).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
  expect(await readdir(path.join(store.root, 'objects', ref.digest!.slice(7, 9)))).toEqual([ref.digest!.slice(7)]);
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([ref.attachmentId]);
}, 20_000);

it.each([1, 5])('cleans up a declared length mismatch (%i bytes)', async (expectedBytes) => {
  const store = await setup();
  await expect(store.saveStream({ name: 'bad', expectedBytes, stream: stream(Buffer.from('abc')) })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED', message: 'Source length mismatch' });
  await empty(store);
});

it('rejects invalid sizes and pre-cancellation before consuming the producer', async () => {
  const store = await setup();
  const next = vi.fn(async () => ({ done: true as const, value: undefined }));
  const producer = { [Symbol.asyncIterator]: () => ({ next }) };
  for (const expectedBytes of [-1, NaN, 1.5, MAX_FILE_BYTES + 1]) {
    await expect(store.saveStream({ name: 'bad', expectedBytes, stream: producer })).rejects.toBeDefined();
  }
  await expect(store.saveStream({ name: 'bad', stream: producer, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
  expect(next).not.toHaveBeenCalled();
  await empty(store);
});

it('cleans staging and closes a failed producer', async () => {
  const store = await setup();
  let closed = false;
  async function* produce() {
    try { yield Buffer.from('abc'); throw new Error('producer failed'); }
    finally { closed = true; }
  }
  await expect(store.saveStream({ name: 'bad', stream: produce() })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED', message: 'producer failed' });
  expect(closed).toBe(true);
  await empty(store);
});

it('cancels a stalled Node stream promptly and destroys it', async () => {
  const store = await setup();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const source = new Readable({ read() { started(); } });
  const saving = store.saveStream({ name: 'stalled', stream: source, signal: controller.signal });
  const rejected = expect(saving).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
  await ready;
  controller.abort();
  await rejected;
  expect(source.destroyed).toBe(true);
  await empty(store);
});

it('returns promptly when an arbitrary async iterator is stalled at next()', async () => {
  const store = await setup();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const source = { [Symbol.asyncIterator]() { return {
    next: () => { started(); return new Promise<IteratorResult<Uint8Array>>(() => {}); }
  }; } };
  const rejected = expect(store.saveStream({ name: 'stalled', stream: source, signal: controller.signal })).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
  await ready;
  controller.abort();
  await rejected;
  await empty(store);
});

it('removes staging on write failure, fsync/open failure and final publication failure', async () => {
  const store = await setup();
  vi.mocked(createWriteStream).mockReturnValueOnce(new Writable({ write(_chunk, _encoding, done) { done(new Error('disk full')); } }) as ReturnType<typeof createWriteStream>);
  await expect(store.saveStream({ name: 'bad', stream: stream(Buffer.from('abc')) })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
  await empty(store);
  vi.mocked(open).mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(store.saveStream({ name: 'bad', stream: stream(Buffer.from('abc')) })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
  await empty(store);
  vi.mocked(rename).mockRejectedValueOnce(new Error('publish failed'));
  await expect(store.saveStream({ name: 'bad', stream: stream(Buffer.from('abc')) })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([]);
  // A published object may already be shared by another process; GC will reclaim orphans.
});

it('does not publish metadata before stream completion', async () => {
  const store = await setup();
  async function* produce() {
    yield Buffer.from('abc');
    const files = await readdir(path.join(store.root, 'refs'));
    expect(files.every((name) => name.startsWith('.pending-'))).toBe(true);
    expect(await readdir(path.join(store.root, 'objects'))).toEqual([]);
    yield Buffer.from('def');
  }
  const ref = await store.saveStream({ name: 'complete', stream: produce() });
  expect(ref.bytes).toBe(6);
});

it('rejects symlinks and directories and makes saveFile delegate to saveStream', async () => {
  const store = await setup();
  const source = path.join(store.root, 'source');
  await writeFile(source, 'abc');
  const alias = path.join(store.root, 'alias');
  await symlink(source, alias);
  await expect(store.saveFile({ path: alias })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
  await expect(store.saveFile({ path: store.root })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED' });
  const save = vi.spyOn(store, 'saveStream');
  const ref = await store.saveFile({ path: source });
  expect(ref.bytes).toBe(3);
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedBytes: 3, stream: expect.anything() }));
});

it('applies backpressure instead of exhausting the producer while disk writes are stalled', async () => {
  const store = await setup();
  const controller = new AbortController();
  let produced = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const output = new Writable({ highWaterMark: 1, write() { started(); } });
  vi.mocked(createWriteStream).mockReturnValueOnce(output as ReturnType<typeof createWriteStream>);
  async function* produce() {
    for (let i = 0; i < 1000; i++) { produced++; yield Buffer.alloc(64 * 1024); }
  }
  const rejected = expect(store.saveStream({ name: 'slow', stream: produce(), signal: controller.signal })).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  expect(produced).toBeLessThan(10);
  controller.abort();
  await rejected;
  await empty(store);
});

it('cleans up when fsync fails before publication', async () => {
  const store = await setup();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('fsync failed'));
    return handle;
  });
  await expect(store.saveStream({ name: 'bad', stream: stream(Buffer.from('abc')) })).rejects.toMatchObject({ code: 'ATTACHMENT_STORE_FAILED', message: 'fsync failed' });
  await empty(store);
});

it('does not delete a shared digest object when one concurrent ref fails publication', async () => {
  const store = await setup();
  vi.mocked(rename).mockRejectedValueOnce(new Error('one ref failed'));
  const results = await Promise.allSettled([
    store.saveStream({ name: 'first', stream: stream(Buffer.from('shared')) }),
    new LocalAttachmentStore(store.root).saveStream({ name: 'second', stream: stream(Buffer.from('shared')) })
  ]);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const success = results.find((result) => result.status === 'fulfilled');
  if (!success || success.status !== 'fulfilled') throw new Error('Expected one success');
  expect(await store.verify(success.value.attachmentId)).toMatchObject({ verified: true });
  expect(await readFile((await store.getPath(success.value.attachmentId))!, 'utf8')).toBe('shared');
  expect(await readdir(path.join(store.root, 'refs'))).toEqual([success.value.attachmentId]);
});

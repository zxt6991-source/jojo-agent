import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalAttachmentStore } from '@desktop-agent/attachments';
import type { FileAttachmentRef, Message } from '@desktop-agent/contracts';
import { LocalAttachmentAccessResolver } from '../src/local';
import { resolveModelAttachments } from '../src';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const ref: FileAttachmentRef = { type: 'file', attachmentId: 'att_test', name: 'report.txt', bytes: 3 };
const messages = (): Message[] => [{ id: 'm1', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'file', attachment: structuredClone(ref) }] }];
const context = { sessionId: 's1', workingDirectory: '/workspace', executionId: 'run1' };

it('resolves an immutable local resource after its source is removed, and reports missing/corrupt resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'attachment-access-'));
  directories.push(root);
  const store = new LocalAttachmentStore(path.join(root, 'store'));
  const resolver = new LocalAttachmentAccessResolver(store);
  const source = path.join(root, 'report.txt');
  await writeFile(source, 'abc');
  const saved = await store.saveFile({ path: source });
  await rm(source);
  const access = await resolver.resolve(saved, context);
  expect(access).toMatchObject({ kind: 'path', readonly: true });
  if (access.kind !== 'path') throw new Error('Path expected');
  expect(await readFile(access.path, 'utf8')).toBe('abc');
  expect((await stat(access.path)).mode & 0o222).toBe(0);
  expect(await resolver.resolve({ ...saved, attachmentId: '../../etc/passwd' }, context)).toMatchObject({ kind: 'unavailable' });
  await rm(access.path);
  expect(await resolver.resolve(saved, context)).toEqual({ kind: 'unavailable', reason: 'ATTACHMENT_NOT_FOUND' });
});

it('passes execution context to a mapped resolver without persisting its path or mutations', async () => {
  const history = messages();
  const original = structuredClone(history);
  const resolve = vi.fn(async (resource: FileAttachmentRef) => {
    expect(resource).toEqual(ref);
    resource.name = 'mutated';
    return { kind: 'path' as const, path: '/mnt/attachments/report.txt', readonly: true };
  });
  const result = await resolveModelAttachments([...history, ...history], { resolve }, context);
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ ...ref, name: 'mutated' }, context);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ name: 'report.txt', access: { path: '/mnt/attachments/report.txt', readonly: true } });
  expect(history).toEqual(original);
});

it('fails closed with no resolver or a failed remote projection and never opens stream-only access', async () => {
  expect((await resolveModelAttachments(messages(), undefined, context))[0]?.access).toEqual({ kind: 'unavailable', reason: 'ATTACHMENT_ACCESS_UNAVAILABLE' });
  expect((await resolveModelAttachments(messages(), { resolve: async () => { throw new Error('/secret/host/path'); } }, context))[0]?.access).toEqual({ kind: 'unavailable', reason: 'ATTACHMENT_PROJECTION_FAILED' });
  const open = vi.fn(async () => Readable.from([Buffer.from('abc')]));
  expect((await resolveModelAttachments(messages(), { resolve: async () => ({ kind: 'stream', open }) }, context))[0]?.access).toEqual({ kind: 'unavailable', reason: 'ATTACHMENT_STREAM_REQUIRES_BRIDGE' });
  expect(open).not.toHaveBeenCalled();
});

it('propagates cancellation instead of converting it to unavailable', async () => {
  const controller = new AbortController();
  const resolve = vi.fn(async () => {
    controller.abort();
    throw new Error('cancelled');
  });
  await expect(resolveModelAttachments(messages(), { resolve }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  resolve.mockClear();
  await expect(resolveModelAttachments(messages(), { resolve }, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(resolve).not.toHaveBeenCalled();
});

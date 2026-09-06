import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { LocalAttachmentStore } from '@desktop-agent/attachments';
import { MAX_FILE_BYTES } from '@desktop-agent/contracts';
import type { StartRunInput } from '@desktop-agent/server-protocol';
import { AttachmentUploads } from '../src/attachment-uploads';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'upload-receipts-'));
  roots.push(root);
  const store = new LocalAttachmentStore(root);
  return { root, store };
}
const bytes = (name = 'report.txt') => ({ name, stream: Readable.from([Buffer.from('original content')]), signal: new AbortController().signal });

it('binds receipts to principal and session and replaces untrusted metadata and previews', async () => {
  const { store } = await setup();
  let now = Date.now();
  const uploads = new AttachmentUploads(store, () => now);
  const receipt = await uploads.upload('alice', 'session', bytes());
  expect(receipt.attachment.preview?.text).toBe('original content');
  const request: StartRunInput = { laneId: 'main', model: 'm', providerId: 'p', input: { content: [{ type: 'file', attachment: { ...receipt.attachment, name: 'forged', bytes: 0 } }] }, attachmentReceipts: { [receipt.attachment.attachmentId]: receipt.receipt } };
  const resolved = await uploads.resolve('alice', 'session', request);
  expect(resolved.input.content[0]).toEqual({ type: 'file', attachment: receipt.attachment });
  expect(resolved.attachmentReceipts).toBeUndefined();
  await expect(uploads.resolve('bob', 'session', request)).rejects.toThrow(/receipt/);
  await expect(uploads.resolve('alice', 'another-session', request)).rejects.toThrow(/receipt/);
  // Retry is supported throughout the receipt lifetime; submission does not consume the token.
  expect(await uploads.resolve('alice', 'session', request)).toEqual(resolved);
  now += 60 * 60 * 1000;
  await expect(uploads.resolve('alice', 'session', request)).rejects.toThrow(/expired/);
  expect(await store.exists(receipt.attachment.attachmentId)).toBe(true);
});

it('keeps malformed documents as usable raw resources', async () => {
  const { store } = await setup();
  const receipt = await new AttachmentUploads(store).upload('alice', 'session', bytes('broken.pdf'));
  expect(receipt.previewWarning).toContain('Preview unavailable');
  expect(receipt.attachment.preview).toBeUndefined();
  expect(await store.exists(receipt.attachment.attachmentId)).toBe(true);
});

it('rejects declared oversize and pre-cancellation without publishing a receipt or ref', async () => {
  const { root, store } = await setup();
  const uploads = new AttachmentUploads(store);
  await expect(uploads.upload('a', 's', { ...bytes(), expectedBytes: MAX_FILE_BYTES + 1 })).rejects.toThrow(/size limits/);
  await expect(uploads.upload('a', 's', { ...bytes(), signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/);
  expect(await readdir(root)).toEqual([]);
});

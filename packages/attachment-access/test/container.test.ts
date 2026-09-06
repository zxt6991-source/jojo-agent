import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import path from 'node:path';
import { LocalAttachmentStore } from '@desktop-agent/attachments';
import { ContainerAttachmentAccessResolver, type ContainerCommand } from '../src/container';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'container-attachment-')));
  roots.push(root);
  const store = new LocalAttachmentStore(root);
  const ref = await store.saveStream({ name: '报告 with spaces.txt', stream: Readable.from([Buffer.from('test')]) });
  return { root, store, ref };
}
it('projects only a verified read-only bind mount and passes literal paths as separate arguments', async () => {
  const { root, store, ref } = await setup();
  const command = vi.fn<ContainerCommand>(async (args) => args[0] === 'inspect' ? JSON.stringify([{ State: { Running: true }, Mounts: [{ Type: 'bind', Source: root, Destination: '/mnt/attachments', RW: false }] }]) : args[2] === 'sha256sum' ? `${ref.digest!.slice(7)}  file` : '');
  const result = await new ContainerAttachmentAccessResolver(store, { containerId: 'worker-1', command }).resolve(ref, { sessionId: 's' });
  const projected = `/mnt/attachments/refs/${ref.attachmentId}/original/${ref.name}`;
  expect(result).toEqual({ kind: 'path', path: projected, readonly: true });
  expect(command.mock.calls.map((call) => call[0])).toEqual([
    ['inspect', '--type', 'container', 'worker-1'], ['exec', 'worker-1', 'test', '-f', projected], ['exec', 'worker-1', 'test', '-r', projected], ['exec', 'worker-1', 'sha256sum', '--', projected]
  ]);
});
it.each(['writable', 'stopped', 'outside', 'shadowed', 'unreadable', 'wrong-digest'])('refuses %s container access without returning host paths', async (scenario) => {
  const { root, store, ref } = await setup();
  const mounts = [{ Type: 'bind', Source: scenario === 'outside' ? path.join(root, 'objects') : root, Destination: '/mnt/attachments', RW: scenario === 'writable' }];
  if (scenario === 'shadowed') mounts.push({ Type: 'volume', Source: root, Destination: '/mnt/attachments/refs', RW: false });
  const command: ContainerCommand = async (args) => {
    if (args[0] !== 'inspect') {
      if (scenario === 'unreadable') throw new Error('unreadable');
      return scenario === 'wrong-digest' ? '0'.repeat(64) : ref.digest!.slice(7);
    }
    return JSON.stringify([{ State: { Running: scenario !== 'stopped' }, Mounts: mounts }]);
  };
  expect(await new ContainerAttachmentAccessResolver(store, { containerId: 'worker', command }).resolve(ref, { sessionId: 's' })).toMatchObject({ kind: 'unavailable' });
});
it('propagates cancellation and rejects flag-like container identifiers', async () => {
  const { store, ref } = await setup();
  expect(() => new ContainerAttachmentAccessResolver(store, { containerId: '--help' })).toThrow();
  const command = vi.fn<ContainerCommand>();
  await expect(new ContainerAttachmentAccessResolver(store, { containerId: 'worker', command }).resolve(ref, { sessionId: 's', signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(command).not.toHaveBeenCalled();
});

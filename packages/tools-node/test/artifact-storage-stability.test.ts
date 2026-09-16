import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Message } from '@desktop-agent/contracts';
import { produceWorkspaceArtifact, readSessionArtifactV2 } from '../src/artifact-storage';

const hook = vi.hoisted(() => ({ afterRead: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    return new Proxy(file, { get(target, property) {
      if (property === 'read') return async (...readArgs: [Buffer, number, number, number]) => {
        const result = await target.read(...readArgs);
        const callback = hook.afterRead;
        hook.afterRead = undefined;
        await callback?.();
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
const roots: string[] = [];
afterEach(async () => { hook.afterRead = undefined; await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))); });
it.each(['rewrite', 'delete', 'replace'])('fails a stable read if the source changes during reading: %s', async (change) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artifact-race-')); roots.push(root);
  const source = path.join(root, 'a.txt'); await writeFile(source, 'original');
  const artifact = await produceWorkspaceArtifact(root, source, 'write_file');
  const messages: Message[] = [{ id: 'r', role: 'tool', createdAt: new Date().toISOString(), content: [{ type: 'tool_result', result: { callId: 'c', ok: true, content: '', artifacts: [artifact] } }] }];
  hook.afterRead = async () => {
    if (change !== 'rewrite') await rm(source);
    if (change !== 'delete') await writeFile(source, 'changed!');
  };
  await expect(readSessionArtifactV2(messages, root, 's', artifact.id)).rejects.toMatchObject({ code: 'CONTENT_UNSTABLE' });
});

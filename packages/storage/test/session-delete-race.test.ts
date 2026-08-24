import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore } from '../src/index.js';

function message(id: string) {
  return {
    id, role: 'user' as const, createdAt: new Date().toISOString(),
    content: [{ type: 'text' as const, text: id }]
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; }
  catch { return false; }
}

describe('JsonlSessionStore delete lifecycle', () => {
  it('rejects appends after delete and cannot resurrect the JSONL', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-delete-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create('Delete me', directory);
    const file = path.join(directory, `${session.id}.jsonl`);

    await store.delete(session.id);
    await expect(store.appendMessage(session.id, message('late'))).rejects.toThrow(/session_unavailable/);
    expect(await pathExists(file)).toBe(false);
  });

  it('makes duplicate delete idempotent', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-delete-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create('Delete me', directory);

    await expect(store.delete(session.id)).resolves.toBeUndefined();
    await expect(store.delete(session.id)).resolves.toBeUndefined();
  });

  it('serializes append and delete across store instances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-delete-race-'));
    const writer = new JsonlSessionStore(directory);
    const deleter = new JsonlSessionStore(directory);
    const session = await writer.create('Race', directory);
    const file = path.join(directory, `${session.id}.jsonl`);

    await Promise.allSettled([
      ...Array.from({ length: 20 }, (_, index) => writer.appendMessage(session.id, message(`m${index}`))),
      deleter.delete(session.id)
    ]);

    await expect(writer.appendMessage(session.id, message('late'))).rejects.toThrow(/session_unavailable/);
    expect(await pathExists(file)).toBe(false);
  });
});

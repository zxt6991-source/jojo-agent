import { appendFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonlSessionStore } from '../src/index.js';

describe('JsonlSessionStore', () => {
  it('recovers complete records before a damaged tail', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-store-'));
    const store = new JsonlSessionStore(directory);
    const session = await store.create('Test', directory);
    await store.appendMessage(session.id, {
      id: 'm1', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text: 'hello' }]
    });
    await appendFile(path.join(directory, `${session.id}.jsonl`), '{"broken":');
    const loaded = await store.load(session.id);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.warnings).toHaveLength(1);
  });

  it('prevents concurrent turns for one session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-agent-lock-'));
    const store = new JsonlSessionStore(directory);
    const release = store.acquire('one');
    expect(() => store.acquire('one')).toThrow(/already running/);
    release();
    expect(() => store.acquire('one')).not.toThrow();
  });
});

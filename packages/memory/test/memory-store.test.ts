import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_HASH,
  MarkdownMemoryStore,
  MemoryIndex,
  parseMemoryDocument,
  serializeMemoryEntry
} from '../src/index.js';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-test-'));
  directories.push(directory);
  const root = path.join(directory, 'memory');
  const index = new MemoryIndex(path.join(directory, 'memory.sqlite'));
  const store = new MarkdownMemoryStore(root, index);
  await store.initialize();
  return { directory, root, index, store, scope: store.globalScope() };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('MarkdownMemoryStore', () => {
  it('writes entries atomically and projects them into search', async () => {
    const { store, scope, index } = await fixture();
    const initial = await store.read(scope);
    const written = await store.writeEntry({
      scope, kind: 'preference', title: 'Package manager', content: '项目只使用 pnpm。',
      tags: ['node'], target: 'index', expectedRevision: initial.revision, sourceSessionId: 'sess_1'
    });
    expect(written.previousRevision).toBe(initial.revision);
    expect(written.revision).not.toBe(initial.revision);
    expect(written.scopeVersion).toBe(1);

    const parsed = await store.listEntries(scope);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries).toEqual([expect.objectContaining({
      id: written.entryId, kind: 'preference', title: 'Package manager', content: '项目只使用 pnpm。'
    })]);
    const found = await store.search(undefined, 'pnpm', 'global', undefined, 5);
    expect(found[0]?.entry.id).toBe(written.entryId);
    index.close();
  });

  it('detects external edits and serializes process-local writers', async () => {
    const { store, scope, index } = await fixture();
    const initial = await store.read(scope);
    await writeFile(path.join(scope.directory, 'MEMORY.md'), '# Memory\n\nEdited externally.\n', 'utf8');
    await expect(store.patch({
      scope, path: 'MEMORY.md', expectedRevision: initial.revision,
      patch: { type: 'append', content: 'new content' }
    })).rejects.toMatchObject({ code: 'memory_conflict' });

    const latest = await store.read(scope);
    const attempts = await Promise.allSettled([
      store.patch({ scope, path: 'MEMORY.md', expectedRevision: latest.revision, patch: { type: 'append', content: 'A' } }),
      store.patch({ scope, path: 'MEMORY.md', expectedRevision: latest.revision, patch: { type: 'append', content: 'B' } })
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((item) => item.status === 'rejected')).toHaveLength(1);
    index.close();
  });

  it('requires an exact unique patch target', async () => {
    const { store, scope, index } = await fixture();
    const initial = await store.read(scope);
    const seeded = await store.patch({
      scope, path: 'MEMORY.md', expectedRevision: initial.revision,
      patch: { type: 'append', content: 'duplicate\nduplicate' }
    });
    await expect(store.patch({
      scope, path: 'MEMORY.md', expectedRevision: seeded.revision,
      patch: { type: 'replace', oldText: 'duplicate', newText: 'updated' }
    })).rejects.toMatchObject({ code: 'memory_conflict' });
    index.close();
  });

  it('forgets and restores through a recovery record', async () => {
    const { store, scope, index } = await fixture();
    const initial = await store.read(scope);
    const written = await store.writeEntry({
      scope, kind: 'lesson', title: 'Build lesson', content: 'Build native first.',
      target: 'index', expectedRevision: initial.revision
    });
    const forgotten = await store.forget(scope, written.entryId, written.revision);
    expect((await store.listEntries(scope)).entries).toHaveLength(0);
    const restored = await store.restore(scope, forgotten.recoveryId, forgotten.revision);
    expect(restored.entryId).toBe(written.entryId);
    expect((await store.listEntries(scope)).entries[0]?.content).toBe('Build native first.');
    const recovery = JSON.parse(await readFile(
      path.join(scope.directory, 'recovery', `${forgotten.recoveryId}.json`), 'utf8'
    )) as { entryId: string };
    expect(recovery.entryId).toBe(written.entryId);
    index.close();
  });

  it('rejects traversal and symbolic-link escape', async () => {
    const { store, scope, directory, index } = await fixture();
    await expect(store.read(scope, '../outside.md')).rejects.toMatchObject({ code: 'memory_permission_denied' });
    await symlink(directory, path.join(scope.directory, 'topics', 'escape'));
    await expect(store.read(scope, 'topics/escape/outside.md')).rejects.toMatchObject({ code: 'memory_permission_denied' });
    index.close();
  });
});

describe('memory Markdown parser', () => {
  it('keeps valid entries when a neighboring entry is malformed', () => {
    const valid = serializeMemoryEntry({
      id: 'mem_valid', kind: 'fact', title: 'Valid', content: 'Keep me.', status: 'confirmed'
    });
    const parsed = parseMemoryDocument(
      `${valid}\n\n## Broken\n<!-- jojo-memory\nid: mem_bad\nkind: nope\nstatus: confirmed\n-->\nIgnore me.`,
      'MEMORY.md', 'global'
    );
    expect(parsed.entries.map((entry) => entry.id)).toEqual(['mem_valid']);
    expect(parsed.warnings).toHaveLength(1);
  });

  it('exports the empty-document revision for new topic writes', () => {
    expect(EMPTY_HASH).toMatch(/^[a-f0-9]{64}$/u);
  });
});

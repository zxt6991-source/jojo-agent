import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_SETTINGS, type EmbeddingProvider, type MemoryScope } from '@desktop-agent/contracts';
import { SqliteSemanticMemoryBackend } from '@desktop-agent/storage';
import {
  createProjectIdentity,
  MarkdownMemoryStore,
  MemoryIndex,
  MemoryService,
  memoryChunks,
  SemanticMemoryService
} from '../src/index';

const directories: string[] = [];
const semanticServices: SemanticMemoryService[] = [];

function semanticVector(text: string): Float32Array {
  if (/(?:worktree|后台|主分支|background)/iu.test(text)) return Float32Array.from([1, 0, 0]);
  if (/(?:node:sqlite|sqlite index)/iu.test(text)) return Float32Array.from([0, 1, 0]);
  return Float32Array.from([0, 0, 1]);
}

async function fixture(input: { remote?: boolean; failQuery?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'semantic-memory-'));
  directories.push(directory);
  const store = new MarkdownMemoryStore(path.join(directory, 'memory'), new MemoryIndex(path.join(directory, 'fts.sqlite')));
  await store.initialize();
  const embed = vi.fn(async (texts: string[]) => {
    if (input.failQuery && texts.length === 1 && !texts[0]!.startsWith('Title:')) throw new Error('provider down');
    return { vectors: texts.map(semanticVector), usage: { inputTokens: texts.length * 3 } };
  });
  const provider = { id: 'embed-provider', model: 'embed-model', remote: input.remote ?? false, embed } satisfies EmbeddingProvider;
  const backend = new SqliteSemanticMemoryBackend(path.join(directory, 'semantic.sqlite'));
  const semantic = new SemanticMemoryService(store, backend, () => provider);
  semanticServices.push(semantic);
  semantic.attach();
  const service = new MemoryService(store, semantic);
  const settings = {
    ...DEFAULT_MEMORY_SETTINGS,
    semantic: {
      ...DEFAULT_MEMORY_SETTINGS.semantic,
      enabled: true,
      providerId: provider.id,
      model: provider.model,
      remoteAllowed: input.remote ?? false
    }
  };
  service.updateSettings(settings);
  return { directory, store, backend, semantic, service, provider, embed, settings };
}

async function write(store: MarkdownMemoryStore, scope: MemoryScope, input: { title: string; content: string }) {
  const document = await store.read(scope);
  return store.writeEntry({
    scope, kind: 'decision', title: input.title, content: input.content,
    target: 'index', expectedRevision: document.revision, status: 'confirmed'
  });
}

afterEach(async () => {
  await Promise.all(semanticServices.splice(0).map((service) => service.idle()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SemanticMemoryService', () => {
  it('builds embedding text without canonical paths or session provenance', async () => {
    const { directory, store } = await fixture();
    const project = path.join(directory, 'private-project');
    await mkdir(project);
    const identity = (await createProjectIdentity(project))!;
    const scope = store.projectScope(identity);
    const chunks = memoryChunks(scope, [{
      id: 'entry', scopeId: scope.id, kind: 'decision', status: 'confirmed', title: 'Safe title',
      content: 'Safe durable content.', tags: [], sourceFile: 'MEMORY.md', sourceSessionId: 'secret-session-id',
      sourceOperationId: 'secret-operation-id', createdAt: 1, updatedAt: 1, contentHash: 'hash', unknownMetadata: {}
    }], DEFAULT_MEMORY_SETTINGS.semantic);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain('Safe durable content');
    expect(chunks[0]!.content).not.toContain(identity.canonicalPath);
    expect(chunks[0]!.content).not.toContain('secret-session-id');
    expect(chunks[0]!.content).not.toContain('secret-operation-id');
  });

  it('recalls a semantic paraphrase and keeps exact FTS tokens first through RRF', async () => {
    const { store, service } = await fixture();
    const scope = store.globalScope();
    await write(store, scope, { title: 'Writable agents', content: 'Writable Sub-Agent uses an isolated Worktree and never auto-merges.' });
    await write(store, scope, { title: 'SQLite index', content: 'Use node:sqlite for the Memory index.' });
    await service.rebuildSemantic();

    const paraphrase = await service.search('', '为什么后台修改代码不能直接落到主分支？', 'global', undefined, 5, 'hybrid');
    expect(paraphrase[0]).toMatchObject({ title: 'Writable agents', retrieval: { modes: ['semantic'] } });

    const exact = await service.search('', 'node:sqlite', 'global', undefined, 5, 'hybrid');
    expect(exact[0]).toMatchObject({ title: 'SQLite index' });
    expect(exact[0]!.retrieval.modes).toContain('fts');
  });

  it('falls back to FTS when query embedding fails or remote permission is off', async () => {
    const down = await fixture({ failQuery: true });
    await write(down.store, down.store.globalScope(), { title: 'Package manager', content: 'Always use pnpm.' });
    await down.service.rebuildSemantic();
    await expect(down.service.search('', 'pnpm', 'global', undefined, 5, 'hybrid'))
      .resolves.toMatchObject([{ title: 'Package manager', retrieval: { modes: ['fts'] } }]);

    const remote = await fixture({ remote: true });
    remote.service.updateSettings({
      ...remote.settings,
      semantic: { ...remote.settings.semantic, remoteAllowed: false }
    });
    await write(remote.store, remote.store.globalScope(), { title: 'Exact setting', content: 'Use pnpm.' });
    await expect(remote.service.search('', 'pnpm', 'global', undefined, 5, 'hybrid'))
      .resolves.toMatchObject([{ title: 'Exact setting', retrieval: { modes: ['fts'] } }]);
    expect(remote.embed).not.toHaveBeenCalled();
  });

  it('never sends secret chunks to a remote provider', async () => {
    const { store, service, embed } = await fixture({ remote: true });
    const scope = store.globalScope();
    await write(store, scope, { title: 'Secret', content: 'TOKEN=super-secret-token-value' });
    await write(store, scope, { title: 'Safe', content: 'Use node:sqlite for the index.' });
    await service.rebuildSemantic();
    const indexedTexts = embed.mock.calls.flatMap(([texts]) => texts);
    expect(indexedTexts.join('\n')).not.toContain('super-secret-token-value');
    expect(indexedTexts.join('\n')).toContain('node:sqlite');
    expect((await service.status()).semantic?.skippedSecret).toBe(1);
  });

  it('does not leak vectors across project scopes and drops forgotten entries', async () => {
    const { directory, store, service } = await fixture();
    const projectOne = path.join(directory, 'one');
    const projectTwo = path.join(directory, 'two');
    await Promise.all([mkdir(projectOne), mkdir(projectTwo)]);
    const identityOne = (await createProjectIdentity(projectOne))!;
    const identityTwo = (await createProjectIdentity(projectTwo))!;
    const scopeOne = store.projectScope(identityOne);
    const scopeTwo = store.projectScope(identityTwo);
    await write(store, scopeOne, { title: 'Project one', content: 'Writable agents use a worktree.' });
    const second = await write(store, scopeTwo, { title: 'Project two only', content: 'Unique zebra policy.' });
    await service.rebuildSemantic(projectOne);
    await service.rebuildSemantic(projectTwo);

    const crossProject = await service.search(projectOne, 'Unique zebra policy', 'project', undefined, 5, 'semantic');
    expect(crossProject.find((hit) => hit.title === 'Project two only')).toBeUndefined();

    const document = await store.read(scopeTwo, second.path);
    await store.forget(scopeTwo, second.entryId, document.revision);
    const forgotten = await service.search(projectTwo, 'Unique zebra policy', 'project', undefined, 5, 'semantic');
    expect(forgotten.find((hit) => hit.title === 'Project two only')).toBeUndefined();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider, MemoryChunk } from '@desktop-agent/contracts';
import { SqliteSemanticMemoryBackend } from '../src/sqlite-semantic-memory-backend';

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'semantic-backend-'));
  directories.push(directory);
  return new SqliteSemanticMemoryBackend(path.join(directory, 'semantic.sqlite'));
}

function chunk(id: string, contentHash = `${id}-hash`): MemoryChunk {
  return {
    id, entryId: `entry-${id}`, scopeId: 'global', file: 'MEMORY.md', headingPath: [id],
    kind: 'decision', status: 'confirmed', title: id, content: `Title: ${id}\nContent:\n${id}`,
    contentHash, updatedAt: 1
  };
}

function provider(model = 'embed-1') {
  const embed = vi.fn(async (texts: string[]) => ({
    vectors: texts.map((text, index) => Float32Array.from([text.length, index + 1])),
    usage: { inputTokens: texts.length * 4 }
  }));
  return { provider: { id: 'provider', model, remote: false, embed } satisfies EmbeddingProvider, embed };
}

function request(chunks: MemoryChunk[], embeddingProvider: EmbeddingProvider, replace = false) {
  return {
    chunks, skipped: [], provider: embeddingProvider, chunkingVersion: 1, normalizationVersion: 1,
    ...(replace ? { replaceScopeIds: ['global'] } : {})
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SqliteSemanticMemoryBackend', () => {
  it('indexes incrementally and re-embeds content or model fingerprint changes', async () => {
    const backend = await fixture();
    const first = provider();
    await expect(backend.ensureIndexed(request([chunk('one')], first.provider))).resolves.toMatchObject({ indexed: 1, unchanged: 0 });
    await expect(backend.ensureIndexed(request([chunk('one')], first.provider))).resolves.toMatchObject({ indexed: 0, unchanged: 1 });
    expect(first.embed).toHaveBeenCalledTimes(1);
    await backend.ensureIndexed(request([chunk('one', 'changed-hash')], first.provider));
    expect(first.embed).toHaveBeenCalledTimes(2);
    const second = provider('embed-2');
    await backend.ensureIndexed(request([chunk('one', 'changed-hash')], second.provider));
    expect(second.embed).toHaveBeenCalledTimes(1);
    backend.close();
  });

  it('removes orphan and forgotten vectors during rebuild/removal', async () => {
    const backend = await fixture();
    const fake = provider();
    await backend.rebuild(request([chunk('one'), chunk('two')], fake.provider, true));
    await expect(backend.rebuild(request([chunk('one')], fake.provider, true))).resolves.toMatchObject({ removed: 1 });
    let hits = await backend.search({
      vector: Float32Array.from([20, 1]), providerId: 'provider', model: 'embed-1',
      chunkingVersion: 1, normalizationVersion: 1, scopeIds: ['global'], maxCandidates: 10, limit: 10
    });
    expect(hits.map((hit) => hit.entryId)).toEqual(['entry-one']);
    await backend.remove({ entryIds: ['entry-one'] });
    hits = await backend.search({
      vector: Float32Array.from([20, 1]), providerId: 'provider', model: 'embed-1',
      chunkingVersion: 1, normalizationVersion: 1, scopeIds: ['global'], maxCandidates: 10, limit: 10
    });
    expect(hits).toEqual([]);
    backend.close();
  });

  it('enforces the bounded linear-search capacity', async () => {
    const backend = await fixture();
    const fake = provider();
    await backend.rebuild(request([chunk('one'), chunk('two')], fake.provider, true));
    await expect(backend.search({
      vector: Float32Array.from([20, 1]), providerId: 'provider', model: 'embed-1',
      chunkingVersion: 1, normalizationVersion: 1, scopeIds: ['global'], maxCandidates: 1, limit: 10
    })).rejects.toMatchObject({ code: 'memory_semantic_backend_capacity_exceeded' });
    backend.close();
  });

  it('drops corrupt vectors instead of returning them', async () => {
    const backend = await fixture();
    const fake = provider();
    await backend.ensureIndexed(request([chunk('one')], fake.provider));
    const database = new DatabaseSync(backend.filename);
    database.prepare('UPDATE memory_embeddings SET embedding_blob = ? WHERE chunk_id = ?')
      .run(Uint8Array.from([1, 2, 3]), 'one');
    database.close();
    await expect(backend.search({
      vector: Float32Array.from([20, 1]), providerId: 'provider', model: 'embed-1',
      chunkingVersion: 1, normalizationVersion: 1, scopeIds: ['global'], maxCandidates: 10, limit: 10
    })).resolves.toEqual([]);
    await expect(backend.status({ enabled: true, mode: 'local-linear', providerId: 'provider', model: 'embed-1' }))
      .resolves.toMatchObject({ indexedChunks: 0 });
    backend.close();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryCandidate } from '@desktop-agent/contracts';
import { SqliteMemoryCandidateStore } from '../src/sqlite-memory-candidate-store';

const directories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'memory-candidate-store-'));
  directories.push(directory);
  return new SqliteMemoryCandidateStore(path.join(directory, 'candidates.sqlite'));
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 'memcand_1', sessionId: 'session-1', operationId: 'operation-1', scopeId: 'global',
    scope: 'global', kind: 'decision', title: 'Use node sqlite', content: 'Use node:sqlite for the index.',
    rationale: 'Durable design decision.', confidence: 'high', tags: [], suggestedTarget: 'index',
    provenance: [{ source: 'user', verified: true }], suggestedMutation: { type: 'create' },
    state: 'pending', fingerprint: 'a'.repeat(64), createdAt: 1_000, expiresAt: 10_000,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SqliteMemoryCandidateStore', () => {
  it('claims an extraction operation once even when it produced no candidates', async () => {
    const store = await createStore();
    await expect(store.claimExtraction('operation-1', 'session-1')).resolves.toBe(true);
    await store.completeExtraction('operation-1');
    await expect(store.claimExtraction('operation-1', 'session-1')).resolves.toBe(false);
    store.close();
  });

  it('deduplicates operation fingerprints and retains rejection suppression records', async () => {
    const store = await createStore();
    await expect(store.insert(candidate())).resolves.toBe('created');
    await expect(store.insert(candidate({ id: 'memcand_2' }))).resolves.toBe('duplicate');
    await expect(store.resolve('memcand_1', 'rejected', 2_000)).resolves.toBe(true);
    await expect(store.wasRejectedSince('a'.repeat(64), 1_500)).resolves.toBe(true);
    store.close();
  });

  it('expires pending candidates without deleting the audit record', async () => {
    const store = await createStore();
    await store.insert(candidate());
    await expect(store.expire(10_001)).resolves.toBe(1);
    await expect(store.get('memcand_1')).resolves.toMatchObject({ state: 'expired', resolvedAt: 10_001 });
    store.close();
  });
});

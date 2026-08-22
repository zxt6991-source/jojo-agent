import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_SETTINGS, type MemoryEntry } from '@desktop-agent/contracts';
import {
  buildMemorySnapshot,
  createProjectIdentity,
  DurableMemoryRuntime,
  MarkdownMemoryStore,
  matchTriggeredRules,
  MemoryIndex,
  MemoryPermissionGate,
  MemoryService,
  createMemoryTools,
  scanSecrets
} from '../src/index.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function rule(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mem_rule', scopeId: 'global', kind: 'rule', status: 'confirmed', title: 'Release rule',
    content: 'Run the release checklist.', tags: [], sourceFile: 'MEMORY.md',
    createdAt: 1, updatedAt: 1, contentHash: 'hash', ruleMode: 'triggered', triggers: ['release'],
    unknownMetadata: {}, ...overrides
  };
}

describe('memory runtime', () => {
  it('prioritizes project rules and triggers each rule once', () => {
    const seen = new Set<string>();
    const recalls = matchTriggeredRules([
      rule(), rule({ id: 'mem_project', scopeId: 'prj_x', content: 'Project release rule.' })
    ], 'Please RELEASE this package', seen);
    expect(recalls.flatMap((item) => item.ruleIds)).toEqual(['mem_project', 'mem_rule']);
    expect(matchTriggeredRules([rule()], 'release again', seen)).toEqual([]);
  });

  it('keeps snapshots within the configured budget', () => {
    const snapshot = buildMemorySnapshot({
      scopes: [{
        scope: { id: 'global', kind: 'global', directory: '/memory/global', displayName: 'Global' },
        version: 4,
        entries: Array.from({ length: 20 }, (_, index) => rule({
          id: `mem_${index}`, ruleMode: 'always', content: 'x'.repeat(400)
        }))
      }],
      contextWindowTokens: 8192,
      maxTokens: 256,
      maxContextRatio: 0.05
    });
    expect(snapshot.estimatedTokens).toBeLessThanOrEqual(270);
    expect(snapshot.scopeVersions).toEqual({ global: 4 });
  });

  it('returns one stable snapshot per session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-runtime-'));
    directories.push(directory);
    const index = new MemoryIndex(path.join(directory, 'memory.sqlite'));
    const store = new MarkdownMemoryStore(path.join(directory, 'memory'), index);
    await store.initialize();
    const runtime = new DurableMemoryRuntime(store);
    const identity = await createProjectIdentity(directory);
    const signal = new AbortController().signal;
    const first = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_1', ...(identity ? { projectIdentity: identity } : {}),
      contextWindowTokens: 128_000, signal
    });
    const second = await runtime.snapshot({
      sessionId: 'sess_1', operationId: 'op_2', ...(identity ? { projectIdentity: identity } : {}),
      contextWindowTokens: 128_000, signal
    });
    expect(second.id).toBe(first.id);
    index.close();
  });
});

describe('secret scanner', () => {
  it('hard-denies credentials but only warns for generic high-entropy strings', () => {
    expect(scanSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').some((item) => item.severity === 'deny')).toBe(true);
    expect(scanSecrets('build id AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd').some((item) => item.severity === 'warning')).toBe(true);
  });

  it('enforces disabled scopes while keeping index maintenance available', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-settings-'));
    directories.push(directory);
    const index = new MemoryIndex(path.join(directory, 'memory.sqlite'));
    const store = new MarkdownMemoryStore(path.join(directory, 'memory'), index);
    await store.initialize();
    const service = new MemoryService(store);
    service.updateSettings({ ...DEFAULT_MEMORY_SETTINGS, globalEnabled: false });

    await expect(service.scope('global', directory)).rejects.toMatchObject({ code: 'memory_scope_unavailable' });
    await expect(service.rebuild('global')).resolves.toMatchObject({ scopes: expect.any(Array) });
    index.close();
  });

  it('requires approval for mutations, confirms rules, and preserves recovery records on UI deletion', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-memory-tools-'));
    directories.push(directory);
    const index = new MemoryIndex(path.join(directory, 'memory.sqlite'));
    const store = new MarkdownMemoryStore(path.join(directory, 'memory'), index);
    await store.initialize();
    const service = new MemoryService(store);
    const gate = new MemoryPermissionGate({ check: async () => ({ decision: 'allow' }) }, store.root);
    const scope = store.globalScope();
    const document = await store.read(scope);
    const input = {
      scope: 'global', kind: 'rule', title: 'Package manager', content: 'Always use pnpm.',
      ruleMode: 'always', expectedHash: document.revision
    };
    await expect(gate.check(
      { id: 'call_1', name: 'memory_write', input },
      { sessionId: 'sess_1', workingDirectory: directory }
    )).resolves.toMatchObject({ decision: 'ask' });
    await expect(gate.check(
      { id: 'call_2', name: 'memory_write', input: { ...input, content: 'Authorization: Bearer secret-value' } },
      { sessionId: 'sess_1', workingDirectory: directory }
    )).resolves.toMatchObject({ decision: 'deny', code: 'memory_secret_detected' });

    const tool = createMemoryTools(service).find((candidate) => candidate.definition.name === 'memory_write');
    const saved = await tool!.execute(input, {
      sessionId: 'sess_1', workingDirectory: directory, signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    });
    expect(saved.ok).toBe(true);
    const entry = (await store.listEntries(scope)).entries[0]!;
    expect(entry).toMatchObject({
      kind: 'rule', status: 'confirmed', ruleMode: 'always'
    });
    await expect(service.deleteEntry('global', entry.id)).resolves.toMatchObject({
      scopes: [expect.objectContaining({ id: 'global', entryCount: 0 })]
    });
    expect((await store.listEntries(scope)).entries).toEqual([]);
    expect(await readdir(path.join(scope.directory, 'recovery'))).toHaveLength(1);
    index.close();
  });
});

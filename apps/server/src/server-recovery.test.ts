import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import { MemoryServerStateStore } from '@desktop-agent/app-service';
import { MemoryChannelStore } from '@desktop-agent/channel-runtime';
import { ServerDataOwnership, SqliteAgentRuntimeStore } from '@desktop-agent/storage';
import { createHeadlessServer } from './index.js';

const dependencies = {
  providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([]) },
  permissions: { check: async () => ({ decision: 'allow' as const }) },
  scheduler: false as const
};

describe('server recovery lifecycle', () => {
  it('holds canonical directory ownership across instance ids for the full lifetime', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ownership-'));
    const alias = `${dir}-alias`;
    await symlink(dir, alias, 'dir');
    try {
      const server = await createHeadlessServer({ ...dependencies, dataDir: dir, instanceId: 'one' });
      try {
        await expect(createHeadlessServer({ ...dependencies, dataDir: alias, instanceId: 'two' })).rejects.toThrow('server_data_directory_busy');
      } finally { await server.close(); }
      const next = await createHeadlessServer({ ...dependencies, dataDir: alias, instanceId: 'two' });
      await next.close();
    } finally { await rm(alias, { force: true }); await rm(dir, { recursive: true, force: true }); }
  });

  it('requires ownership evidence for externally opened persistent stores', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recovery-unowned-'));
    const store = new SqliteAgentRuntimeStore(path.join(dir, 'runtime.sqlite'));
    try {
      await expect(createHeadlessServer({ ...dependencies, store, dataDir: dir })).rejects.toThrow('server_data_ownership_required');
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it('disposes registered capabilities and releases ownership if runtime construction fails', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recovery-construction-'));
    const disposed = vi.fn();
    try {
      await expect(createHeadlessServer({ ...dependencies, dataDir: dir, capabilities: [{ contribute(builder) {
        builder.addDisposable({ dispose: disposed });
        throw new Error('capability initialization failed');
      } }] })).rejects.toThrow('capability initialization failed');
      expect(disposed).toHaveBeenCalledOnce();
      const ownership = ServerDataOwnership.acquire(dir); ownership.release();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(['missing_operation', 'write_failure'])('fails before channels or scheduler start and cleans up on %s', async fault => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'recovery-failure-'));
    const store = new MemoryAgentRuntimeStore();
    await store.createSession({ id: 's', createdAt: 0 });
    await store.saveLane({ sessionId: 's', name: 'main', leafId: null, currentOperationId: null });
    if (fault === 'missing_operation') {
      vi.spyOn(store, 'listLanes').mockResolvedValue([{ sessionId: 's', name: 'main', leafId: null, currentOperationId: 'missing' }]);
    } else {
      await store.startOperation({ id: 'old', sessionId: 's', lane: 'main', kind: 'run', createdAt: 0, providerId: 'p', model: 'm', maxIterations: 1 }, {
        phase: 'ready', operationId: 'old', lane: 'main', iteration: 0, outputContinuations: 0,
        progress: { toolCallCounts: {}, observationFingerprints: [], recoveryStepsRemaining: null }
      });
      vi.spyOn(store, 'saveOperationState').mockRejectedValue(new Error('database write failure'));
    }
    const stateStore = new MemoryServerStateStore();
    const stateClose = vi.spyOn(stateStore, 'close');
    const channelStore = new MemoryChannelStore();
    const listChannels = vi.spyOn(channelStore, 'listInstances');
    const disposed = vi.fn();
    const resolve = vi.fn(dependencies.providers.resolve);
    try {
      await expect(createHeadlessServer({ ...dependencies, providers: { describe: describeTestProvider, resolve }, scheduler: true, dataDir: dir, store, stateStore,
        capabilities: [{ contribute(builder) { builder.addDisposable({ dispose: disposed }); } }],
        channels: { store: channelStore, builtInAdapters: false, defaultProviderId: 'p', defaultModel: 'm', secrets: { resolve: async () => 'secret' } }
      })).rejects.toThrow(fault === 'missing_operation' ? 'runtime_recovery_conflict' : 'database write failure');
      expect(listChannels).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(disposed).toHaveBeenCalledOnce();
      expect(stateClose).toHaveBeenCalledOnce();
      const ownership = ServerDataOwnership.acquire(dir); ownership.release();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

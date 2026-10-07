import { expect, it, vi } from 'vitest';
import { ScriptedProvider, describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { MemoryServerStateStore } from '@desktop-agent/app-service';
import { createProductRuntime, type ProductRuntimeOptions } from '../src/index.js';

function options(kind: 'desktop' | 'server'): ProductRuntimeOptions {
  return {
    recovery: kind === 'desktop' ? 'preserve' : 'interrupt',
    runtime: {
      host: { kind }, providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([[
        { type: 'text_delta', text: 'shared product' }, { type: 'response_completed', stopReason: 'stop' }
      ]]) }, permissions: { check: async () => ({ decision: 'allow' }) }
    }
  };
}

it.each(['desktop', 'server'] as const)('composes %s through the same application entry and closes once', async kind => {
  const stateStore = new MemoryServerStateStore();
  const close = vi.spyOn(stateStore, 'close');
  const dispose = vi.fn();
  const config = options(kind);
  config.runtime.capabilities = [{ contribute: builder => { builder.addDisposable({ dispose }); } }];
  const product = await createProductRuntime({ ...config, application: { stateStore }, beforeRecovery: async runtime => {
    await runtime.openSession({ id: 'repaired', executionScope: { kind: 'none' } });
  } });
  const ctx = { requestId: 'test', principal: { id: 'local', type: 'local' as const, scopes: [] } };
  try {
    expect(await product.application.listSessions(ctx)).toEqual([expect.objectContaining({ id: 'repaired' })]);
    const result = await product.application.executeRun(ctx, 'repaired', {
      laneId: 'main', providerId: 'p', model: 'm', input: { content: [{ type: 'text', text: 'hello' }] }
    });
    expect(result).toMatchObject({ status: 'completed', finalText: 'shared product' });
  } finally { await product.close(); await product.close(); }
  expect(close).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});

it.each(['capability', 'repair'] as const)('cleans up after %s initialization fails and preserves its error', async stage => {
  const stateStore = new MemoryServerStateStore();
  const close = vi.spyOn(stateStore, 'close');
  const dispose = vi.fn();
  const failure = new Error('initialization failed');
  const config = options('desktop');
  config.runtime.capabilities = [{ contribute: builder => {
    builder.addDisposable({ dispose });
    if (stage === 'capability') throw failure;
  } }];
  await expect(createProductRuntime({ ...config, application: { stateStore }, beforeRecovery: async () => { throw failure; } })).rejects.toBe(failure);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

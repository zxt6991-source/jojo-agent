import { describe, expect, it } from 'vitest';
import { ChannelAdapterRegistry } from '../src/index.js';
import { FakeChannelAdapter } from '../src/testing.js';

describe('ChannelAdapterRegistry', () => {
  it('registers factories by platform kind without conflating bot instances', async () => {
    const registry = new ChannelAdapterRegistry();
    registry.register({
      kind: 'fake',
      create: async ({ instance }) => new FakeChannelAdapter('fake', instance.id)
    });
    expect(registry.list()).toEqual(['fake']);
    const factory = registry.get('fake');
    const adapter = await factory.create({
      instance: {
        id: 'personal', kind: 'fake', name: 'Personal', enabled: true, config: {}, secretRefs: {},
        revision: 1, fingerprint: 'fp', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
      },
      secrets: { resolve: async () => 'secret' }
    });
    expect(adapter.instanceId).toBe('personal');
    expect(() => registry.register(factory)).toThrow('channel_adapter_already_registered');
  });
});

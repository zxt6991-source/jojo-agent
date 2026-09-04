import { describe, expect, it } from 'vitest';
import { ChannelAdapterRegistry, type ChannelBinding, type ChannelInboundEvent, type ChannelInstance } from '@desktop-agent/channel-core';
import { FakeChannelAdapter } from '@desktop-agent/channel-core/testing';
import {
  DefaultChannelManager,
  MemoryChannelStore,
  type ChannelAgentBridge
} from '../src/index.js';

const now = '2026-08-30T00:00:00.000Z';
const instance: ChannelInstance = {
  id: 'inst', kind: 'fake', name: 'Fake', enabled: true, config: {}, secretRefs: {},
  revision: 1, fingerprint: 'fp', createdAt: now, updatedAt: now
};

function inbound(id = 'evt', dedupeKey = 'message'): ChannelInboundEvent {
  return {
    id, kind: 'message', channel: { kind: 'fake', instanceId: 'inst' },
    conversation: { id: 'chat', type: 'direct' }, sender: { id: 'user' },
    message: { id: 'external-message', text: 'hello' }, receivedAt: now, dedupeKey,
    security: { verified: true, verificationMethod: 'local' }
  };
}

async function setup(binding?: ChannelBinding) {
  const store = new MemoryChannelStore();
  await store.saveInstance(instance);
  if (binding) await store.saveBinding(binding);
  const adapter = new FakeChannelAdapter('fake', 'inst');
  const registry = new ChannelAdapterRegistry();
  registry.register({ kind: 'fake', create: async () => adapter });
  let runs = 0;
  const agent: ChannelAgentBridge = {
    ensureSession: async (activeBinding) => activeBinding.conversation.threadId
      ? `session-${activeBinding.conversation.threadId}`
      : 'session-1',
    run: async ({ sessionId }) => {
      runs += 1;
      return { sessionId, runId: `run-${runs}`, status: 'completed', finalText: 'world' };
    }
  };
  const manager = new DefaultChannelManager({
    store, registry, agent, secrets: { resolve: async () => 'secret' },
    now: () => new Date(now), idGenerator: (() => { let id = 0; return () => `id-${++id}`; })()
  });
  await manager.start();
  return { store, adapter, manager, runs: () => runs };
}

describe('DefaultChannelManager', () => {
  it('tracks adapter reconnect health and clears recovered errors', async () => {
    const { adapter, manager } = await setup();
    adapter.reportHealth({ status: 'degraded', reconnectIncrement: 1 });
    expect((await manager.listHealth())[0]?.health).toMatchObject({ status: 'degraded', reconnectCount: 1 });

    adapter.reportHealth({ status: 'failed', error: 'temporary gateway failure' });
    expect((await manager.listHealth())[0]?.health.lastError).toBe('temporary gateway failure');

    adapter.reportHealth({ status: 'connected' });
    expect((await manager.listHealth())[0]?.health).toEqual({ status: 'connected', reconnectCount: 1 });
    await manager.stop();
  });

  it('binds a chat to one persistent session and deduplicates repeated platform delivery', async () => {
    const binding: ChannelBinding = {
      id: 'binding', instanceId: 'inst', conversation: { id: 'chat', type: 'direct' },
      routing: { sessionMode: 'persistent' },
      policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false },
      revision: 1, createdAt: now, updatedAt: now
    };
    const { store, adapter, manager, runs } = await setup(binding);
    await adapter.receive(inbound());
    await adapter.receive(inbound('evt-again'));

    expect(runs()).toBe(1);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]).toMatchObject({ mode: 'reply', content: [{ type: 'markdown', text: 'world' }] });
    expect(await store.getBinding('binding')).toMatchObject({ routing: { sessionId: 'session-1' } });
    await manager.stop();
  });

  it('does not run the agent for an unknown sender and creates one pairing challenge', async () => {
    const { store, adapter, manager, runs } = await setup();
    await adapter.receive(inbound());
    await adapter.receive(inbound('evt-2', 'message-2'));

    expect(runs()).toBe(0);
    expect(await store.listPairings('pending')).toHaveLength(1);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.content[0]).toMatchObject({ type: 'text' });
    await manager.stop();
  });

  it('does not expose a pairing after its Channel instance is deleted', async () => {
    const { adapter, manager } = await setup();
    await adapter.receive(inbound());
    expect(await manager.listPairings('pending')).toHaveLength(1);

    await manager.deleteInstance(instance.id, instance.revision);
    expect(await manager.listPairings()).toEqual([]);
    await manager.stop();
  });

  it('requires a mention for bound group conversations', async () => {
    const binding: ChannelBinding = {
      id: 'group', instanceId: 'inst', conversation: { id: 'chat', type: 'group' },
      routing: { sessionMode: 'per_thread' },
      policy: { enabled: true, requireMention: true, queueMode: 'queue', allowAttachments: false },
      revision: 1, createdAt: now, updatedAt: now
    };
    const { adapter, manager, runs } = await setup(binding);
    await adapter.receive({ ...inbound(), conversation: { id: 'chat', type: 'group' } });
    expect(runs()).toBe(0);
    expect(adapter.sent).toHaveLength(0);
    await manager.stop();
  });

  it('ignores an unbound group instead of exposing a pairing flow', async () => {
    const { store, adapter, manager, runs } = await setup();
    await adapter.receive({ ...inbound(), conversation: { id: 'chat', type: 'group' } });
    expect(runs()).toBe(0);
    expect(await store.listPairings()).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);
    await manager.stop();
  });

  it('derives a separate persistent binding for each group thread', async () => {
    const binding: ChannelBinding = {
      id: 'group', instanceId: 'inst', conversation: { id: 'chat', type: 'group' },
      routing: { sessionMode: 'per_thread', sessionId: 'base-session' },
      policy: { enabled: true, requireMention: false, queueMode: 'queue', allowAttachments: false },
      revision: 1, createdAt: now, updatedAt: now
    };
    const { store, adapter, manager } = await setup(binding);
    await adapter.receive({ ...inbound(), conversation: { id: 'chat', type: 'group', threadId: 'thread-a' } });
    await adapter.receive({ ...inbound('evt-2', 'message-2'), conversation: { id: 'chat', type: 'group', threadId: 'thread-b' } });
    const bindings = await store.listBindings('inst');
    expect(bindings.filter((item) => item.conversation.threadId)).toHaveLength(2);
    expect(bindings.filter((item) => item.conversation.threadId).map((item) => item.routing.sessionId).sort())
      .toEqual(['session-thread-a', 'session-thread-b']);
    await manager.stop();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ChannelAdapterHealthUpdate, ChannelInboundEvent, ChannelInstance } from '@desktop-agent/channel-core';
import {
  FeishuChannelAdapter,
  createFeishuAdapterFactory,
  parseFeishuConfig,
  type FeishuWsClientFactory,
  type FeishuWsClientOptions
} from '../src/index.js';

const now = '2026-09-01T00:00:00.000Z';

function websocketInstance(config: Record<string, unknown> = {}): ChannelInstance {
  return {
    id: 'feishu-ws', kind: 'feishu', name: 'Feishu WebSocket', enabled: true,
    config: { appId: 'cli_0123456789abcdef', transport: 'websocket', ...config },
    secretRefs: { appSecret: 'secret://feishu/app-secret' },
    revision: 1, fingerprint: 'fp', createdAt: now, updatedAt: now
  };
}

type Dispatcher = {
  invoke(data: unknown, options?: { needCheck?: boolean }): Promise<unknown>;
};

function fakeClient() {
  let hooks!: FeishuWsClientOptions;
  let dispatcher!: Dispatcher;
  const close = vi.fn();
  const createWsClient: FeishuWsClientFactory = (options) => {
    hooks = options;
    return {
      start: async ({ eventDispatcher }) => { dispatcher = eventDispatcher as Dispatcher; },
      close
    };
  };
  return {
    createWsClient,
    close,
    hooks: () => hooks,
    dispatcher: () => dispatcher
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('test_timeout');
}

describe('Feishu WebSocket transport', () => {
  it('defaults new instances to websocket while preserving legacy webhook instances', async () => {
    const fresh = websocketInstance();
    delete fresh.config.transport;
    expect(parseFeishuConfig(fresh).transport).toBe('websocket');

    const legacy = websocketInstance();
    delete legacy.config.transport;
    legacy.secretRefs.verificationToken = 'secret://feishu/verification-token';
    expect(parseFeishuConfig(legacy).transport).toBe('webhook');

    const resolved: string[] = [];
    const adapter = await createFeishuAdapterFactory().create({
      instance: fresh,
      secrets: { resolve: async (reference) => { resolved.push(reference); return 'app-secret'; } }
    });
    expect(resolved).toEqual(['secret://feishu/app-secret']);
    expect(adapter.capabilities.transport).toBe('gateway');
  });

  it('does not resolve start until the first ready callback and closes exactly once', async () => {
    const fake = fakeClient();
    const adapter = new FeishuChannelAdapter({
      instance: websocketInstance(), appSecret: 'app-secret', createWsClient: fake.createWsClient
    });
    let started = false;
    const starting = adapter.start({ signal: new AbortController().signal, emit: () => undefined })
      .then(() => { started = true; });

    await Promise.resolve();
    expect(started).toBe(false);
    fake.hooks().onReady();
    await starting;
    expect(started).toBe(true);

    await adapter.stop();
    await adapter.stop();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledWith({ force: true });
  });

  it('rejects an initial connection error and responds to abort while starting', async () => {
    const failed = fakeClient();
    const adapter = new FeishuChannelAdapter({
      instance: websocketInstance(), appSecret: 'app-secret', createWsClient: failed.createWsClient
    });
    const starting = adapter.start({ signal: new AbortController().signal, emit: () => undefined });
    await Promise.resolve();
    failed.hooks().onError(new Error('pullConnectConfig failed: invalid credential'));
    await expect(starting).rejects.toThrow('feishu_ws_auth_failed');
    expect(failed.close).toHaveBeenCalledTimes(1);

    const aborted = fakeClient();
    const controller = new AbortController();
    const abortingAdapter = new FeishuChannelAdapter({
      instance: websocketInstance(), appSecret: 'app-secret', createWsClient: aborted.createWsClient
    });
    const aborting = abortingAdapter.start({ signal: controller.signal, emit: () => undefined });
    await Promise.resolve();
    controller.abort();
    await expect(aborting).rejects.toThrow('feishu_ws_closed');
    expect(aborted.close).toHaveBeenCalledTimes(1);
  });

  it('reports reconnect lifecycle and restores connected health', async () => {
    const fake = fakeClient();
    const health: ChannelAdapterHealthUpdate[] = [];
    const adapter = new FeishuChannelAdapter({
      instance: websocketInstance(), appSecret: 'app-secret', createWsClient: fake.createWsClient
    });
    const starting = adapter.start({
      signal: new AbortController().signal,
      emit: () => undefined,
      reportHealth: (update) => { health.push(update); }
    });
    await Promise.resolve();
    fake.hooks().onReady();
    await starting;
    fake.hooks().onReconnecting();
    fake.hooks().onReconnected();
    fake.hooks().onError(new Error('WebSocket reconnect exhausted after 3 attempts'));

    expect(health).toEqual([
      { status: 'connected' },
      { status: 'degraded', reconnectIncrement: 1 },
      { status: 'connected' },
      { status: 'failed', error: 'feishu_ws_reconnect_exhausted' }
    ]);
    await adapter.stop();
  });

  it('acknowledges dispatcher events without awaiting agent processing and normalizes trusted messages', async () => {
    const fake = fakeClient();
    const events: ChannelInboundEvent[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new FeishuChannelAdapter({
      instance: websocketInstance(), appSecret: 'app-secret', createWsClient: fake.createWsClient,
      now: () => new Date(now)
    });
    const starting = adapter.start({
      signal: new AbortController().signal,
      emit: async (event) => { events.push(event); await blocked; }
    });
    await Promise.resolve();
    fake.hooks().onReady();
    await starting;

    await expect(fake.dispatcher().invoke({
      schema: '2.0',
      header: { event_id: 'event-ws', event_type: 'im.message.receive_v1', create_time: '1788220800000' },
      event: {
        sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
        message: {
          message_id: 'om_ws', chat_id: 'oc_ws', chat_type: 'p2p', message_type: 'text',
          create_time: '1788220800000', content: JSON.stringify({ text: 'hello over websocket' })
        }
      }
    }, { needCheck: false })).resolves.toBeUndefined();
    await waitFor(() => events.length === 1);
    expect(events[0]).toMatchObject({
      id: 'feishu_feishu-ws_om_ws', kind: 'message',
      conversation: { id: 'oc_ws', type: 'direct' }, sender: { id: 'ou_sender' },
      message: { id: 'om_ws', text: 'hello over websocket' }, dedupeKey: 'message:om_ws',
      security: { verified: true, verificationMethod: 'trusted_gateway' }
    });
    release();

    await expect(fake.dispatcher().invoke({
      schema: '2.0',
      header: { event_id: 'event-card', event_type: 'card.action.trigger', create_time: '1788220800000' },
      event: {
        operator: { open_id: 'ou_sender' },
        action: { value: { actionToken: 'opaque-action-token' } },
        context: { open_chat_id: 'oc_ws', open_message_id: 'om_card' }
      }
    }, { needCheck: false })).resolves.toMatchObject({ toast: { type: 'info' } });
    await waitFor(() => events.length === 2);
    expect(events[1]).toMatchObject({
      kind: 'interaction', conversation: { id: 'oc_ws' }, sender: { id: 'ou_sender' },
      interaction: { actionToken: 'opaque-action-token' }, dedupeKey: 'event:event-card',
      security: { verified: true, verificationMethod: 'trusted_gateway' }
    });
    await adapter.stop();
  });
});

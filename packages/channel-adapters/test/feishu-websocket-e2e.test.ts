import { describe, expect, it } from 'vitest';
import type { ChannelInstance } from '@desktop-agent/channel-core';
import { FeishuChannelAdapter } from '../src/index.js';

const enabled = process.env.FEISHU_E2E === '1';
const suite = enabled ? describe : describe.skip;

suite('Feishu WebSocket real connection', () => {
  it('completes the official SDK handshake and can stop cleanly', async () => {
    const appId = process.env.FEISHU_E2E_APP_ID;
    const appSecret = process.env.FEISHU_E2E_APP_SECRET;
    expect(appId, 'FEISHU_E2E_APP_ID is required').toBeTruthy();
    expect(appSecret, 'FEISHU_E2E_APP_SECRET is required').toBeTruthy();

    const timestamp = new Date().toISOString();
    const instance: ChannelInstance = {
      id: 'feishu-e2e', kind: 'feishu', name: 'Feishu E2E', enabled: true,
      config: { appId, transport: 'websocket' },
      secretRefs: { appSecret: 'secret://env/FEISHU_E2E_APP_SECRET' },
      revision: 1, fingerprint: 'e2e', createdAt: timestamp, updatedAt: timestamp
    };
    const adapter = new FeishuChannelAdapter({ instance, appSecret: appSecret! });
    const controller = new AbortController();

    try {
      await withTimeout(
        adapter.start({ signal: controller.signal, emit: () => undefined }),
        60_000,
        'feishu_e2e_handshake_timeout'
      );
      expect(adapter.capabilities.transport).toBe('gateway');
    } finally {
      controller.abort();
      await adapter.stop();
    }
  }, 70_000);
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

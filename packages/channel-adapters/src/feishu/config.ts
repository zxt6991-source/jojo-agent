import path from 'node:path';
import type { ChannelInstance } from '@desktop-agent/channel-core';

export type FeishuTransport = 'websocket' | 'webhook';

export type FeishuAdapterConfig = {
  appId: string;
  transport: FeishuTransport;
  cacheDirectory: string;
  maxImageBytes: number;
  maxFileBytes: number;
  ws: {
    handshakeTimeoutMs: number;
    pingTimeoutSeconds: number;
  };
};

export function parseFeishuConfig(instance: ChannelInstance): FeishuAdapterConfig {
  const appId = typeof instance.config.appId === 'string' ? instance.config.appId.trim() : '';
  if (!appId) throw new Error('feishu_invalid_config: appId');
  const transport = parseTransport(instance);
  const cacheDirectory = typeof instance.config.cacheDirectory === 'string' && path.isAbsolute(instance.config.cacheDirectory)
    ? instance.config.cacheDirectory
    : path.join(process.cwd(), '.jojo', 'runtime', 'channel-cache');
  const ws = record(instance.config.ws, 'ws');
  return {
    appId,
    transport,
    cacheDirectory,
    maxImageBytes: integer(instance.config.maxImageBytes, 20 * 1024 * 1024, 1, 100 * 1024 * 1024, 'maxImageBytes'),
    maxFileBytes: integer(instance.config.maxFileBytes, 30 * 1024 * 1024, 1, 500 * 1024 * 1024, 'maxFileBytes'),
    ws: {
      handshakeTimeoutMs: integer(ws.handshakeTimeoutMs, 15_000, 1_000, 120_000, 'ws.handshakeTimeoutMs'),
      pingTimeoutSeconds: integer(ws.pingTimeoutSeconds, 10, 1, 300, 'ws.pingTimeoutSeconds')
    }
  };
}

function parseTransport(instance: ChannelInstance): FeishuTransport {
  const value = instance.config.transport;
  if (value === undefined) {
    return instance.secretRefs.verificationToken ? 'webhook' : 'websocket';
  }
  if (value !== 'websocket' && value !== 'webhook') {
    throw new Error('feishu_invalid_config: transport');
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`feishu_invalid_config: ${name}`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`feishu_invalid_config: ${name}`);
  }
  return value;
}

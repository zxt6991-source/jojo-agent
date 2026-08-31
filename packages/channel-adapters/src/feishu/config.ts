import path from 'node:path';
import type { ChannelInstance } from '@desktop-agent/channel-core';

export type FeishuAdapterConfig = {
  appId: string;
  cacheDirectory: string;
  maxImageBytes: number;
  maxFileBytes: number;
};

export function parseFeishuConfig(instance: ChannelInstance): FeishuAdapterConfig {
  const appId = typeof instance.config.appId === 'string' ? instance.config.appId.trim() : '';
  if (!appId) throw new Error('feishu_invalid_config: appId');
  const cacheDirectory = typeof instance.config.cacheDirectory === 'string' && path.isAbsolute(instance.config.cacheDirectory)
    ? instance.config.cacheDirectory
    : path.join(process.cwd(), '.jojo', 'runtime', 'channel-cache');
  return {
    appId,
    cacheDirectory,
    maxImageBytes: integer(instance.config.maxImageBytes, 20 * 1024 * 1024, 1, 100 * 1024 * 1024, 'maxImageBytes'),
    maxFileBytes: integer(instance.config.maxFileBytes, 30 * 1024 * 1024, 1, 500 * 1024 * 1024, 'maxFileBytes')
  };
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`feishu_invalid_config: ${name}`);
  }
  return value;
}

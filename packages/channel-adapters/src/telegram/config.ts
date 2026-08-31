import path from 'node:path';
import type { ChannelInstance } from '@desktop-agent/channel-core';

export type TelegramAdapterConfig = {
  pollingTimeoutSeconds: number;
  retryBaseMs: number;
  retryMaxMs: number;
  cacheDirectory: string;
  maxImageBytes: number;
  maxFileBytes: number;
};

export function parseTelegramConfig(instance: ChannelInstance): TelegramAdapterConfig {
  const config = instance.config;
  const pollingTimeoutSeconds = number(config.pollingTimeoutSeconds, 30, 1, 50, 'pollingTimeoutSeconds');
  const retryBaseMs = number(config.retryBaseMs, 1_000, 10, 60_000, 'retryBaseMs');
  const retryMaxMs = number(config.retryMaxMs, 60_000, retryBaseMs, 300_000, 'retryMaxMs');
  const cacheDirectory = typeof config.cacheDirectory === 'string' && path.isAbsolute(config.cacheDirectory)
    ? config.cacheDirectory
    : path.join(process.cwd(), '.jojo', 'runtime', 'channel-cache');
  return {
    pollingTimeoutSeconds, retryBaseMs, retryMaxMs, cacheDirectory,
    maxImageBytes: number(config.maxImageBytes, 20 * 1024 * 1024, 1, 100 * 1024 * 1024, 'maxImageBytes'),
    maxFileBytes: number(config.maxFileBytes, 50 * 1024 * 1024, 1, 500 * 1024 * 1024, 'maxFileBytes')
  };
}

function number(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`telegram_invalid_config: ${name}`);
  }
  return value;
}

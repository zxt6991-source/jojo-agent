import type { ChannelAdapterFactory } from '@desktop-agent/channel-core';
import { TelegramChannelAdapter, type TelegramAdapterOptions } from './adapter.js';

export type TelegramAdapterFactoryOptions = Pick<TelegramAdapterOptions, 'apiBaseUrl' | 'fetch' | 'now' | 'random'>;

export function createTelegramAdapterFactory(options: TelegramAdapterFactoryOptions = {}): ChannelAdapterFactory {
  return {
    kind: 'telegram',
    create: async ({ instance, secrets }) => {
      const reference = instance.secretRefs.botToken;
      if (!reference) throw new Error('telegram_bot_token_reference_missing');
      return new TelegramChannelAdapter({
        instance,
        botToken: await secrets.resolve(reference),
        ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.random ? { random: options.random } : {})
      });
    }
  };
}

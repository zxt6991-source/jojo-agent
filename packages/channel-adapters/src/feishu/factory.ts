import type { ChannelAdapterFactory } from '@desktop-agent/channel-core';
import { FeishuChannelAdapter, type FeishuAdapterOptions } from './adapter.js';
import { parseFeishuConfig } from './config.js';

export type FeishuAdapterFactoryOptions = Pick<FeishuAdapterOptions, 'apiBaseUrl' | 'fetch' | 'now' | 'createWsClient'>;

export function createFeishuAdapterFactory(options: FeishuAdapterFactoryOptions = {}): ChannelAdapterFactory {
  return {
    kind: 'feishu',
    create: async ({ instance, secrets }) => {
      const config = parseFeishuConfig(instance);
      const appSecretReference = instance.secretRefs.appSecret;
      if (!appSecretReference) throw new Error('feishu_app_secret_reference_missing');
      const shared = {
        instance,
        appSecret: await secrets.resolve(appSecretReference),
        ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.createWsClient ? { createWsClient: options.createWsClient } : {})
      };
      if (config.transport === 'websocket') return new FeishuChannelAdapter(shared);

      const verificationTokenReference = instance.secretRefs.verificationToken;
      const encryptKeyReference = instance.secretRefs.encryptKey;
      if (!verificationTokenReference) throw new Error('feishu_verification_token_reference_missing');
      return new FeishuChannelAdapter({
        ...shared,
        verificationToken: await secrets.resolve(verificationTokenReference),
        ...(encryptKeyReference ? { encryptKey: await secrets.resolve(encryptKeyReference) } : {})
      });
    }
  };
}

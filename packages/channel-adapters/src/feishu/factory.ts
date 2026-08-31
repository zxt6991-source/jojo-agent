import type { ChannelAdapterFactory } from '@desktop-agent/channel-core';
import { FeishuChannelAdapter, type FeishuAdapterOptions } from './adapter.js';

export type FeishuAdapterFactoryOptions = Pick<FeishuAdapterOptions, 'apiBaseUrl' | 'fetch' | 'now'>;

export function createFeishuAdapterFactory(options: FeishuAdapterFactoryOptions = {}): ChannelAdapterFactory {
  return {
    kind: 'feishu',
    create: async ({ instance, secrets }) => {
      const appSecretReference = instance.secretRefs.appSecret;
      const verificationTokenReference = instance.secretRefs.verificationToken;
      const encryptKeyReference = instance.secretRefs.encryptKey;
      if (!appSecretReference) throw new Error('feishu_app_secret_reference_missing');
      if (!verificationTokenReference) throw new Error('feishu_verification_token_reference_missing');
      return new FeishuChannelAdapter({
        instance,
        appSecret: await secrets.resolve(appSecretReference),
        verificationToken: await secrets.resolve(verificationTokenReference),
        ...(encryptKeyReference ? { encryptKey: await secrets.resolve(encryptKeyReference) } : {}),
        ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {})
      });
    }
  };
}

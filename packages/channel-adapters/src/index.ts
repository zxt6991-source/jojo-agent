export { FakeChannelAdapter, FAKE_CHANNEL_CAPABILITIES } from './fake/adapter.js';
export { TelegramChannelAdapter, TELEGRAM_CAPABILITIES } from './telegram/adapter.js';
export type { TelegramAdapterOptions } from './telegram/adapter.js';
export { createTelegramAdapterFactory } from './telegram/factory.js';
export type { TelegramAdapterFactoryOptions } from './telegram/factory.js';
export type { TelegramAdapterConfig } from './telegram/config.js';
export {
  FeishuChannelAdapter,
  FEISHU_CAPABILITIES,
  FEISHU_WEBHOOK_CAPABILITIES,
  FEISHU_WS_CAPABILITIES
} from './feishu/adapter.js';
export {
  DefaultFeishuWebSocketTransport,
  createDefaultFeishuWsClient
} from './feishu/transport/websocket.js';
export type {
  FeishuWebSocketTransport,
  FeishuWebSocketTransportOptions,
  FeishuWsClient,
  FeishuWsClientFactory,
  FeishuWsClientOptions
} from './feishu/transport/websocket.js';
export type { FeishuAdapterOptions } from './feishu/adapter.js';
export { createFeishuAdapterFactory } from './feishu/factory.js';
export type { FeishuAdapterFactoryOptions } from './feishu/factory.js';
export { parseFeishuConfig } from './feishu/config.js';
export type { FeishuAdapterConfig, FeishuTransport } from './feishu/config.js';

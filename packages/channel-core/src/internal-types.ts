import type {
  ChannelCapabilities,
  ChannelEditRequest,
  ChannelInboundEvent,
  ChannelInstance,
  ChannelKind,
  ChannelSendReceipt,
  ChannelSendRequest,
  ChannelTypingRequest,
  ChannelValidationResult,
  ChannelWebhookRequest,
  ChannelWebhookResponse
} from './types.js';

export type ChannelAdapterHealthUpdate = {
  status: 'connected' | 'degraded' | 'failed';
  error?: string;
  reconnectIncrement?: number;
};

export interface ChannelSecretResolver {
  resolve(reference: string): Promise<string>;
}

export type ChannelAdapterContext = {
  emit(event: ChannelInboundEvent): void | Promise<void>;
  reportHealth?(update: ChannelAdapterHealthUpdate): void;
  signal: AbortSignal;
};

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly instanceId: string;
  readonly capabilities: ChannelCapabilities;
  validateConfig(): Promise<ChannelValidationResult>;
  start(context: ChannelAdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(request: ChannelSendRequest): Promise<ChannelSendReceipt>;
  edit?(request: ChannelEditRequest): Promise<ChannelSendReceipt>;
  setTyping?(request: ChannelTypingRequest): Promise<void>;
  handleWebhook?(request: ChannelWebhookRequest): Promise<ChannelWebhookResponse>;
}

export interface ChannelAdapterFactory {
  readonly kind: ChannelKind;
  create(input: { instance: ChannelInstance; secrets: ChannelSecretResolver }): Promise<ChannelAdapter>;
}

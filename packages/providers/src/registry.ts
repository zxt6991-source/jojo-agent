import type { ModelProvider, ProviderConfig, ProviderProtocol } from '@desktop-agent/contracts';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';

export type ProviderRegistration = {
  protocol: ProviderProtocol;
  vendor: string;
  displayName: string;
  defaultBaseUrl: string;
  supportsModelDiscovery: boolean;
};

export const PROVIDER_REGISTRY: readonly ProviderRegistration[] = [
  {
    protocol: 'openai_chat_completions', vendor: 'openai-compatible', displayName: 'OpenAI Chat Completions',
    defaultBaseUrl: 'https://api.openai.com/v1', supportsModelDiscovery: true
  }
];

export type DiscoverableModelProvider = ModelProvider & { listModels(): Promise<string[]> };

export function createProvider(config: ProviderConfig, apiKey: string, timeoutMs?: number): DiscoverableModelProvider {
  const options = { apiKey, baseUrl: config.baseUrl, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  return new OpenAICompatibleProvider(options);
}

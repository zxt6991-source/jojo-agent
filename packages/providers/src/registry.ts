import type {
  Disposable,
  JsonValue,
  ModelProvider,
  ProviderConfig,
  ProviderContribution,
  ProviderProtocol
} from '@desktop-agent/contracts';
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

/** Dynamic preview registry used by the Extension Contribution adapter. */
export class ProviderRegistry {
  private readonly contributions = new Map<string, ProviderContribution>();
  private registryVersion = 0;

  get version(): number { return this.registryVersion; }

  register(contribution: ProviderContribution): Disposable {
    if (!/^[a-z][a-z0-9_.:-]{0,159}$/u.test(contribution.id)) {
      throw new Error(`provider_invalid_id: ${contribution.id}`);
    }
    if (this.contributions.has(contribution.id)) {
      throw new Error(`provider_duplicate_id: ${contribution.id}`);
    }
    this.contributions.set(contribution.id, contribution);
    this.registryVersion += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.contributions.get(contribution.id) === contribution) {
          this.contributions.delete(contribution.id);
          this.registryVersion += 1;
        }
      }
    };
  }

  has(id: string): boolean { return this.contributions.has(id); }

  list(): ProviderContribution[] {
    return [...this.contributions.values()].map((contribution) => ({
      ...contribution,
      capabilities: { ...contribution.capabilities }
    }));
  }

  async create(id: string, config: JsonValue): Promise<ModelProvider> {
    const contribution = this.contributions.get(id);
    if (!contribution) throw new Error(`provider_not_found: ${id}`);
    return contribution.create(structuredClone(config));
  }
}

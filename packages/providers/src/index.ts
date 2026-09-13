export { OpenAICompatibleProvider } from './openai-compatible-provider.js';
export { OpenAICompatibleEmbeddingProvider } from './openai-compatible-embedding-provider.js';
export { PROVIDER_REGISTRY, ProviderRegistry, createProvider } from './registry.js';
export type { OpenAIProviderOptions, ProviderRequestDiagnostic } from './types.js';
export type { DiscoverableModelProvider, ProviderRegistration } from './registry.js';
export { serializeAttachmentForModel } from './attachment-serialization.js';
export type { RequestPolicy } from './request-policy.js';

export { resolveModelMetadata, mergeRefreshedModels } from './model-metadata/resolver.js';
export { lookupBuiltinModel } from './model-metadata/builtin-registry.js';
export { ModelDiscoveryRefresh } from './model-metadata/refresh.js';

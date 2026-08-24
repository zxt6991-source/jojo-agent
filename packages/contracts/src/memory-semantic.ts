import type { MemoryKind, MemoryScopeKind } from './memory.js';

export type EmbeddingUsage = {
  inputTokens?: number;
  costUsd?: number;
};

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly remote: boolean;
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<{
    vectors: Float32Array[];
    usage?: EmbeddingUsage;
  }>;
}

export type EmbeddingIndexFingerprint = {
  providerId: string;
  model: string;
  dimensions: number;
  chunkingVersion: number;
  normalizationVersion: number;
};

export type MemoryChunk = {
  id: string;
  entryId: string;
  scopeId: string;
  file: string;
  headingPath: string[];
  kind: MemoryKind;
  status: 'proposed' | 'confirmed';
  title?: string;
  content: string;
  contentHash: string;
  updatedAt: number;
};

export type SemanticCapabilities = {
  enabled: boolean;
  mode: 'local-linear' | 'local-vector' | 'remote-vector';
  embeddingProviderId: string;
  embeddingModel: string;
  dimensions?: number;
  supportsIncrementalIndex: boolean;
};

export type SemanticSearchHit = {
  chunkId: string;
  entryId: string;
  scopeId: string;
  contentHash: string;
  similarity: number;
};

export type SemanticIndexStatus = {
  enabled: boolean;
  mode: 'local-linear' | 'plugin-vector';
  providerId?: string;
  model?: string;
  indexedChunks: number;
  pending: number;
  failed: number;
  skippedSecret: number;
  stale: number;
  lastRebuildAt?: number;
  warning?: string;
};

export type MemorySearchHit = {
  id: string;
  scope: MemoryScopeKind;
  kind: MemoryKind;
  title?: string;
  snippet: string;
  sourceFile: string;
  heading?: string;
  updatedAt: string;
  retrieval: {
    ftsRank?: number;
    semanticRank?: number;
    semanticSimilarity?: number;
    fusedScore: number;
    modes: Array<'fts' | 'semantic'>;
  };
};

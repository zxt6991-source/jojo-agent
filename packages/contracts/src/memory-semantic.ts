import { z } from 'zod';
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

export const SemanticIndexStatusSchema = z.object({
  enabled: z.boolean(), mode: z.enum(['local-linear', 'plugin-vector']),
  providerId: z.string().max(256).optional(), model: z.string().max(256).optional(),
  indexedChunks: z.number().int().nonnegative(), pending: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(), skippedSecret: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(), lastRebuildAt: z.number().int().nonnegative().optional(),
  warning: z.string().max(20_000).optional()
}).strict();
export type SemanticIndexStatus = z.infer<typeof SemanticIndexStatusSchema>;

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

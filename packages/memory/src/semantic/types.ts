import type {
  EmbeddingProvider,
  MemoryChunk,
  MemoryKind,
  SemanticCapabilities,
  SemanticIndexStatus,
  SemanticSearchHit
} from '@desktop-agent/contracts';

export type SemanticSkippedChunk = Pick<MemoryChunk, 'id' | 'entryId' | 'scopeId' | 'contentHash'> & {
  reason: 'secret';
};

export type SemanticIndexRequest = {
  chunks: MemoryChunk[];
  skipped: SemanticSkippedChunk[];
  provider: EmbeddingProvider;
  chunkingVersion: number;
  normalizationVersion: number;
  signal?: AbortSignal;
  replaceScopeIds?: string[];
  onUsage?: (usage: { inputTokens?: number; costUsd?: number; indexedChunks: number }) => void;
};

export type SemanticIndexResult = {
  indexed: number;
  unchanged: number;
  removed: number;
  skippedSecret: number;
  dimensions?: number;
};

export type SemanticSearchRequest = {
  vector: Float32Array;
  providerId: string;
  model: string;
  chunkingVersion: number;
  normalizationVersion: number;
  scopeIds: string[];
  kinds?: MemoryKind[];
  maxCandidates: number;
  limit: number;
};

export interface SemanticMemoryBackend {
  capabilities(providerId: string, model: string): Promise<SemanticCapabilities>;
  ensureIndexed(input: SemanticIndexRequest): Promise<SemanticIndexResult>;
  search(input: SemanticSearchRequest): Promise<SemanticSearchHit[]>;
  remove(input: { entryIds: string[] }): Promise<void>;
  rebuild(input: SemanticIndexRequest): Promise<SemanticIndexResult>;
  status(input: { enabled: boolean; mode: 'local-linear' | 'plugin-vector'; providerId?: string; model?: string }): Promise<SemanticIndexStatus>;
}

export type SemanticLifecycleEvent = {
  event:
    | 'memory.embedding.job.queued'
    | 'memory.embedding.completed'
    | 'memory.embedding.failed'
    | 'memory.semantic.search.started'
    | 'memory.semantic.search.completed'
    | 'memory.semantic.search.fallback'
    | 'memory.semantic.rebuild.started'
    | 'memory.semantic.rebuild.progress'
    | 'memory.semantic.rebuild.completed'
    | 'memory.semantic.model.changed';
  count?: number;
  warning?: string;
};

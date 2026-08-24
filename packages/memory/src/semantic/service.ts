import type {
  EmbeddingProvider,
  MemoryEntry,
  MemoryKind,
  MemoryScope,
  MemorySettings,
  ProjectIdentity,
  SemanticIndexStatus
} from '@desktop-agent/contracts';
import { DEFAULT_MEMORY_SETTINGS, MemoryError } from '@desktop-agent/contracts';
import { scanSecrets } from '../security/secret-scanner.js';
import type { MarkdownMemoryStore } from '../store/markdown-store.js';
import {
  MEMORY_CHUNKING_VERSION,
  MEMORY_NORMALIZATION_VERSION,
  memoryChunks
} from './chunker.js';
import type { SemanticLifecycleEvent, SemanticMemoryBackend } from './types.js';

export type SemanticProviderResolver = (selection: { providerId: string; model: string }) => EmbeddingProvider | undefined;

export class SemanticMemoryService {
  private settings: MemorySettings = DEFAULT_MEMORY_SETTINGS;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    readonly store: MarkdownMemoryStore,
    readonly backend: SemanticMemoryBackend,
    private readonly resolveProvider: SemanticProviderResolver,
    private readonly emit: (event: SemanticLifecycleEvent) => void = () => undefined,
    private readonly recordUsage: (usage: {
      sessionId?: string;
      providerId: string;
      model: string;
      inputTokens?: number;
      costUsd?: number;
      indexedChunks: number;
      query: boolean;
    }) => void = () => undefined
  ) {}

  updateSettings(settings: MemorySettings): void {
    const previous = this.settings.semantic;
    this.settings = structuredClone(settings);
    if (previous.providerId !== settings.semantic.providerId || previous.model !== settings.semantic.model) {
      this.emit({ event: 'memory.semantic.model.changed' });
    }
  }

  attach(): void {
    this.store.setDerivedProjectionRefresher((scope) => this.schedule(scope));
  }

  private provider(): EmbeddingProvider {
    const semantic = this.settings.semantic;
    if (!semantic.enabled) throw new MemoryError('memory_semantic_disabled', 'Semantic Memory is disabled.');
    if (semantic.mode !== 'local-linear') {
      throw new MemoryError('memory_embedding_provider_unavailable', 'The selected Semantic backend is unavailable.');
    }
    if (!semantic.providerId || !semantic.model) {
      throw new MemoryError('memory_embedding_provider_unavailable', 'Embedding Provider is not configured.');
    }
    const provider = this.resolveProvider({ providerId: semantic.providerId, model: semantic.model });
    if (!provider) throw new MemoryError('memory_embedding_provider_unavailable', 'Embedding Provider is unavailable.');
    if (provider.remote && !semantic.remoteAllowed) {
      throw new MemoryError('memory_remote_embedding_not_allowed', 'Remote embedding requires explicit privacy opt-in.');
    }
    return provider;
  }

  schedule(scope: MemoryScope): Promise<void> {
    if (!this.settings.semantic.enabled) return Promise.resolve();
    this.emit({ event: 'memory.embedding.job.queued' });
    const previous = this.queues.get(scope.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.indexScope(scope, true)).catch((error) => {
      this.emit({ event: 'memory.embedding.failed', warning: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (this.queues.get(scope.id) === next) this.queues.delete(scope.id);
    });
    this.queues.set(scope.id, next);
    return next;
  }

  async idle(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  async rebuild(input: { projectIdentity?: ProjectIdentity; signal?: AbortSignal }): Promise<SemanticIndexStatus> {
    if (!this.settings.semantic.enabled) throw new MemoryError('memory_semantic_disabled', 'Semantic Memory is disabled.');
    this.emit({ event: 'memory.semantic.rebuild.started' });
    try {
      const scopes = (await this.store.scopes(input.projectIdentity))
        .filter((scope) => scope.kind === 'global' ? this.settings.globalEnabled : this.settings.projectEnabled);
      let completed = 0;
      for (const scope of scopes) {
        if (input.signal?.aborted) throw input.signal.reason;
        await this.indexScope(scope, true, input.signal);
        completed += 1;
        this.emit({ event: 'memory.semantic.rebuild.progress', count: completed });
      }
      this.emit({ event: 'memory.semantic.rebuild.completed', count: completed });
      return this.status();
    } catch (error) {
      this.emit({ event: 'memory.embedding.failed', warning: error instanceof Error ? error.message : String(error) });
      throw new MemoryError('memory_semantic_rebuild_failed', error instanceof Error ? error.message : String(error));
    }
  }

  private async indexScope(scope: MemoryScope, rebuild: boolean, signal?: AbortSignal): Promise<void> {
    const provider = this.provider();
    const entries = (await this.store.listEntries(scope)).entries;
    const chunks = memoryChunks(scope, entries, this.settings.semantic);
    const sourceSessionId = entries.find((entry) => entry.sourceSessionId)?.sourceSessionId;
    const safe = [];
    const skipped = [];
    for (const chunk of chunks) {
      if (scanSecrets(chunk.content).length) skipped.push({
        id: chunk.id,
        entryId: chunk.entryId,
        scopeId: chunk.scopeId,
        contentHash: chunk.contentHash,
        reason: 'secret' as const
      });
      else safe.push(chunk);
    }
    const request = {
      chunks: safe,
      skipped,
      provider,
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      normalizationVersion: MEMORY_NORMALIZATION_VERSION,
      ...(signal ? { signal } : {}),
      ...(rebuild ? { replaceScopeIds: [scope.id] } : {}),
      onUsage: (usage: { inputTokens?: number; costUsd?: number; indexedChunks: number }) => this.recordUsage({
        ...(sourceSessionId ? { sessionId: sourceSessionId } : {}),
        providerId: provider.id,
        model: provider.model,
        ...usage,
        query: false
      })
    };
    const result = rebuild ? await this.backend.rebuild(request) : await this.backend.ensureIndexed(request);
    this.emit({ event: 'memory.embedding.completed', count: result.indexed });
  }

  async search(input: {
    query: string;
    scopes: MemoryScope[];
    kinds?: MemoryKind[];
    sessionId?: string;
    signal?: AbortSignal;
  }): Promise<Array<{ entry: MemoryEntry; similarity: number }>> {
    const provider = this.provider();
    this.emit({ event: 'memory.semantic.search.started' });
    try {
      const embedded = await provider.embed([input.query], { ...(input.signal ? { signal: input.signal } : {}) });
      const vector = embedded.vectors[0];
      if (!vector?.length) throw new MemoryError('memory_embedding_failed', 'Query embedding was empty.');
      this.recordUsage({
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        providerId: provider.id,
        model: provider.model,
        ...embedded.usage,
        indexedChunks: 0,
        query: true
      });
      const hits = await this.backend.search({
        vector,
        providerId: provider.id,
        model: provider.model,
        chunkingVersion: MEMORY_CHUNKING_VERSION,
        normalizationVersion: MEMORY_NORMALIZATION_VERSION,
        scopeIds: input.scopes.map((scope) => scope.id),
        ...(input.kinds ? { kinds: input.kinds } : {}),
        maxCandidates: this.settings.semantic.maxSemanticCandidates,
        limit: 20
      });
      const entries = (await Promise.all(input.scopes.map((scope) => this.store.listEntries(scope))))
        .flatMap((result) => result.entries);
      const chunks = new Map(input.scopes.flatMap((scope) => memoryChunks(
        scope,
        entries.filter((entry) => entry.scopeId === scope.id),
        this.settings.semantic
      )).map((chunk) => [chunk.id, chunk] as const));
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));
      const byEntry = new Map<string, { entry: MemoryEntry; similarity: number }>();
      const staleScopes = new Set<string>();
      for (const hit of hits) {
        const chunk = chunks.get(hit.chunkId);
        const entry = entryById.get(hit.entryId);
        if (!chunk || !entry || chunk.contentHash !== hit.contentHash || chunk.scopeId !== hit.scopeId) {
          staleScopes.add(hit.scopeId);
          continue;
        }
        const current = byEntry.get(entry.id);
        if (!current || current.similarity < hit.similarity) byEntry.set(entry.id, { entry, similarity: hit.similarity });
      }
      for (const scope of input.scopes) if (staleScopes.has(scope.id)) void this.schedule(scope);
      const result = [...byEntry.values()].sort((left, right) => right.similarity - left.similarity);
      this.emit({ event: 'memory.semantic.search.completed', count: result.length });
      return result;
    } catch (error) {
      this.emit({ event: 'memory.semantic.search.fallback', warning: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async status(): Promise<SemanticIndexStatus> {
    const semantic = this.settings.semantic;
    const status = await this.backend.status({
      enabled: semantic.enabled,
      mode: semantic.mode,
      ...(semantic.providerId ? { providerId: semantic.providerId } : {}),
      ...(semantic.model ? { model: semantic.model } : {})
    });
    if (!semantic.enabled) return status;
    try { this.provider(); return status; }
    catch (error) {
      return { ...status, warning: error instanceof Error ? error.message : String(error) };
    }
  }
}

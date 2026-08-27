import type {
  ContextBlock,
  ContextContribution,
  ContextContributionRequest,
  ContextContributor,
  ContributionOwner,
  Disposable
} from '@desktop-agent/contracts';

const LOCAL_CONTEXT_ID = /^[a-z][a-z0-9_-]{0,127}$/u;

type Registration = {
  id: string;
  owner: ContributionOwner;
  contributor: ContextContributor;
};

type CachedContribution = {
  version: number;
  contribution: ContextContribution;
};

export type ContextContributionTrace = {
  contributorId: string;
  status: 'contributed' | 'cached' | 'failed';
  blockCount: number;
  durationMs: number;
  error?: string;
};

export type ContextBuildResult = {
  blocks: ContextBlock[];
  trace: ContextContributionTrace[];
  totalCharacters: number;
  truncated: boolean;
};

function contributionId(owner: ContributionOwner, localId: string): string {
  return owner.source === 'builtin' ? localId : `${owner.id}:${localId}`;
}

function cloneContribution(contribution: ContextContribution): ContextContribution {
  return { blocks: contribution.blocks.map((block) => ({ ...block })) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ContextContributionRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly stableCache = new Map<string, CachedContribution>();
  private readonly sessionCache = new Map<string, CachedContribution>();
  private readonly turnCache = new Map<string, CachedContribution>();
  private registryVersion = 0;

  get version(): number { return this.registryVersion; }

  register(owner: ContributionOwner, contributor: ContextContributor): Disposable {
    if (!LOCAL_CONTEXT_ID.test(contributor.id)) {
      throw new Error(`extension_context_invalid_id: ${contributor.id}`);
    }
    const id = contributionId(owner, contributor.id);
    if (this.registrations.has(id)) throw new Error(`extension_context_duplicate_id: ${id}`);
    const registration = { id, owner: { ...owner }, contributor };
    this.registrations.set(id, registration);
    this.registryVersion += 1;
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.registrations.get(id) === registration) {
          this.registrations.delete(id);
          this.clearContributorCache(id);
          this.registryVersion += 1;
        }
      }
    };
  }

  async build(
    request: ContextContributionRequest,
    options: { maxCharacters?: number } = {}
  ): Promise<ContextBuildResult> {
    const contributions = await Promise.all(
      [...this.registrations.values()].map((registration) => this.invoke(registration, request))
    );
    const trace = contributions.map((entry) => entry.trace);
    const deduped = new Map<string, ContextBlock>();
    for (const entry of contributions) {
      for (const block of entry.contribution?.blocks ?? []) {
        const key = `${block.kind}:${block.id}`;
        const existing = deduped.get(key);
        if (!existing || block.priority > existing.priority) deduped.set(key, block);
      }
    }
    const sorted = [...deduped.values()].sort((left, right) => (
      right.priority - left.priority || left.source.localeCompare(right.source) || left.id.localeCompare(right.id)
    ));
    const maxCharacters = options.maxCharacters ?? Number.POSITIVE_INFINITY;
    const blocks: ContextBlock[] = [];
    let totalCharacters = 0;
    let truncated = false;
    for (const block of sorted) {
      if (totalCharacters + block.content.length > maxCharacters) {
        truncated = true;
        continue;
      }
      blocks.push({ ...block });
      totalCharacters += block.content.length;
    }
    return { blocks, trace, totalCharacters, truncated };
  }

  clearSession(sessionId: string): void {
    for (const key of this.sessionCache.keys()) if (key.startsWith(`${sessionId}:`)) this.sessionCache.delete(key);
    for (const key of this.turnCache.keys()) if (key.startsWith(`${sessionId}:`)) this.turnCache.delete(key);
  }

  private async invoke(
    registration: Registration,
    request: ContextContributionRequest
  ): Promise<{ contribution?: ContextContribution; trace: ContextContributionTrace }> {
    const startedAt = Date.now();
    const cached = this.cached(registration.id, request);
    if (cached) {
      return {
        contribution: cloneContribution(cached),
        trace: { contributorId: registration.id, status: 'cached', blockCount: cached.blocks.length, durationMs: 0 }
      };
    }
    try {
      if (request.signal.aborted) throw request.signal.reason ?? new Error('context_contribution_cancelled');
      const raw = await registration.contributor.contribute(request);
      const contribution = this.normalize(registration, raw);
      this.cache(registration.id, request, contribution);
      return {
        contribution,
        trace: {
          contributorId: registration.id,
          status: 'contributed',
          blockCount: contribution.blocks.length,
          durationMs: Date.now() - startedAt
        }
      };
    } catch (error) {
      return {
        trace: {
          contributorId: registration.id,
          status: 'failed',
          blockCount: 0,
          durationMs: Date.now() - startedAt,
          error: errorText(error)
        }
      };
    }
  }

  private normalize(registration: Registration, contribution: ContextContribution): ContextContribution {
    if (!contribution || !Array.isArray(contribution.blocks)) {
      throw new Error(`extension_context_invalid_result: ${registration.id}`);
    }
    return {
      blocks: contribution.blocks.map((block) => {
        if (!LOCAL_CONTEXT_ID.test(block.id) || typeof block.content !== 'string' || !Number.isFinite(block.priority)) {
          throw new Error(`extension_context_invalid_block: ${registration.id}`);
        }
        return {
          ...block,
          id: contributionId(registration.owner, block.id),
          source: registration.owner.id
        };
      })
    };
  }

  private cached(id: string, request: ContextContributionRequest): ContextContribution | undefined {
    const candidates = [
      this.turnCache.get(`${request.sessionId}:${request.runId}:${id}`),
      this.sessionCache.get(`${request.sessionId}:${id}`),
      this.stableCache.get(id)
    ];
    const cached = candidates.find((entry) => entry?.version === this.registryVersion);
    return cached ? cached.contribution : undefined;
  }

  private cache(id: string, request: ContextContributionRequest, contribution: ContextContribution): void {
    if (contribution.blocks.length === 0) return;
    const policies = new Set(contribution.blocks.map((block) => block.cachePolicy));
    if (policies.size !== 1) return;
    const policy = contribution.blocks[0]?.cachePolicy;
    if (!policy) return;
    const cached = { version: this.registryVersion, contribution: cloneContribution(contribution) };
    if (policy === 'stable') this.stableCache.set(id, cached);
    else if (policy === 'session') this.sessionCache.set(`${request.sessionId}:${id}`, cached);
    else this.turnCache.set(`${request.sessionId}:${request.runId}:${id}`, cached);
  }

  private clearContributorCache(id: string): void {
    this.stableCache.delete(id);
    for (const key of this.sessionCache.keys()) if (key.endsWith(`:${id}`)) this.sessionCache.delete(key);
    for (const key of this.turnCache.keys()) if (key.endsWith(`:${id}`)) this.turnCache.delete(key);
  }
}

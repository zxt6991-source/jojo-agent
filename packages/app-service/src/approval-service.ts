import { createHash } from 'node:crypto';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { ApprovalBroker, RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { ApprovalDecision, PendingApprovalSnapshot } from '@desktop-agent/server-protocol';
import type { ApprovalStore, PersistedApprovalPreview } from './persistence.js';

type PendingApproval = {
  snapshot: PendingApprovalSnapshot;
  settle(decision: boolean): void;
};

export type ApprovalEvent =
  | { type: 'approval.required'; approval: PendingApprovalSnapshot }
  | { type: 'approval.resolved'; approval: PendingApprovalSnapshot; decision: ApprovalDecision };

export type ServerApprovalBrokerOptions = {
  store?: ApprovalStore;
  now?: () => Date;
};

export class ServerApprovalBroker implements ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();
  private store: ApprovalStore | undefined;
  private readonly now: () => Date;

  constructor(options: ServerApprovalBrokerOptions | (() => Date) = {}) {
    if (typeof options === 'function') {
      this.now = options;
    } else {
      this.store = options.store;
      this.now = options.now ?? (() => new Date());
    }
  }

  bindStore(store: ApprovalStore): void {
    if (this.pending.size > 0) throw new Error('approval_store_bind_after_use');
    this.store = store;
  }

  async requestApproval(
    request: ApprovalRequest,
    context: RuntimeResolutionContext,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const store = this.requireStore();
    const id = request.requestId;
    if (this.pending.has(id)) throw new Error(`approval_exists: ${id}`);
    const snapshot: PendingApprovalSnapshot = {
      id,
      sessionId: context.sessionId,
      laneId: context.laneId,
      runId: context.runId,
      createdAt: this.now().toISOString(),
      request
    };
    const preview = persistablePreview(request);
    await store.createPending({
      id,
      sessionId: context.sessionId,
      laneId: context.laneId,
      runId: context.runId,
      toolCallId: request.call.id,
      toolName: request.call.name,
      reason: request.reason,
      requestHash: approvalHash(request, preview),
      ...(preview ? { preview } : {})
    });
    if (signal.aborted) {
      await store.interrupt(id, 'runtime_aborted');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (decision: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(decision);
      };
      const onAbort = () => { void this.abort(id, settle); };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { snapshot, settle });
      this.emit({ type: 'approval.required', approval: structuredClone(snapshot) });
      if (signal.aborted) onAbort();
    });
  }

  list(sessionId?: string): PendingApprovalSnapshot[] {
    return [...this.pending.values()]
      .map((item) => item.snapshot)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }

  async resolve(id: string, decision: ApprovalDecision, principalId?: string): Promise<void> {
    const store = this.requireStore();
    const pending = this.pending.get(id);
    if (!pending) {
      const durable = await store.get(id);
      if (!durable) throw new Error(`approval_not_found: ${id}`);
      if (durable.status === 'interrupted') throw new Error(`approval_interrupted: ${id}`);
      if (durable.decision === decision) return;
      throw new Error(`approval_already_resolved: ${id}`);
    }
    await store.resolve(id, decision, principalId);
    pending.settle(decision === 'allow');
    this.emit({
      type: 'approval.resolved',
      approval: structuredClone(pending.snapshot),
      decision
    });
  }

  async interruptAll(reason: string): Promise<void> {
    for (const [id, pending] of [...this.pending]) {
      await this.requireStore().interrupt(id, reason);
      pending.settle(false);
    }
  }

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async abort(id: string, settle: (decision: boolean) => void): Promise<void> {
    let decision = false;
    try {
      const record = await this.requireStore().interrupt(id, 'runtime_aborted');
      decision = record.status === 'allowed';
    } finally {
      settle(decision);
    }
  }

  private requireStore(): ApprovalStore {
    if (!this.store) throw new Error('approval_store_not_configured');
    return this.store;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Approval observers are isolated. */ }
    }
  }
}

function persistablePreview(request: ApprovalRequest): PersistedApprovalPreview | undefined {
  if (!request.preview) return undefined;
  return {
    kind: request.preview.kind,
    path: request.preview.path,
    additions: request.preview.additions,
    deletions: request.preview.deletions,
    ...(request.preview.truncated !== undefined ? { truncated: request.preview.truncated } : {})
  };
}

function approvalHash(request: ApprovalRequest, preview: PersistedApprovalPreview | undefined): string {
  return createHash('sha256').update(stableJson({
    requestId: request.requestId,
    toolCallId: request.call.id,
    toolName: request.call.name,
    reason: request.reason,
    preview
  })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

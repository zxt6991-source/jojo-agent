import { createHash } from 'node:crypto';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { ApprovalBroker, RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { ApprovalDecision, PendingApprovalSnapshot } from '@desktop-agent/contracts/application';
import type { ApprovalStore, ApprovalOwnership, PersistedApprovalPreview } from './persistence.js';
import { PendingApprovals } from './pending-approvals.js';

type PendingApproval = {
  snapshot: PendingApprovalSnapshot;
};

export type ApprovalEvent =
  | { type: 'approval.required'; approval: PendingApprovalSnapshot }
  | { type: 'approval.resolved'; approval: PendingApprovalSnapshot; decision: ApprovalDecision };

export type ServerApprovalBrokerOptions = {
  store?: ApprovalStore;
  now?: () => Date;
};

/** Application-facing lifecycle shared by Host approval adapters. */
export interface ApplicationApprovalBroker extends ApprovalBroker {
  /** Durable adapters may bind the application's store before accepting requests. */
  bindStore?(store: ApprovalStore): void;
  list(sessionId?: string): PendingApprovalSnapshot[];
  getSessionId(id: string): Promise<string>;
  resolve(id: string, decision: ApprovalDecision, principalId?: string): Promise<void>;
  interruptAll(reason: string): Promise<void>;
  subscribe(listener: (event: ApprovalEvent) => void): () => void;
}

export class ServerApprovalBroker implements ApplicationApprovalBroker {
  private readonly pending = new PendingApprovals<PendingApproval>();
  private readonly requesting = new Set<string>();
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
    if (this.requesting.size > 0) throw new Error('approval_store_bind_after_use');
    this.store = store;
  }

  requestApproval(request: ApprovalRequest, context: RuntimeResolutionContext, signal: AbortSignal): Promise<boolean> {
    if (request.sessionId !== context.sessionId) return Promise.reject(new Error('approval_session_mismatch'));
    return this.requestScoped(request, { runId: context.runId, laneId: context.laneId }, signal);
  }

  requestSessionApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    return this.requestScoped(request, { scope: 'session' }, signal);
  }

  private async requestScoped(request: ApprovalRequest, ownership: ApprovalOwnership, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    const id = request.requestId;
    if (this.requesting.has(id)) throw new Error(`approval_exists: ${id}`);
    this.requesting.add(id);
    try {
      return await this.persistAndWait(request, ownership, signal);
    } finally {
      this.requesting.delete(id);
    }
  }

  private async persistAndWait(request: ApprovalRequest, ownership: ApprovalOwnership, signal: AbortSignal): Promise<boolean> {
    const store = this.requireStore();
    const id = request.requestId;
    if (this.pending.has(id)) throw new Error(`approval_exists: ${id}`);
    const snapshot: PendingApprovalSnapshot = {
      id,
      sessionId: request.sessionId,
      ...(ownership.scope === 'session' ? { scope: 'session' as const } : { laneId: ownership.laneId, runId: ownership.runId }),
      createdAt: this.now().toISOString(),
      request
    };
    const preview = persistablePreview(request);
    const record = await store.createPending({
      id,
      sessionId: request.sessionId,
      ...(ownership.scope === 'session' ? { scope: 'session' as const } : { laneId: ownership.laneId, runId: ownership.runId }),
      toolCallId: request.call.id,
      toolName: request.call.name,
      reason: request.reason,
      requestHash: approvalHash(request, preview),
      ...(preview ? { preview } : {})
    });
    if (record.sessionId !== request.sessionId || record.runId !== ownership.runId || record.laneId !== ownership.laneId || (record.scope ?? 'run') !== (ownership.scope ?? 'run')) {
      throw new Error(`approval_conflict: ${id}`);
    }
    if (record.status !== 'pending') throw new Error(`approval_already_resolved: ${id}`);
    if (signal.aborted) {
      await store.interrupt(id, 'runtime_aborted');
      return false;
    }
    return this.pending.wait(id, { snapshot }, signal, {
      abort: async () => {
        const interrupted = await store.interrupt(id, 'runtime_aborted');
        const allowed = interrupted.status === 'allowed';
        const active = this.pending.get(id);
        if (active) this.finish(id, active, allowed ? 'allow' : 'deny');
        return allowed;
      },
      registered: () => this.emit({ type: 'approval.required', approval: structuredClone(snapshot) })
    });
  }

  get(id: string): PendingApprovalSnapshot | undefined {
    const snapshot = this.pending.get(id)?.snapshot;
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  list(sessionId?: string): PendingApprovalSnapshot[] {
    return [...this.pending.values()]
      .map((item) => item.snapshot)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }

  async getSessionId(id: string): Promise<string> {
    const approval = await this.requireStore().get(id);
    if (!approval) throw new Error(`approval_not_found: ${id}`);
    return approval.sessionId;
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
    this.finish(id, pending, decision);
  }

  async interruptSession(sessionId: string, reason = 'session_cancelled'): Promise<void> {
    await this.interruptPending(reason, sessionId);
  }

  async interruptAll(reason: string): Promise<void> {
    await this.interruptPending(reason);
  }

  private async interruptPending(reason: string, sessionId?: string): Promise<void> {
    for (const [id, pending] of [...this.pending]) {
      if (sessionId && pending.snapshot.sessionId !== sessionId) continue;
      const record = await this.requireStore().interrupt(id, reason);
      this.finish(id, pending, record.status === 'allowed' ? 'allow' : 'deny');
    }
  }

  private finish(id: string, pending: PendingApproval & { settle(allowed: boolean): void }, decision: ApprovalDecision): void {
    if (this.pending.get(id) !== pending) return;
    pending.settle(decision === 'allow');
    this.emit({ type: 'approval.resolved', approval: structuredClone(pending.snapshot), decision });
  }

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private requireStore(): ApprovalStore {
    if (!this.store) throw new Error('approval_store_not_configured');
    return this.store;
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try { listener(structuredClone(event)); } catch { /* Approval observers are isolated. */ }
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

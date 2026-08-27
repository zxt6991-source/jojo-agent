import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { ApprovalBroker, RuntimeResolutionContext } from '@desktop-agent/agent-runtime';
import type { ApprovalDecision, PendingApprovalSnapshot } from '@desktop-agent/server-protocol';

type PendingApproval = {
  snapshot: PendingApprovalSnapshot;
  settle(decision: boolean): void;
};

export type ApprovalEvent =
  | { type: 'approval.required'; approval: PendingApprovalSnapshot }
  | { type: 'approval.resolved'; approval: PendingApprovalSnapshot; decision: ApprovalDecision };

export class ServerApprovalBroker implements ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  requestApproval(
    request: ApprovalRequest,
    context: RuntimeResolutionContext,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
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
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (decision: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        resolve(decision);
      };
      const onAbort = () => settle(false);
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { snapshot, settle });
      this.emit({ type: 'approval.required', approval: snapshot });
    });
  }

  list(sessionId?: string): PendingApprovalSnapshot[] {
    return [...this.pending.values()]
      .map((item) => item.snapshot)
      .filter((item) => !sessionId || item.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  resolve(id: string, decision: ApprovalDecision): PendingApprovalSnapshot {
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`approval_not_found: ${id}`);
    pending.settle(decision === 'allow');
    this.emit({ type: 'approval.resolved', approval: pending.snapshot, decision });
    return pending.snapshot;
  }

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Approval observers are isolated. */ }
    }
  }
}

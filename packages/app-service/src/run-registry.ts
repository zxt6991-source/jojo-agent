import type { RunHandle } from '@desktop-agent/agent-runtime';
import type { ProtocolError, RunSnapshot } from '@desktop-agent/server-protocol';

export class RunRegistry {
  private readonly snapshots = new Map<string, RunSnapshot>();
  private readonly handles = new Map<string, RunHandle>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onChange: (snapshot: RunSnapshot) => void = () => undefined
  ) {}

  register(handle: RunHandle, sessionId: string, laneId: string): RunSnapshot {
    const snapshot: RunSnapshot = {
      id: handle.id,
      sessionId,
      laneId,
      status: 'accepted',
      createdAt: this.now().toISOString()
    };
    this.snapshots.set(handle.id, snapshot);
    this.handles.set(handle.id, handle);
    this.onChange(structuredClone(snapshot));
    queueMicrotask(() => {
      if (this.snapshots.get(handle.id)?.status !== 'accepted') return;
      this.update(handle.id, { status: 'running', startedAt: this.now().toISOString() });
    });
    void handle.result.then((result) => {
      const status = result.status === 'completed'
        ? 'completed' as const
        : result.status === 'cancelled' ? 'cancelled' as const : 'failed' as const;
      const error = result.error ? {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.detail !== undefined ? { details: result.error.detail } : {})
      } satisfies ProtocolError : undefined;
      this.update(handle.id, {
        status,
        completedAt: this.now().toISOString(),
        result,
        ...(error ? { error } : {})
      });
    }).finally(() => this.handles.delete(handle.id));
    return structuredClone(snapshot);
  }

  get(runId: string): RunSnapshot | undefined {
    const snapshot = this.snapshots.get(runId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  list(sessionId: string, activeOnly = false): RunSnapshot[] {
    return [...this.snapshots.values()]
      .filter((item) => item.sessionId === sessionId && (!activeOnly || ['accepted', 'running'].includes(item.status)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }

  async cancel(runId: string, reason?: string): Promise<boolean> {
    const handle = this.handles.get(runId);
    if (!handle) return false;
    await handle.cancel(reason);
    return true;
  }

  markInterrupted(): void {
    for (const snapshot of this.snapshots.values()) {
      if (!['accepted', 'running'].includes(snapshot.status)) continue;
      this.update(snapshot.id, {
        status: 'interrupted',
        completedAt: this.now().toISOString(),
        error: { code: 'runtime_interrupted', message: 'Runtime execution was interrupted.', retryable: true }
      });
    }
    this.handles.clear();
  }

  private update(runId: string, patch: Partial<RunSnapshot>): void {
    const current = this.snapshots.get(runId);
    if (!current) return;
    const updated = { ...current, ...patch };
    this.snapshots.set(runId, updated);
    this.onChange(structuredClone(updated));
  }
}

import type { RunHandle } from '@desktop-agent/agent-runtime';

export class LiveRunRegistry {
  private readonly handles = new Map<string, RunHandle>();

  attach(runId: string, handle: RunHandle): void {
    if (runId !== handle.id) throw new Error(`runtime_run_identity_mismatch: ${runId}`);
    this.handles.set(runId, handle);
  }

  getHandle(runId: string): RunHandle | undefined {
    return this.handles.get(runId);
  }

  list(): RunHandle[] {
    return [...this.handles.values()];
  }

  detach(runId: string): void {
    this.handles.delete(runId);
  }

  clear(): void {
    this.handles.clear();
  }
}

/** @deprecated Use LiveRunRegistry; durable snapshots belong to RunStore. */
export const RunRegistry = LiveRunRegistry;

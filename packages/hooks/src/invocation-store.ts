import type {
  HookFailure,
  HookInvocationRecord,
  HookInvocationStore
} from '@desktop-agent/contracts';

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryHookInvocationStore implements HookInvocationStore {
  private readonly records = new Map<string, HookInvocationRecord>();

  async getInvocation(id: string): Promise<HookInvocationRecord | undefined> {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  async beginInvocation(record: HookInvocationRecord): Promise<'created' | 'exists'> {
    if (this.records.has(record.id)) return 'exists';
    this.records.set(record.id, clone({ ...record, state: 'running', startedAt: Date.now() }));
    return 'created';
  }

  async completeInvocation(id: string, result: unknown): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`hook_invocation_not_found: ${id}`);
    this.records.set(id, clone({ ...record, state: 'completed', result, completedAt: Date.now() }));
  }

  async failInvocation(id: string, error: HookFailure): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`hook_invocation_not_found: ${id}`);
    this.records.set(id, clone({ ...record, state: 'failed', error, completedAt: Date.now() }));
  }

  async listIncomplete(): Promise<HookInvocationRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.state === 'pending' || record.state === 'running')
      .map(clone);
  }
}

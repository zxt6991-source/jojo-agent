/** Shared in-process waiting lifecycle; persistence and authorization remain adapter responsibilities. */
export class PendingApprovals<T> {
  private readonly entries = new Map<string, T & { settle(allowed: boolean): void }>();

  get(id: string): (T & { settle(allowed: boolean): void }) | undefined { return this.entries.get(id); }
  has(id: string): boolean { return this.entries.has(id); }
  get size(): number { return this.entries.size; }
  values(): IterableIterator<T & { settle(allowed: boolean): void }> { return this.entries.values(); }
  [Symbol.iterator](): IterableIterator<[string, T & { settle(allowed: boolean): void }]> { return this.entries.entries(); }

  wait(id: string, value: T, signal: AbortSignal, options: {
    registered?: () => void;
    abort?: () => Promise<boolean>;
  } = {}): Promise<boolean> {
    if (this.entries.has(id)) return Promise.reject(new Error(`approval_exists: ${id}`));
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        this.entries.delete(id);
        return true;
      };
      const settle = (allowed: boolean) => { if (cleanup()) resolve(allowed); };
      const fail = (error: unknown) => { if (cleanup()) reject(error); };
      const onAbort = () => {
        if (options.abort) {
          void Promise.resolve().then(options.abort).then(settle, fail);
        } else settle(false);
      };
      this.entries.set(id, { ...value, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      try { options.registered?.(); } catch (error) { fail(error); }
    });
  }
}

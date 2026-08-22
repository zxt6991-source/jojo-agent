export class ScopeWriteQueue {
  private readonly pending = new Map<string, Promise<void>>();

  async run<T>(scopeId: string, effect: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(scopeId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.pending.set(scopeId, tail);
    await previous.catch(() => undefined);
    try {
      return await effect();
    } finally {
      release();
      if (this.pending.get(scopeId) === tail) this.pending.delete(scopeId);
    }
  }
}

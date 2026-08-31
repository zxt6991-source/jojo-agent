export class ChannelConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();

  depth(key: string): number { return this.depths.get(key) ?? 0; }

  async enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.depths.set(key, this.depth(key) + 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try { return await task(); }
    finally {
      release();
      const remaining = this.depth(key) - 1;
      if (remaining > 0) this.depths.set(key, remaining);
      else this.depths.delete(key);
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }
}

import { abortError } from '../abort.js';

type Waiter = {
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: DOMException) => void;
  onAbort: () => void;
};

export class AgentExecutionScheduler {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer.');
    }
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiters.length; }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        }
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.createRelease());
    }
  }
}

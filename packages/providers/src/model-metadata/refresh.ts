import type { DiscoveredModel } from '@desktop-agent/contracts';

/** Same-provider requests share work; changed credentials cancel the obsolete request. */
export class ModelDiscoveryRefresh<T = DiscoveredModel[]> {
  private readonly pending = new Map<string, { identity: string; controller: AbortController; promise: Promise<T> }>();
  refresh(providerId: string, identity: string, discover: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const current = this.pending.get(providerId);
    if (current?.identity === identity) return current.promise;
    current?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => discover(controller.signal)).finally(() => {
      if (this.pending.get(providerId)?.promise === promise) this.pending.delete(providerId);
    });
    this.pending.set(providerId, { identity, controller, promise });
    return promise;
  }
  cancel(providerId: string): void {
    this.pending.get(providerId)?.controller.abort();
    this.pending.delete(providerId);
  }
}

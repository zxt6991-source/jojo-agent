import { AgentExecutionScheduler } from './scheduler.js';

const MAX_PROVIDER_CONCURRENCY = 16;

export class ProviderSemaphore {
  private readonly limiters = new Map<string, AgentExecutionScheduler>();

  constructor(limits: Readonly<Record<string, number>> = {}) {
    for (const [providerId, maxConcurrent] of Object.entries(limits)) {
      if (!providerId.trim()) {
        throw new Error('Provider id must be non-empty.');
      }
      if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > MAX_PROVIDER_CONCURRENCY) {
        throw new Error(`Provider ${providerId} maxConcurrent must be an integer from 1 to ${MAX_PROVIDER_CONCURRENCY}.`);
      }
      this.limiters.set(providerId, new AgentExecutionScheduler(maxConcurrent));
    }
  }

  acquire(providerId: string, signal: AbortSignal): Promise<() => void> {
    const limiter = this.limiters.get(providerId);
    if (!limiter) return Promise.resolve(() => undefined);
    return limiter.acquire(signal);
  }

  activeCount(providerId: string): number {
    return this.limiters.get(providerId)?.activeCount ?? 0;
  }

  queuedCount(providerId: string): number {
    return this.limiters.get(providerId)?.queuedCount ?? 0;
  }
}

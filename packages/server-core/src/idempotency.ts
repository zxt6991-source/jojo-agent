import { createHash } from 'node:crypto';
import type { DurableIdempotencyStore } from '@desktop-agent/app-service';
import { ProtocolFailure } from './errors.js';

type Entry = {
  hash: string;
  expiresAt: number;
  result: Promise<unknown>;
};

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
    private readonly durable?: DurableIdempotencyStore
  ) {}

  execute<T>(
    principalId: string,
    route: string,
    key: string | undefined,
    request: unknown,
    work: () => Promise<T>,
    options: { durable?: boolean } = {}
  ): Promise<T> {
    if (!key) return work();
    this.sweep();
    const storageKey = `${principalId}\u0000${route}\u0000${key}`;
    const hash = createHash('sha256').update(stableJson(request)).digest('hex');
    const existing = this.entries.get(storageKey);
    if (existing) {
      if (existing.hash !== hash) {
        return Promise.reject(new ProtocolFailure({
          code: 'idempotency_conflict',
          message: 'The idempotency key was already used with a different request.'
        }));
      }
      return existing.result as Promise<T>;
    }
    const result = this.durable && options.durable !== false
      ? this.executeDurable(principalId, route, key, hash, work)
      : work();
    this.entries.set(storageKey, { hash, expiresAt: this.now() + this.ttlMs, result });
    void result.catch(() => this.entries.delete(storageKey));
    return result;
  }

  private async executeDurable<T>(
    principalId: string,
    route: string,
    key: string,
    requestHash: string,
    work: () => Promise<T>
  ): Promise<T> {
    const identity = { principalId, route, key, requestHash };
    let claim;
    try {
      claim = await this.durable!.claim({
        ...identity,
        expiresAt: new Date(this.now() + this.ttlMs).toISOString()
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('idempotency_conflict')) {
        throw new ProtocolFailure({
          code: 'idempotency_conflict',
          message: 'The idempotency key was already used with a different request.'
        });
      }
      throw error;
    }
    if (claim.status === 'completed') return claim.result as T;
    if (claim.status === 'pending') {
      throw new ProtocolFailure({
        code: 'idempotency_in_progress',
        message: 'The original mutation has not reached a proven durable response.',
        retryable: true
      });
    }
    let workCompleted = false;
    try {
      const result = await work();
      workCompleted = true;
      await this.durable!.complete({ ...identity, result: result ?? null });
      return result;
    } catch (error) {
      if (!workCompleted) await this.durable!.abandon(identity);
      throw error;
    }
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

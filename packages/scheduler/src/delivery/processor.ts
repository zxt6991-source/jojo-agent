import type { DeliveryClaimIdentity, ScheduleStore } from '../store.js';
import type { ScheduleDeliveryItem } from '../types.js';
import type { ScheduleDeliveryAdapter, ScheduleDeliveryAttemptResult, ScheduleDeliveryService } from './types.js';

const BACKOFF_MS = [1_000, 5_000, 15_000] as const;
const CLAIM_TTL_MS = 20_000;
type Timer = ReturnType<typeof setTimeout>;

export type ScheduleDeliveryProcessorOptions = {
  now?: () => Date;
  idGenerator?: () => string;
  isLeader?: () => boolean;
  emit?: (item: ScheduleDeliveryItem) => void;
  concurrency?: number;
  pollMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};

function permanentReason(reason: string): boolean {
  return /(?:unauthorized|forbidden|invalid[_ -]?(?:key|secret|credentials|parameter)|no[_ -]permission|unsupported|not[_ -]configured|missing[_ -]key|target_not_found|binding_not_found)/iu.test(reason);
}

/** The only automatic retry owner. Execution completion never waits for a speaker. */
export class DurableScheduleDeliveryProcessor {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly setTimer: NonNullable<ScheduleDeliveryProcessorOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ScheduleDeliveryProcessorOptions['clearTimer']>;
  private readonly active = new Map<string, { abort: AbortController; task: Promise<void> }>();
  private readonly deferred = new Map<string, DeliveryClaimIdentity>();
  private timer: Timer | undefined;
  private pumping: Promise<void> | undefined;
  private repump = false;
  private closed = true;

  constructor(private readonly store: ScheduleStore, private readonly adapter: ScheduleDeliveryAdapter,
    private readonly options: ScheduleDeliveryProcessorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async initialize(): Promise<void> {
    if (!this.closed) return;
    this.closed = false;
    await this.pump();
  }

  poke(): void {
    if (this.closed) return;
    this.disarm();
    if (this.pumping) { this.repump = true; return; }
    queueMicrotask(() => { void this.pump().catch(() => undefined); });
  }

  pump(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumping) { this.repump = true; return this.pumping; }
    this.pumping = this.performPump().finally(() => {
      this.pumping = undefined;
      if (this.repump && !this.closed) { this.repump = false; this.poke(); }
      else this.arm();
    });
    return this.pumping;
  }

  async replayDelivery(itemId: string): Promise<ScheduleDeliveryItem> {
    if (this.closed) throw new Error('scheduler_closed');
    const replay = await this.store.replayDelivery(itemId, this.now().getTime());
    if (!replay) throw new Error(`schedule_delivery_not_replayable: ${itemId}`);
    this.options.emit?.(replay);
    this.poke();
    return replay;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    await this.pumping?.catch(() => undefined);
    for (const attempt of this.active.values()) attempt.abort.abort();
    await Promise.allSettled([...this.active.values()].map((attempt) => attempt.task));
  }

  private async performPump(): Promise<void> {
    this.disarm();
    if (!(this.options.isLeader?.() ?? true)) return;
    const now = this.now().getTime();
    for (const changed of await this.store.recoverDeliveries(now)) this.options.emit?.(changed);
    await this.reconcileDeferred(now);
    const capacity = Math.max(1, Math.min(16, this.options.concurrency ?? 4));
    const items = await this.store.listDeliveries({ states: ['pending', 'preparing', 'ready', 'failed'], dueAt: now, limit: 100 });
    for (const candidate of items) {
      if (this.closed || !(this.options.isLeader?.() ?? true) || this.active.size >= capacity) break;
      if (this.active.has(candidate.id)) continue;
      const identity: DeliveryClaimIdentity = {
        itemId: candidate.id, claimToken: `claim_${this.idGenerator()}`,
        playbackId: `play_${this.idGenerator()}`, generation: candidate.attempts + 1
      };
      const item = await this.store.claimDelivery({ ...identity, now, ttlMs: CLAIM_TTL_MS, expectedVersion: candidate.version });
      if (!item) continue;
      this.options.emit?.(item);
      const abort = new AbortController();
      const task = this.attempt(item, identity, abort.signal).catch(() => undefined).finally(() => {
        this.active.delete(item.id);
        this.poke();
      });
      this.active.set(item.id, { abort, task });
    }
  }

  private async attempt(item: ScheduleDeliveryItem, identity: DeliveryClaimIdentity, signal: AbortSignal): Promise<void> {
    let result: ScheduleDeliveryAttemptResult;
    let abortListener: (() => void) | undefined;
    try {
      result = await Promise.race([
        this.adapter.deliver(item, { identity, signal }),
        new Promise<ScheduleDeliveryAttemptResult>((resolve) => {
          abortListener = () => resolve({ status: 'uncertain', reason: 'delivery_processor_stopped' });
          if (signal.aborted) abortListener();
          else signal.addEventListener('abort', abortListener, { once: true });
        })
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { status: 'failed', reason: 'schedule_delivery_failed', error: message.slice(0, 4_096), retryable: !permanentReason(message) };
    } finally {
      if (abortListener) signal.removeEventListener('abort', abortListener);
    }
    if (result.status === 'deferred') {
      if (this.adapter.inspect) this.deferred.set(item.id, identity);
      return;
    }
    await this.recordResult(item, identity, result);
  }

  private async recordResult(item: ScheduleDeliveryItem, identity: DeliveryClaimIdentity,
    result: Exclude<ScheduleDeliveryAttemptResult, { status: 'deferred' }>): Promise<void> {
    const now = this.now().getTime();
    const retryable = result.status === 'failed' && result.retryable === true && item.attempts < 3
      && !permanentReason(`${result.reason ?? ''} ${result.error ?? ''}`);
    const nextAttemptAt = retryable && result.status === 'failed'
      ? new Date(now + Math.max(BACKOFF_MS[Math.min(item.attempts - 1, 2)] ?? 15_000,
        Number.isFinite(result.retryAfterMs) ? Math.max(0, result.retryAfterMs ?? 0) : 0)).toISOString()
      : undefined;
    const updated = await this.store.ackDelivery({
      ...identity, now, state: result.status,
      ...(result.reason ? { errorCode: result.reason.slice(0, 256) } : {}),
      ...(result.status === 'failed' && result.error ? { error: result.error.slice(0, 4_096) } : {}),
      ...(nextAttemptAt ? { nextAttemptAt } : {})
    });
    if (updated) this.options.emit?.(updated);
  }

  private async reconcileDeferred(now: number): Promise<void> {
    if (!this.adapter.inspect) return;
    for (const [id, identity] of this.deferred) {
      const item = await this.store.getDelivery(id);
      if (!item || item.claimToken !== identity.claimToken || item.state !== 'claimed') {
        this.deferred.delete(id);
        continue;
      }
      const renewed = await this.store.renewDeliveryClaim({ ...identity, now, ttlMs: CLAIM_TTL_MS });
      if (!renewed) { this.deferred.delete(id); continue; }
      let result: ScheduleDeliveryAttemptResult;
      try { result = await this.adapter.inspect(renewed); }
      catch { continue; }
      if (result.status === 'deferred') continue;
      this.deferred.delete(id);
      await this.recordResult(renewed, identity, result);
    }
  }

  private arm(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = this.setTimer(() => { this.timer = undefined; void this.pump().catch(() => undefined); }, this.options.pollMs ?? 1_000);
  }
  private disarm(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

/** Compatibility adapter still sends one immutable destination at a time. */
export class LegacyScheduleDeliveryAdapter implements ScheduleDeliveryAdapter {
  constructor(private readonly store: ScheduleStore, private readonly service: ScheduleDeliveryService) {}

  inspect(item: ScheduleDeliveryItem): Promise<ScheduleDeliveryAttemptResult> { return this.deliver(item); }

  async deliver(item: ScheduleDeliveryItem, _context?: Parameters<ScheduleDeliveryAdapter['deliver']>[1]): Promise<ScheduleDeliveryAttemptResult> {
    if (item.destination === 'voice' || item.destination === 'notification') {
      return { status: 'failed', reason: 'schedule_delivery_unsupported', retryable: false };
    }
    const run = await this.store.getRun(item.scheduleRunId);
    const schedule = run ? await this.store.get(run.scheduleId) : undefined;
    if (!run || !schedule || !run.deliverySnapshot) return { status: 'suppressed', reason: 'schedule_delivery_snapshot_missing' };
    const payload = item.payloadSnapshot;
    const singleDestination = item.destination === 'conversation'
      ? { conversation: { enabled: true, sessionId: item.destinationId } }
      : { channels: [{ enabled: true, bindingId: item.destinationId,
        ...(payload.kind === 'channel' && payload.mode ? { mode: payload.mode } : {}) }] };
    const result = await this.service.deliver({
      schedule: { ...schedule, name: run.deliverySnapshot.name, revision: run.deliverySnapshot.scheduleRevision,
        target: run.targetSnapshot, delivery: singleDestination },
      run, content: payload.content
    });
    if (result.status === 'pending') return { status: 'deferred' };
    if (result.status === 'skipped') return { status: 'suppressed', reason: 'schedule_delivery_skipped' };
    if (result.status === 'failed') return {
      status: 'failed', reason: 'schedule_delivery_failed', ...(result.error ? { error: result.error } : {}),
      retryable: result.retryable ?? !permanentReason(result.error ?? '')
    };
    return { status: 'delivered' };
  }
}

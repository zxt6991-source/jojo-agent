import type { ScheduleCalculator } from './calculator.js';
import type {
  ScheduleTargetDispatcher,
  TargetExecutionSnapshot
} from './dispatch/dispatcher.js';
import { ScheduleEventBus } from './events.js';
import { scheduleDeliveryContent } from './delivery/service.js';
import type { ScheduleDeliveryResult, ScheduleDeliveryService } from './delivery/types.js';
import type { ScheduleStore } from './store.js';
import {
  ACTIVE_SCHEDULE_RUN_STATUSES,
  TERMINAL_SCHEDULE_RUN_STATUSES,
  type Schedule,
  type ScheduleEvent,
  type ScheduleRun,
  type ScheduleRunStatus,
  type ScheduleRunTrigger
} from './types.js';

const MAX_SLEEP_MS = 5 * 60_000;
const LEASE_RENEW_MS = 10_000;
const LEASE_TTL_MS = 30_000;
const DUE_BATCH_SIZE = 100;
const MISFIRE_THRESHOLD_MS = 1_000;

type Timer = ReturnType<typeof setTimeout>;

export type DurableScheduleEngineOptions = {
  now?: () => Date;
  idGenerator?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  deliveryService?: ScheduleDeliveryService;
};

function targetExecutionId(run: ScheduleRun): string {
  return `schedrun:${run.id}`;
}

function statusFor(snapshot: TargetExecutionSnapshot): ScheduleRunStatus {
  return snapshot.state === 'queued' ? 'pending' : snapshot.state;
}

function isTerminal(status: ScheduleRunStatus): boolean {
  return TERMINAL_SCHEDULE_RUN_STATUSES.includes(status);
}

export class DurableScheduleEngine {
  private readonly events = new ScheduleEventBus();
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly setTimer: NonNullable<DurableScheduleEngineOptions['setTimer']>;
  private readonly clearTimer: NonNullable<DurableScheduleEngineOptions['clearTimer']>;
  private readonly deliveryService: ScheduleDeliveryService | undefined;
  private readonly unsubscribeDispatcher: () => void;
  private readonly pendingTargetSnapshots = new Map<string, TargetExecutionSnapshot>();
  private targetEvents: Promise<void> = Promise.resolve();
  private timer: Timer | undefined;
  private wakePromise: Promise<void> | undefined;
  private closed = true;
  private leader = false;

  constructor(
    private readonly store: ScheduleStore,
    private readonly calculator: ScheduleCalculator,
    private readonly dispatcher: ScheduleTargetDispatcher,
    private readonly instanceId: string,
    options: DurableScheduleEngineOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.deliveryService = options.deliveryService;
    this.unsubscribeDispatcher = dispatcher.subscribe((event) => {
      this.targetEvents = this.targetEvents.then(() => this.onTargetEvent(event.snapshot));
      void this.targetEvents.catch(() => undefined);
    });
  }

  async initialize(): Promise<void> {
    if (!this.closed) return;
    this.closed = false;
    this.leader = await this.renewLease();
    if (this.leader) {
      await this.recoverScheduleRuns();
      await this.recoverPendingDeliveries();
    }
    await this.wake();
  }

  poke(): void {
    if (this.closed) return;
    this.disarm();
    queueMicrotask(() => { void this.wake(); });
  }

  subscribe(listener: (event: ScheduleEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  async runNow(schedule: Schedule, options: { respectConcurrency?: boolean } = {}): Promise<ScheduleRun> {
    if (this.closed) throw new Error('scheduler_closed');
    const now = this.now().toISOString();
    const run = await this.store.createManualRun({
      id: `sr_${this.idGenerator()}`,
      scheduleId: schedule.id,
      occurrenceKey: `manual:${this.idGenerator()}`,
      scheduledFor: now,
      trigger: 'manual',
      status: 'pending',
      targetKind: schedule.target.kind,
      createdAt: now,
      targetSnapshot: schedule.target
    });
    this.events.emit({ type: 'schedule.run.changed', run });
    if (options.respectConcurrency !== false && await this.hasBlockingActiveRun(schedule.id, run.id)) {
      if (schedule.concurrency === 'queue') return run;
      if (schedule.concurrency === 'skip') {
        return this.transition(run, { status: 'skipped', finishedAt: now, errorCode: 'schedule_overlap' });
      }
    }
    return this.dispatchRun(schedule, run);
  }

  async cancelRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`schedule_run_not_found: ${runId}`);
    if (isTerminal(run.status)) return;
    if (!run.targetExecutionId) {
      await this.transition(run, { status: 'cancelled', finishedAt: this.now().toISOString() });
      await this.drainPending(run.scheduleId);
      return;
    }
    await this.dispatcher.cancel({ kind: run.targetKind, id: run.targetExecutionId });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    await this.wakePromise?.catch(() => undefined);
    await this.targetEvents.catch(() => undefined);
    await this.store.releaseEngineLease(this.instanceId);
    this.leader = false;
    this.unsubscribeDispatcher();
    this.events.clear();
  }

  private async wake(): Promise<void> {
    if (this.closed) return;
    if (this.wakePromise) return this.wakePromise;
    this.wakePromise = this.performWake().finally(() => { this.wakePromise = undefined; });
    return this.wakePromise;
  }

  private async performWake(): Promise<void> {
    this.disarm();
    this.leader = await this.renewLease();
    if (this.leader) {
      while (!this.closed) {
        const now = this.now();
        const due = await this.store.listDue(now.getTime(), DUE_BATCH_SIZE);
        if (due.length === 0) break;
        for (const schedule of due) {
          if (this.closed) break;
          await this.processDueSchedule(schedule, now);
        }
        if (due.length < DUE_BATCH_SIZE) break;
      }
    }
    if (!this.closed) await this.armNextTimer();
  }

  private async processDueSchedule(schedule: Schedule, now: Date): Promise<void> {
    if (!schedule.nextRunAt) return;
    const due = new Date(schedule.nextRunAt);
    const lateness = now.getTime() - due.getTime();
    let trigger: ScheduleRunTrigger = 'timer';
    let skippedCode: string | undefined;
    if (lateness > MISFIRE_THRESHOLD_MS) {
      trigger = 'misfire';
      if (schedule.misfire.kind === 'skip') skippedCode = 'schedule_misfire_skipped';
      else if (lateness > schedule.misfire.graceMs) skippedCode = 'schedule_misfire_grace_exceeded';
    }

    let status: ScheduleRunStatus = skippedCode ? 'skipped' : 'dispatching';
    let errorCode = skippedCode;
    if (!skippedCode) {
      const active = await this.store.listRuns(schedule.id, { states: [...ACTIVE_SCHEDULE_RUN_STATUSES] });
      if (active.length > 0 && schedule.concurrency === 'skip') {
        status = 'skipped';
        errorCode = 'schedule_overlap';
      } else if (active.length > 0 && schedule.concurrency === 'queue') {
        const alreadyQueued = active.some((run) => run.status === 'pending');
        status = alreadyQueued ? 'skipped' : 'pending';
        if (alreadyQueued) errorCode = 'schedule_queue_coalesced';
      }
    }

    const next = this.calculator.nextAfter(schedule.spec, now);
    const createdAt = now.toISOString();
    const claimed = await this.store.claimOccurrence({
      scheduleId: schedule.id,
      expectedRevision: schedule.revision,
      expectedNextRunAt: schedule.nextRunAt,
      run: {
        id: `sr_${this.idGenerator()}`,
        scheduleId: schedule.id,
        occurrenceKey: `timer:${due.getTime()}`,
        scheduledFor: due.toISOString(),
        trigger,
        status,
        targetKind: schedule.target.kind,
        createdAt,
        ...(isTerminal(status) ? { finishedAt: createdAt } : {}),
        ...(errorCode ? { errorCode } : {}),
        targetSnapshot: schedule.target
      },
      ...(next ? { nextRunAt: next.toISOString() } : {}),
      disableSchedule: schedule.spec.kind === 'once' || !next,
      updateLastRunAt: !skippedCode
    });
    if (!claimed.claimed) return;
    this.events.emit({ type: 'schedule.run.changed', run: claimed.run });
    const updatedSchedule = await this.store.get(schedule.id);
    if (updatedSchedule) this.events.emit({ type: 'schedule.changed', schedule: updatedSchedule });
    if (claimed.run.status === 'dispatching') await this.dispatchClaimed(schedule, claimed.run);
    else if (isTerminal(claimed.run.status)) {
      try { await this.deliverRun(claimed.run); }
      catch { /* Delivery state is independent and can be recovered if it reached pending. */ }
    }
  }

  private async dispatchRun(schedule: Schedule, run: ScheduleRun): Promise<ScheduleRun> {
    const dispatching = run.status === 'dispatching' ? run : await this.transition(run, { status: 'dispatching' });
    return this.dispatchClaimed(schedule, dispatching);
  }

  private async dispatchClaimed(schedule: Schedule, run: ScheduleRun): Promise<ScheduleRun> {
    const executionId = targetExecutionId(run);
    try {
      const snapshot = await this.dispatcher.dispatch({
        schedule,
        run,
        target: run.targetSnapshot,
        executionId
      });
      const updated = await this.applySnapshot(run, snapshot);
      const pending = this.pendingTargetSnapshots.get(snapshot.id);
      if (!pending) return updated;
      this.pendingTargetSnapshots.delete(snapshot.id);
      return this.applySnapshot(updated, pending);
    } catch (error) {
      return this.transition(run, {
        status: 'failed',
        finishedAt: this.now().toISOString(),
        errorCode: 'schedule_dispatch_failed',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async onTargetEvent(snapshot: TargetExecutionSnapshot): Promise<void> {
    const recoverable = await this.store.listRecoverableRuns();
    const run = recoverable.find((item) => item.targetExecutionId === snapshot.id);
    if (!run) {
      if (recoverable.some((item) => !item.targetExecutionId && targetExecutionId(item) === snapshot.id)) {
        this.pendingTargetSnapshots.set(snapshot.id, snapshot);
      }
      return;
    }
    const updated = await this.applySnapshot(run, snapshot);
    if (isTerminal(updated.status)) await this.drainPending(updated.scheduleId);
  }

  private async applySnapshot(run: ScheduleRun, snapshot: TargetExecutionSnapshot): Promise<ScheduleRun> {
    const status = statusFor(snapshot);
    const now = this.now().toISOString();
    return this.transition(run, {
      status,
      targetExecutionId: snapshot.id,
      ...(!run.startedAt && status !== 'pending' ? { startedAt: now } : {}),
      ...(isTerminal(status) ? { finishedAt: now } : {}),
      ...(snapshot.resultPreview ? { resultPreview: snapshot.resultPreview.slice(0, 4_096) } : {}),
      ...(snapshot.errorCode ? { errorCode: snapshot.errorCode } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {})
    });
  }

  private async transition(run: ScheduleRun, transition: Parameters<ScheduleStore['transitionRun']>[1]): Promise<ScheduleRun> {
    const updated = await this.store.transitionRun(run.id, transition, run.version);
    this.events.emit({ type: 'schedule.run.changed', run: updated });
    if (isTerminal(updated.status) && updated.deliveryStatus === undefined) {
      try { return await this.deliverRun(updated); }
      catch { return await this.store.getRun(updated.id) ?? updated; }
    }
    return updated;
  }

  private async deliverRun(run: ScheduleRun): Promise<ScheduleRun> {
    if (!this.deliveryService) return run;
    const schedule = await this.store.get(run.scheduleId);
    const content = schedule ? scheduleDeliveryContent(schedule, run) : undefined;
    if (!schedule?.delivery?.conversation?.enabled || content === undefined) {
      return this.recordDelivery(run, { status: 'skipped' });
    }

    const pending = run.deliveryStatus === 'pending'
      ? run
      : await this.recordDelivery(run, { status: 'pending' });
    let delivered: ScheduleDeliveryResult;
    try { delivered = await this.deliveryService.deliver({ schedule, run: pending, content }); }
    catch (error) {
      delivered = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    return this.recordDelivery(pending, delivered);
  }

  private async recordDelivery(run: ScheduleRun, result: ScheduleDeliveryResult | { status: 'pending' }): Promise<ScheduleRun> {
    const updated = await this.store.transitionRun(run.id, {
      status: run.status,
      deliveryStatus: result.status,
      ...('messageId' in result && result.messageId ? { deliveryMessageId: result.messageId } : {}),
      ...('error' in result && result.error ? { deliveryError: result.error } : {})
    }, run.version);
    this.events.emit({ type: 'schedule.run.changed', run: updated });
    return updated;
  }

  private async hasBlockingActiveRun(scheduleId: string, excludingId?: string): Promise<boolean> {
    const active = await this.store.listRuns(scheduleId, { states: [...ACTIVE_SCHEDULE_RUN_STATUSES] });
    return active.some((run) => run.id !== excludingId);
  }

  private async drainPending(scheduleId: string): Promise<void> {
    const schedule = await this.store.get(scheduleId);
    if (!schedule || schedule.deletedAt) return;
    const active = await this.store.listRuns(scheduleId, { states: ['dispatching', 'running', 'waiting_approval'] });
    if (active.length > 0) return;
    const pending = (await this.store.listRuns(scheduleId, { states: ['pending'] })).at(-1);
    if (pending) await this.dispatchRun(schedule, pending);
  }

  private async recoverScheduleRuns(): Promise<void> {
    const recoverableRuns = await this.store.listRecoverableRuns();
    for (const run of recoverableRuns) {
      if (run.status === 'pending') continue;
      const reference = { kind: run.targetKind, id: run.targetExecutionId ?? targetExecutionId(run) };
      let snapshot: TargetExecutionSnapshot | undefined;
      try { snapshot = await this.dispatcher.inspect(reference); }
      catch { snapshot = undefined; }
      if (snapshot) {
        const updated = await this.applySnapshot(run, snapshot);
        if (isTerminal(updated.status)) await this.drainPending(updated.scheduleId);
        continue;
      }
      if (run.status === 'dispatching' && this.dispatcher.supportsIdempotentDispatch(run.targetKind)) {
        const schedule = await this.store.get(run.scheduleId);
        if (schedule) await this.dispatchClaimed(schedule, run);
        continue;
      }
      await this.transition(run, {
        status: 'interrupted',
        finishedAt: this.now().toISOString(),
        errorCode: 'schedule_dispatch_uncertain',
        error: 'The target execution could not be proven after scheduler recovery.'
      });
      await this.drainPending(run.scheduleId);
    }
    for (const scheduleId of new Set(recoverableRuns.filter((run) => run.status === 'pending').map((run) => run.scheduleId))) {
      await this.drainPending(scheduleId);
    }
  }

  private async recoverPendingDeliveries(): Promise<void> {
    for (const run of await this.store.listPendingDeliveryRuns()) {
      if (isTerminal(run.status)) await this.deliverRun(run);
    }
  }

  private async renewLease(): Promise<boolean> {
    return this.store.acquireEngineLease(this.instanceId, this.now().getTime(), LEASE_TTL_MS);
  }

  private async armNextTimer(): Promise<void> {
    const next = await this.store.nextDueAt();
    const untilNext = next ? Math.max(0, new Date(next).getTime() - this.now().getTime()) : MAX_SLEEP_MS;
    const delay = Math.min(untilNext, MAX_SLEEP_MS, LEASE_RENEW_MS);
    this.timer = this.setTimer(() => { void this.wake(); }, delay);
  }

  private disarm(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

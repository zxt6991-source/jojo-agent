import {
  aggregateScheduleDeliveries, ackScheduleDelivery, claimScheduleDelivery, recoverScheduleDelivery, renewScheduleDelivery,
  replayScheduleDelivery, revokeScheduleVoice, snapshotScheduleRun, validateDeliveryInsert,
  type ClaimOccurrenceInput, type DeliveryAckInput, type DeliveryClaimIdentity, type DeliveryClaimInput,
  type ScheduleDeliveryListOptions, type ScheduleRunTransition, type ScheduleStore
} from './store.js';
import {
  ACTIVE_SCHEDULE_RUN_STATUSES,
  TERMINAL_SCHEDULE_RUN_STATUSES,
  type Schedule,
  type ScheduleDeliveryItem,
  type ScheduleRun,
  type ScheduleRunListOptions
} from './types.js';

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, Schedule>();
  private readonly runs = new Map<string, ScheduleRun>();
  private readonly deliveries = new Map<string, ScheduleDeliveryItem>();
  private lease: { ownerId: string; expiresAt: number } | undefined;

  async create(schedule: Schedule): Promise<Schedule> {
    if (this.schedules.has(schedule.id)) throw new Error(`schedule_conflict: ${schedule.id}`);
    this.schedules.set(schedule.id, clone(schedule));
    return clone(schedule);
  }

  async get(id: string): Promise<Schedule | undefined> {
    const schedule = this.schedules.get(id);
    return schedule ? clone(schedule) : undefined;
  }

  async list(options: { includeDeleted?: boolean } = {}): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter((schedule) => options.includeDeleted || !schedule.deletedAt)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  async update(schedule: Schedule, expectedRevision?: number): Promise<Schedule> {
    const current = this.schedules.get(schedule.id);
    if (!current || current.deletedAt) throw new Error(`schedule_not_found: ${schedule.id}`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`schedule_revision_conflict: ${schedule.id}`);
    }
    const updated = { ...clone(schedule), revision: current.revision + 1 };
    this.schedules.set(schedule.id, updated);
    if (current.delivery?.voice?.enabled && !updated.delivery?.voice?.enabled) this.revokeVoice(schedule.id, Date.parse(updated.updatedAt));
    return clone(updated);
  }

  async softDelete(id: string, now: string): Promise<Schedule> {
    const current = this.schedules.get(id);
    if (!current) throw new Error(`schedule_not_found: ${id}`);
    if (current.deletedAt) return clone(current);
    const deleted: Schedule = { ...current, enabled: false, deletedAt: now, updatedAt: now, revision: current.revision + 1 };
    delete deleted.nextRunAt;
    this.schedules.set(id, deleted);
    this.revokeVoice(id, Date.parse(now));
    return clone(deleted);
  }

  async listDue(now: number, limit: number): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter((schedule) => schedule.enabled && !schedule.deletedAt && schedule.nextRunAt !== undefined
        && new Date(schedule.nextRunAt).getTime() <= now)
      .sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!))
      .slice(0, limit)
      .map(clone);
  }

  async nextDueAt(): Promise<string | undefined> {
    return [...this.schedules.values()]
      .filter((schedule) => schedule.enabled && !schedule.deletedAt && schedule.nextRunAt)
      .map((schedule) => schedule.nextRunAt!)
      .sort()[0];
  }

  async claimOccurrence(input: ClaimOccurrenceInput): Promise<{ claimed: true; run: ScheduleRun } | { claimed: false }> {
    const schedule = this.schedules.get(input.scheduleId);
    if (!schedule || !schedule.enabled || schedule.deletedAt) return { claimed: false };
    if (input.expectedRevision !== undefined && schedule.revision !== input.expectedRevision) return { claimed: false };
    if (input.expectedNextRunAt !== undefined && schedule.nextRunAt !== input.expectedNextRunAt) return { claimed: false };
    if ([...this.runs.values()].some((run) => run.scheduleId === input.scheduleId
      && run.occurrenceKey === input.run.occurrenceKey)) return { claimed: false };
    if (this.runs.has(input.run.id)) return { claimed: false };
    const run = { ...snapshotScheduleRun(input.run, schedule), version: 1 };
    this.insertDeliveries(run.id, run.deliveryItems ?? [], schedule, run.status);
    delete run.deliveryItems;
    this.runs.set(run.id, run);
    const next: Schedule = {
      ...schedule,
      enabled: input.disableSchedule ? false : schedule.enabled,
      ...(input.updateLastRunAt ? { lastRunAt: input.run.scheduledFor } : {}),
      updatedAt: input.run.createdAt,
      revision: schedule.revision + 1
    };
    if (input.nextRunAt) next.nextRunAt = input.nextRunAt;
    else delete next.nextRunAt;
    this.schedules.set(schedule.id, next);
    return { claimed: true, run: this.withDeliveries(run) };
  }

  async createManualRun(input: Omit<ScheduleRun, 'version'>, expectedScheduleRevision?: number): Promise<ScheduleRun> {
    if (this.runs.has(input.id)) throw new Error(`schedule_run_conflict: ${input.id}`);
    const schedule = this.schedules.get(input.scheduleId);
    if (!schedule || schedule.deletedAt) throw new Error(`schedule_not_found: ${input.scheduleId}`);
    if (expectedScheduleRevision !== undefined && schedule.revision !== expectedScheduleRevision) throw new Error(`schedule_revision_conflict: ${input.scheduleId}`);
    if ([...this.runs.values()].some((run) => run.scheduleId === input.scheduleId && run.occurrenceKey === input.occurrenceKey)) throw new Error(`schedule_run_conflict: ${input.id}`);
    const run = { ...snapshotScheduleRun(input, schedule), version: 1 };
    this.insertDeliveries(run.id, run.deliveryItems ?? [], schedule, run.status);
    delete run.deliveryItems;
    this.runs.set(run.id, run);
    return this.withDeliveries(run);
  }

  async getRun(id: string): Promise<ScheduleRun | undefined> {
    const run = this.runs.get(id);
    return run ? this.withDeliveries(run) : undefined;
  }

  async listRuns(scheduleId: string, options: ScheduleRunListOptions = {}): Promise<ScheduleRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId && (!options.states || options.states.includes(run.status)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map((run) => this.withDeliveries(run));
  }

  async listRecoverableRuns(): Promise<ScheduleRun[]> {
    return [...this.runs.values()].filter((run) => ACTIVE_SCHEDULE_RUN_STATUSES.includes(run.status)).map((run) => this.withDeliveries(run));
  }

  async listPendingDeliveryRuns(): Promise<ScheduleRun[]> {
    return [...this.runs.values()].filter((run) => run.deliveryStatus === 'pending').map((run) => this.withDeliveries(run))
      .filter((run) => run.deliveryStatus === 'pending');
  }

  async transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun> {
    return this.transitionRunWithDeliveries(id, transition, [], expectedVersion);
  }

  async transitionRunWithDeliveries(id: string, transition: ScheduleRunTransition, items: ScheduleDeliveryItem[], expectedVersion?: number): Promise<ScheduleRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`schedule_run_not_found: ${id}`);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error(`schedule_run_revision_conflict: ${id}`);
    }
    if (TERMINAL_SCHEDULE_RUN_STATUSES.includes(current.status) && transition.status !== current.status) {
      throw new Error(`schedule_run_transition_conflict: ${id}`);
    }
    const next = { ...current, ...clone(transition), version: current.version + 1 };
    if (items.length && !TERMINAL_SCHEDULE_RUN_STATUSES.includes(next.status)) throw new Error('schedule_delivery_run_not_terminal');
    this.insertDeliveries(id, items);
    this.runs.set(id, next);
    return this.withDeliveries(next);
  }

  async getDelivery(id: string): Promise<ScheduleDeliveryItem | undefined> {
    const item = this.deliveries.get(id);
    return item ? clone(item) : undefined;
  }

  async listDeliveries(options: ScheduleDeliveryListOptions = {}): Promise<ScheduleDeliveryItem[]> {
    return [...this.deliveries.values()].filter((item) => (!options.scheduleRunId || item.scheduleRunId === options.scheduleRunId)
      && (!options.destination || item.destination === options.destination)
      && (!options.states || options.states.includes(item.state))
      && (options.dueAt === undefined || (!item.claimToken && item.attempts < 3
        && ['pending', 'preparing', 'ready', 'failed'].includes(item.state)
        && (item.state !== 'failed' || !!item.nextAttemptAt)
        && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= options.dueAt)
        && (!item.expiresAt || Date.parse(item.expiresAt) > options.dueAt))))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, options.limit ?? 1_000).map(clone);
  }

  async claimDelivery(input: DeliveryClaimInput): Promise<ScheduleDeliveryItem | undefined> {
    const item = this.deliveries.get(input.itemId);
    if (!item) return undefined;
    const recovered = recoverScheduleDelivery(item, input.now);
    if (recovered) this.deliveries.set(item.id, recovered);
    return this.saveDelivery(claimScheduleDelivery(recovered ?? item, input));
  }

  async renewDeliveryClaim(input: DeliveryClaimIdentity & { now: number; ttlMs: number }): Promise<ScheduleDeliveryItem | undefined> {
    const item = this.deliveries.get(input.itemId);
    if (!item) return undefined;
    const recovered = recoverScheduleDelivery(item, input.now);
    if (recovered) { this.deliveries.set(item.id, recovered); return undefined; }
    return this.saveDelivery(renewScheduleDelivery(item, input));
  }

  async ackDelivery(input: DeliveryAckInput): Promise<ScheduleDeliveryItem | undefined> {
    const item = this.deliveries.get(input.itemId);
    if (!item) return undefined;
    const recovered = recoverScheduleDelivery(item, input.now);
    if (recovered) { this.deliveries.set(item.id, recovered); return undefined; }
    return this.saveDelivery(ackScheduleDelivery(item, input));
  }

  async recoverDeliveries(now: number): Promise<ScheduleDeliveryItem[]> {
    const recovered: ScheduleDeliveryItem[] = [];
    for (const item of this.deliveries.values()) {
      const next = recoverScheduleDelivery(item, now);
      if (next) { this.deliveries.set(item.id, next); recovered.push(clone(next)); }
    }
    return recovered;
  }

  async replayDelivery(id: string, now: number): Promise<ScheduleDeliveryItem | undefined> {
    const item = this.deliveries.get(id);
    const schedule = item && this.schedules.get(this.runs.get(item.scheduleRunId)?.scheduleId ?? '');
    return item && schedule && !schedule.deletedAt && schedule.delivery?.voice?.enabled
      ? this.saveDelivery(replayScheduleDelivery(item, now)) : undefined;
  }

  private saveDelivery(item: ScheduleDeliveryItem | undefined): ScheduleDeliveryItem | undefined {
    if (item) this.deliveries.set(item.id, clone(item));
    return item ? clone(item) : undefined;
  }

  private withDeliveries(run: ScheduleRun): ScheduleRun {
    const items = [...this.deliveries.values()].filter((item) => item.scheduleRunId === run.id).map(clone);
    return aggregateScheduleDeliveries(run, items);
  }

  private insertDeliveries(runId: string, items: ScheduleDeliveryItem[], initialSchedule?: Schedule, initialStatus?: ScheduleRun['status']): void {
    if (items.length + [...this.deliveries.values()].filter((item) => item.scheduleRunId === runId).length > 24) throw new Error('schedule_delivery_limit');
    if (items.length && initialStatus && !TERMINAL_SCHEDULE_RUN_STATUSES.includes(initialStatus)) throw new Error('schedule_delivery_run_not_terminal');
    const parsed = items.map((item) => validateDeliveryInsert(item, runId));
    const unique = new Set<string>();
    const ids = new Set<string>();
    const dedupeKeys = new Set<string>();
    for (const item of parsed) {
      const key = JSON.stringify([item.scheduleRunId, item.destination, item.destinationId]);
      if (unique.has(key) || ids.has(item.id) || dedupeKeys.has(item.dedupeKey)) throw new Error('schedule_delivery_conflict');
      unique.add(key); ids.add(item.id); dedupeKeys.add(item.dedupeKey);
      if (this.deliveries.has(item.id) || [...this.deliveries.values()].some((entry) => entry.dedupeKey === item.dedupeKey
        || (entry.scheduleRunId === item.scheduleRunId && entry.destination === item.destination && entry.destinationId === item.destinationId))) {
        throw new Error('schedule_delivery_conflict');
      }
    }
    for (const item of parsed) {
      const scheduleId = this.runs.get(runId)?.scheduleId;
      const schedule = initialSchedule ?? (scheduleId && this.schedules.get(scheduleId));
      const revoked = schedule && (schedule.deletedAt || !schedule.delivery?.voice?.enabled)
        ? revokeScheduleVoice(item, Date.parse(item.updatedAt)) : undefined;
      this.deliveries.set(item.id, revoked ?? item);
    }
  }

  private revokeVoice(scheduleId: string, now: number): void {
    for (const item of this.deliveries.values()) {
      if (this.runs.get(item.scheduleRunId)?.scheduleId !== scheduleId) continue;
      const next = revokeScheduleVoice(item, now);
      if (next) this.deliveries.set(item.id, next);
    }
  }

  async acquireEngineLease(ownerId: string, now: number, ttlMs: number): Promise<boolean> {
    if (this.lease && this.lease.ownerId !== ownerId && this.lease.expiresAt > now) return false;
    this.lease = { ownerId, expiresAt: now + ttlMs };
    return true;
  }

  async releaseEngineLease(ownerId: string): Promise<void> {
    if (this.lease?.ownerId === ownerId) this.lease = undefined;
  }
}

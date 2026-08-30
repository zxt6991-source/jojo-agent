import type { ClaimOccurrenceInput, ScheduleRunTransition, ScheduleStore } from './store.js';
import {
  ACTIVE_SCHEDULE_RUN_STATUSES,
  TERMINAL_SCHEDULE_RUN_STATUSES,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunListOptions
} from './types.js';

function clone<T>(value: T): T { return structuredClone(value); }

export class MemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, Schedule>();
  private readonly runs = new Map<string, ScheduleRun>();
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
    return clone(updated);
  }

  async softDelete(id: string, now: string): Promise<Schedule> {
    const current = this.schedules.get(id);
    if (!current) throw new Error(`schedule_not_found: ${id}`);
    if (current.deletedAt) return clone(current);
    const deleted: Schedule = { ...current, enabled: false, deletedAt: now, updatedAt: now, revision: current.revision + 1 };
    delete deleted.nextRunAt;
    this.schedules.set(id, deleted);
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
    const run = { ...clone(input.run), version: 1 };
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
    return { claimed: true, run: clone(run) };
  }

  async createManualRun(input: Omit<ScheduleRun, 'version'>): Promise<ScheduleRun> {
    if (this.runs.has(input.id)) throw new Error(`schedule_run_conflict: ${input.id}`);
    const run = { ...clone(input), version: 1 };
    this.runs.set(run.id, run);
    return clone(run);
  }

  async getRun(id: string): Promise<ScheduleRun | undefined> {
    const run = this.runs.get(id);
    return run ? clone(run) : undefined;
  }

  async listRuns(scheduleId: string, options: ScheduleRunListOptions = {}): Promise<ScheduleRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId && (!options.states || options.states.includes(run.status)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit ?? Number.POSITIVE_INFINITY)
      .map(clone);
  }

  async listRecoverableRuns(): Promise<ScheduleRun[]> {
    return [...this.runs.values()].filter((run) => ACTIVE_SCHEDULE_RUN_STATUSES.includes(run.status)).map(clone);
  }

  async listPendingDeliveryRuns(): Promise<ScheduleRun[]> {
    return [...this.runs.values()].filter((run) => run.deliveryStatus === 'pending').map(clone);
  }

  async transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`schedule_run_not_found: ${id}`);
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throw new Error(`schedule_run_revision_conflict: ${id}`);
    }
    if (TERMINAL_SCHEDULE_RUN_STATUSES.includes(current.status) && transition.status !== current.status) {
      throw new Error(`schedule_run_transition_conflict: ${id}`);
    }
    const next = { ...current, ...clone(transition), version: current.version + 1 };
    this.runs.set(id, next);
    return clone(next);
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

import type { Schedule, ScheduleRun, ScheduleRunListOptions, ScheduleRunStatus } from './types.js';

export type ClaimOccurrenceInput = {
  scheduleId: string;
  expectedRevision?: number;
  expectedNextRunAt?: string;
  run: Omit<ScheduleRun, 'version'>;
  nextRunAt?: string;
  disableSchedule?: boolean;
  updateLastRunAt?: boolean;
};

export type ScheduleRunTransition = {
  status: ScheduleRunStatus;
  targetExecutionId?: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  error?: string;
  resultPreview?: string;
  deliveryStatus?: NonNullable<ScheduleRun['deliveryStatus']>;
  deliveryMessageId?: string;
  deliveryError?: string;
  claimedBy?: string;
  claimExpiresAt?: string;
};

export interface ScheduleStore {
  create(schedule: Schedule): Promise<Schedule>;
  get(id: string): Promise<Schedule | undefined>;
  list(options?: { includeDeleted?: boolean }): Promise<Schedule[]>;
  update(schedule: Schedule, expectedRevision?: number): Promise<Schedule>;
  softDelete(id: string, now: string): Promise<Schedule>;
  listDue(now: number, limit: number): Promise<Schedule[]>;
  nextDueAt(): Promise<string | undefined>;
  claimOccurrence(input: ClaimOccurrenceInput): Promise<{ claimed: true; run: ScheduleRun } | { claimed: false }>;
  createManualRun(run: Omit<ScheduleRun, 'version'>): Promise<ScheduleRun>;
  getRun(id: string): Promise<ScheduleRun | undefined>;
  listRuns(scheduleId: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]>;
  listRecoverableRuns(): Promise<ScheduleRun[]>;
  listPendingDeliveryRuns(): Promise<ScheduleRun[]>;
  transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun>;
  acquireEngineLease(ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  releaseEngineLease(ownerId: string): Promise<void>;
  close?(): Promise<void>;
}

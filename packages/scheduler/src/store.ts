import type { Schedule, ScheduleDeliveryItem, ScheduleDeliveryState, ScheduleRun, ScheduleRunListOptions, ScheduleRunStatus } from './types.js';
import { ScheduleDeliveryItemSchema } from '@desktop-agent/contracts';

export type ScheduleDeliveryListOptions = {
  scheduleRunId?: string; destination?: ScheduleDeliveryItem['destination'];
  states?: ScheduleDeliveryState[]; limit?: number;
  /** Select only unclaimed, unexpired attempts that are eligible to run now. */
  dueAt?: number;
};
export type DeliveryClaimIdentity = { itemId: string; claimToken: string; playbackId: string; generation: number };
export type DeliveryClaimInput = DeliveryClaimIdentity & { now: number; ttlMs: number; expectedVersion?: number };
export type DeliveryAckInput = DeliveryClaimIdentity & {
  now: number; state: ScheduleDeliveryState; expectedVersion?: number;
  errorCode?: string; error?: string; nextAttemptAt?: string;
};

function validClock(now: number): void {
  if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('schedule_delivery_clock_invalid');
}
function validClaim(input: DeliveryClaimIdentity): void {
  if (![input.itemId, input.claimToken, input.playbackId].every((id) => id.length > 0 && id.length <= 256)
    || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('schedule_delivery_claim_invalid');
}
function clearClaim(item: ScheduleDeliveryItem): void {
  delete item.claimToken; delete item.claimExpiresAt; delete item.playbackId; delete item.generation;
}
function changed(item: ScheduleDeliveryItem, now: number): ScheduleDeliveryItem {
  return { ...structuredClone(item), version: item.version + 1, updatedAt: new Date(now).toISOString() };
}
function matchesClaim(item: ScheduleDeliveryItem, input: DeliveryClaimIdentity): boolean {
  return item.id === input.itemId && item.claimToken === input.claimToken
    && item.playbackId === input.playbackId && item.generation === input.generation;
}
function claimAlive(item: ScheduleDeliveryItem, now: number): boolean {
  return !!item.claimExpiresAt && Date.parse(item.claimExpiresAt) > now
    && (!item.expiresAt || Date.parse(item.expiresAt) > now);
}

export function snapshotScheduleRun(run: Omit<ScheduleRun, 'version'>, schedule: Schedule): Omit<ScheduleRun, 'version'> {
  return {
    ...structuredClone(run),
    deliverySnapshot: {
      name: schedule.name, scheduleRevision: schedule.revision,
      ...(schedule.delivery ? { delivery: structuredClone(schedule.delivery) } : {})
    }
  };
}

/** Destination records are authoritative; the legacy fields are a read-time projection. */
export function aggregateScheduleDeliveries(run: ScheduleRun, items: ScheduleDeliveryItem[]): ScheduleRun {
  if (!items.length) return { ...structuredClone(run) };
  const next: ScheduleRun = { ...structuredClone(run), deliveryItems: structuredClone(items) };
  const successful = (item: ScheduleDeliveryItem) => item.state === 'delivered' || item.state === 'played';
  const skipped = (item: ScheduleDeliveryItem) => ['suppressed', 'expired', 'cancelled'].includes(item.state);
  const pending = (item: ScheduleDeliveryItem) => ['pending', 'preparing', 'ready', 'claimed', 'playing'].includes(item.state)
    || (item.state === 'failed' && !!item.nextAttemptAt);
  next.deliveryStatus = items.every(successful) ? 'delivered' : items.every(skipped) ? 'skipped'
    : items.some(pending) ? 'pending' : 'failed';
  delete next.deliveryMessageId; delete next.deliveryError;
  const message = items.find((item) => item.destination === 'conversation' && successful(item)) ?? items.find(successful);
  if (message) next.deliveryMessageId = message.payloadSnapshot.messageId;
  const failure = items.find((item) => ['failed', 'uncertain', 'interrupted'].includes(item.state));
  const failureError = failure?.error ?? failure?.errorCode;
  if (failureError) next.deliveryError = failureError;
  return next;
}

export function validateDeliveryInsert(item: ScheduleDeliveryItem, runId: string): ScheduleDeliveryItem {
  const parsed = ScheduleDeliveryItemSchema.parse(item);
  if (parsed.scheduleRunId !== runId || parsed.version !== 1 || parsed.attempts !== 0
    || parsed.claimToken || parsed.claimExpiresAt || parsed.playbackId || parsed.generation !== undefined
    || !['pending', 'suppressed', 'expired', 'cancelled'].includes(parsed.state)) {
    throw new Error('schedule_delivery_initial_state_invalid');
  }
  return parsed;
}

export function recoverScheduleDelivery(item: ScheduleDeliveryItem, now: number): ScheduleDeliveryItem | undefined {
  validClock(now);
  if (['played', 'delivered', 'suppressed', 'expired', 'uncertain', 'interrupted', 'cancelled'].includes(item.state)) return undefined;
  const expired = !!item.expiresAt && Date.parse(item.expiresAt) <= now;
  const lostClaim = !!item.claimToken && (!item.claimExpiresAt || Date.parse(item.claimExpiresAt) <= now);
  if (!expired && !lostClaim) return undefined;
  const next = changed(item, now);
  // A speaker may have started after durable permission. Never replay a lost voice lease.
  if (item.destination === 'voice' && item.claimToken) {
    next.state = 'uncertain'; next.errorCode = 'delivery_claim_expired'; delete next.nextAttemptAt;
  } else if (expired) {
    next.state = 'expired'; next.errorCode = 'delivery_expired'; delete next.nextAttemptAt;
  } else {
    next.state = 'failed'; next.errorCode = 'delivery_claim_expired';
    if (item.attempts < 3) next.nextAttemptAt = new Date(now).toISOString();
    else delete next.nextAttemptAt;
  }
  clearClaim(next);
  return next;
}

export function claimScheduleDelivery(item: ScheduleDeliveryItem, input: DeliveryClaimInput): ScheduleDeliveryItem | undefined {
  validClock(input.now); validClaim(input);
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) throw new Error('schedule_delivery_lease_invalid');
  if ((input.expectedVersion !== undefined && item.version !== input.expectedVersion) || item.claimToken
    || !['pending', 'preparing', 'ready', 'failed'].includes(item.state)
    || (item.state === 'failed' && !item.nextAttemptAt) || item.attempts >= 3
    || (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > input.now)
    || (item.expiresAt && Date.parse(item.expiresAt) <= input.now)) return undefined;
  const next = changed(item, input.now);
  next.state = 'claimed'; next.attempts += 1;
  next.claimToken = input.claimToken; next.playbackId = input.playbackId; next.generation = input.generation;
  next.claimExpiresAt = new Date(Math.min(input.now + input.ttlMs, item.expiresAt ? Date.parse(item.expiresAt) : Infinity)).toISOString();
  delete next.nextAttemptAt;
  return next;
}

export function renewScheduleDelivery(item: ScheduleDeliveryItem, input: DeliveryClaimIdentity & { now: number; ttlMs: number }): ScheduleDeliveryItem | undefined {
  validClock(input.now); validClaim(input);
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1_000 || input.ttlMs > 60_000) throw new Error('schedule_delivery_lease_invalid');
  if (!matchesClaim(item, input) || !claimAlive(item, input.now)
    || !['claimed', 'preparing', 'ready', 'playing'].includes(item.state)) return undefined;
  return {
    ...changed(item, input.now),
    claimExpiresAt: new Date(Math.min(input.now + input.ttlMs, item.expiresAt ? Date.parse(item.expiresAt) : Infinity)).toISOString()
  };
}

export function ackScheduleDelivery(item: ScheduleDeliveryItem, input: DeliveryAckInput): ScheduleDeliveryItem | undefined {
  validClock(input.now); validClaim(input);
  if (!matchesClaim(item, input) || !claimAlive(item, input.now)
    || (input.expectedVersion !== undefined && item.version !== input.expectedVersion)
    || !['claimed', 'preparing', 'ready', 'playing'].includes(item.state)) return undefined;
  if (!['preparing', 'ready', 'playing', 'played', 'delivered', 'failed', 'suppressed', 'interrupted', 'uncertain', 'cancelled'].includes(input.state)) return undefined;
  if ((input.state === 'played' && (item.destination !== 'voice' || item.state !== 'playing'))
    || (input.state === 'delivered' && item.destination === 'voice')
    || (['preparing', 'ready', 'playing'].includes(input.state) && item.destination !== 'voice')
    || (['preparing', 'ready'].includes(input.state) && item.state === 'playing')
    || (input.state === 'preparing' && item.state === 'ready')) return undefined;
  if (item.state === input.state) return structuredClone(item);
  const next = changed(item, input.now);
  next.state = input.state;
  if (input.errorCode) next.errorCode = input.errorCode.slice(0, 256);
  if (input.error) next.error = input.error.slice(0, 4_096);
  if (input.state === 'failed' && item.destination === 'voice' && item.state === 'playing') next.state = 'uncertain';
  if (next.state === 'failed' && input.nextAttemptAt && item.attempts < 3) {
    const retryAt = Date.parse(input.nextAttemptAt);
    if (!Number.isSafeInteger(retryAt) || retryAt < input.now) throw new Error('schedule_delivery_retry_invalid');
    if (!item.expiresAt || retryAt < Date.parse(item.expiresAt)) next.nextAttemptAt = new Date(retryAt).toISOString();
  } else delete next.nextAttemptAt;
  if (!['preparing', 'ready', 'playing'].includes(next.state)) clearClaim(next);
  return next;
}

export function replayScheduleDelivery(item: ScheduleDeliveryItem, now: number): ScheduleDeliveryItem | undefined {
  validClock(now);
  if (item.destination !== 'voice' || !['played', 'failed', 'suppressed', 'uncertain', 'interrupted'].includes(item.state)
    || (item.expiresAt && Date.parse(item.expiresAt) <= now)) return undefined;
  const next = changed(item, now);
  next.state = 'pending'; next.attempts = 0; clearClaim(next);
  delete next.nextAttemptAt; delete next.error; delete next.errorCode;
  return next;
}

export function revokeScheduleVoice(item: ScheduleDeliveryItem, now: number): ScheduleDeliveryItem | undefined {
  if (item.destination !== 'voice' || !['pending', 'preparing', 'ready', 'claimed', 'failed'].includes(item.state)) return undefined;
  const next = changed(item, now);
  next.state = 'suppressed'; next.errorCode = 'schedule_voice_revoked';
  clearClaim(next); delete next.nextAttemptAt;
  return next;
}

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
  createManualRun(run: Omit<ScheduleRun, 'version'>, expectedScheduleRevision?: number): Promise<ScheduleRun>;
  getRun(id: string): Promise<ScheduleRun | undefined>;
  listRuns(scheduleId: string, options?: ScheduleRunListOptions): Promise<ScheduleRun[]>;
  listRecoverableRuns(): Promise<ScheduleRun[]>;
  listPendingDeliveryRuns(): Promise<ScheduleRun[]>;
  transitionRun(id: string, transition: ScheduleRunTransition, expectedVersion?: number): Promise<ScheduleRun>;
  transitionRunWithDeliveries(id: string, transition: ScheduleRunTransition, items: ScheduleDeliveryItem[], expectedVersion?: number): Promise<ScheduleRun>;
  getDelivery(id: string): Promise<ScheduleDeliveryItem | undefined>;
  listDeliveries(options?: ScheduleDeliveryListOptions): Promise<ScheduleDeliveryItem[]>;
  claimDelivery(input: DeliveryClaimInput): Promise<ScheduleDeliveryItem | undefined>;
  renewDeliveryClaim(input: DeliveryClaimIdentity & { now: number; ttlMs: number }): Promise<ScheduleDeliveryItem | undefined>;
  ackDelivery(input: DeliveryAckInput): Promise<ScheduleDeliveryItem | undefined>;
  recoverDeliveries(now: number): Promise<ScheduleDeliveryItem[]>;
  replayDelivery(id: string, now: number): Promise<ScheduleDeliveryItem | undefined>;
  acquireEngineLease(ownerId: string, now: number, ttlMs: number): Promise<boolean>;
  releaseEngineLease(ownerId: string): Promise<void>;
  close?(): Promise<void>;
}

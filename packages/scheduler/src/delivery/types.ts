import type { Message } from '@desktop-agent/contracts';
import type { Schedule, ScheduleDeliveryItem, ScheduleRun } from '../types.js';
import type { DeliveryClaimIdentity } from '../store.js';

export type ScheduleDeliveryResult = {
  status: 'delivered' | 'failed' | 'skipped' | 'pending';
  destination?: {
    kind: 'conversation' | 'notification' | 'channel';
    id?: string;
  };
  messageId?: string;
  error?: string;
  retryable?: boolean;
};

export interface ScheduleDeliveryService {
  deliver(input: {
    schedule: Schedule;
    run: ScheduleRun;
    content: string;
  }): Promise<ScheduleDeliveryResult>;
}

export interface ScheduleConversationWriter {
  appendMessage(sessionId: string, message: Message): Promise<void>;
}

export type ScheduleDeliveryAttemptResult =
  | { status: 'delivered' | 'played' | 'suppressed' | 'interrupted' | 'uncertain'; reason?: string }
  | { status: 'failed'; reason?: string; error?: string; retryable?: boolean; retryAfterMs?: number }
  | { status: 'deferred' };

export interface ScheduleDeliveryAdapter {
  deliver(item: ScheduleDeliveryItem, context: {
    identity: DeliveryClaimIdentity;
    signal: AbortSignal;
  }): Promise<ScheduleDeliveryAttemptResult>;
  /** Reconcile an accepted external outbox without submitting a new attempt. */
  inspect?(item: ScheduleDeliveryItem): Promise<ScheduleDeliveryAttemptResult>;
}

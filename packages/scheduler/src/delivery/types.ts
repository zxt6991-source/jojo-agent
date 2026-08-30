import type { Message } from '@desktop-agent/contracts';
import type { Schedule, ScheduleRun } from '../types.js';

export type ScheduleDeliveryResult = {
  status: 'delivered' | 'failed' | 'skipped';
  channel?: 'conversation' | 'notification';
  messageId?: string;
  error?: string;
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

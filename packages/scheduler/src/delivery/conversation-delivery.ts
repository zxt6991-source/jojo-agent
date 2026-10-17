import type { ScheduleDeliveryService, ScheduleConversationWriter } from './types.js';

export class ConversationScheduleDeliveryService implements ScheduleDeliveryService {
  constructor(private readonly conversations: ScheduleConversationWriter) {}

  async deliver(input: Parameters<ScheduleDeliveryService['deliver']>[0]) {
    const conversation = input.schedule.delivery?.conversation;
    if (!conversation?.enabled) return { status: 'skipped' as const };

    const payload = input.run.deliveryItems?.find((item) => item.destination === 'conversation'
      && item.destinationId === conversation.sessionId)?.payloadSnapshot;
    const messageId = payload?.messageId ?? `scheduler_${input.run.id}`;
    try {
      await this.conversations.appendMessage(conversation.sessionId, {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text: input.content }],
        createdAt: payload?.createdAt ?? input.run.finishedAt ?? input.run.scheduledFor,
        metadata: {
          source: 'scheduler',
          automation: {
            scheduleId: input.schedule.id,
            scheduleRunId: input.run.id,
            name: input.schedule.name,
            triggeredAt: input.run.startedAt ?? input.run.scheduledFor
          }
        }
      });
      return {
        status: 'delivered' as const,
        destination: { kind: 'conversation' as const, id: conversation.sessionId },
        messageId
      };
    } catch (error) {
      return {
        status: 'failed' as const,
        destination: { kind: 'conversation' as const, id: conversation.sessionId },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

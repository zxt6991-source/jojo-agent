import type { ScheduleDeliveryResult, ScheduleDeliveryService } from '@desktop-agent/scheduler';
import type { ChannelService } from '../service.js';

export class ChannelScheduleDeliveryService implements ScheduleDeliveryService {
  constructor(private readonly channels: ChannelService) {}

  async deliver(input: Parameters<ScheduleDeliveryService['deliver']>[0]): Promise<ScheduleDeliveryResult> {
    const targets = input.schedule.delivery?.channels?.filter((target) => target.enabled) ?? [];
    if (targets.length === 0) return { status: 'skipped' };
    const receipts = [];
    try {
      for (const target of targets) {
        const content = target.mode === 'preview' && input.content.length > 500
          ? `${input.content.slice(0, 497)}...`
          : input.content;
        const receipt = await this.channels.deliver({
          bindingId: target.bindingId,
          content: [{ type: 'markdown', text: content }],
          correlation: { scheduleId: input.schedule.id, scheduleRunId: input.run.id },
          mode: 'system', idempotencyKey: `schedule:${input.run.id}:${target.bindingId}`
        });
        // Enqueuing a Channel outbox request is not proof that the provider sent it.
        if ((receipt.status === 'pending' || receipt.status === 'sending') && this.channels.getDelivery) {
          const persisted = await this.channels.getDelivery(receipt.deliveryId);
          receipts.push({ deliveryId: receipt.deliveryId, status: persisted.status,
            ...(persisted.nativeMessageId ? { nativeMessageId: persisted.nativeMessageId } : {}) });
        } else receipts.push(receipt);
      }
      const failed = receipts.find((receipt) => receipt.status === 'failed' || receipt.status === 'unknown' || receipt.status === 'blocked');
      if (failed) return {
        status: 'failed', destination: { kind: 'channel', id: failed.deliveryId },
        error: `channel_delivery_${failed.status}`, retryable: false
      };
      if (receipts.some((receipt) => receipt.status !== 'delivered')) return {
        status: 'pending', destination: { kind: 'channel', id: targets.map((target) => target.bindingId).join(',') },
        messageId: receipts.map((receipt) => receipt.deliveryId).join(',')
      };
      return {
        status: 'delivered', destination: { kind: 'channel', id: targets.map((target) => target.bindingId).join(',') },
        messageId: receipts.map((receipt) => receipt.nativeMessageId ?? receipt.deliveryId).join(',')
      };
    } catch (error) {
      return {
        status: 'failed', destination: { kind: 'channel' },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

export class CompositeScheduleDeliveryService implements ScheduleDeliveryService {
  constructor(private readonly services: ScheduleDeliveryService[]) {}

  async deliver(input: Parameters<ScheduleDeliveryService['deliver']>[0]): Promise<ScheduleDeliveryResult> {
    const results = await Promise.all(this.services.map(async (service) => {
      try { return await service.deliver(input); }
      catch (error) { return { status: 'failed' as const, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const failed = results.filter((item) => item.status === 'failed');
    if (failed.length > 0) return { status: 'failed', error: failed.map((item) => item.error).filter(Boolean).join('; ') };
    const delivered = results.filter((item) => item.status === 'delivered');
    if (results.some((item) => item.status === 'pending')) return { status: 'pending' };
    if (delivered.length === 0) return { status: 'skipped' };
    const messageId = delivered.map((item) => item.messageId).filter(Boolean).join(',');
    return { status: 'delivered', ...(messageId ? { messageId } : {}) };
  }
}

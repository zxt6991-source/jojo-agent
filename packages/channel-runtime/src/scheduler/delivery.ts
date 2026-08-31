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
        receipts.push(await this.channels.deliver({
          bindingId: target.bindingId,
          content: [{ type: 'markdown', text: content }],
          correlation: { scheduleId: input.schedule.id, scheduleRunId: input.run.id },
          mode: 'system', idempotencyKey: `schedule:${input.run.id}:${target.bindingId}`
        }));
      }
      const failed = receipts.find((receipt) => receipt.status === 'failed' || receipt.status === 'unknown');
      if (failed) return {
        status: 'failed', destination: { kind: 'channel', id: failed.deliveryId },
        error: `channel_delivery_${failed.status}`
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
    if (delivered.length === 0) return { status: 'skipped' };
    const messageId = delivered.map((item) => item.messageId).filter(Boolean).join(',');
    return { status: 'delivered', ...(messageId ? { messageId } : {}) };
  }
}

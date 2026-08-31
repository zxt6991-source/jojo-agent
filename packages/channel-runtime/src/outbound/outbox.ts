import {
  channelDeliveryFailureKind,
  type ChannelAdapter,
  type ChannelBinding,
  type ChannelDeliveryInput,
  type ChannelDeliveryReceipt,
  type ChannelOutboxItem,
  type ChannelRuntimeEvent
} from '@desktop-agent/channel-core';
import type { ChannelStore } from '../store/store.js';
import { formatChannelContent } from './formatter.js';

export type ChannelAdapterResolver = (instanceId: string) => ChannelAdapter | undefined;

export class ChannelOutboxService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly store: ChannelStore,
    private readonly adapter: ChannelAdapterResolver,
    private readonly emit: (event: ChannelRuntimeEvent) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly idGenerator: () => string = () => crypto.randomUUID()
  ) {}

  async start(): Promise<void> {
    await this.store.recoverOutbox();
    await this.flush();
    this.timer = setInterval(() => void this.flush(), 1_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flushing;
  }

  async deliver(input: ChannelDeliveryInput, binding?: ChannelBinding): Promise<ChannelDeliveryReceipt> {
    const target = binding ? {
      instanceId: binding.instanceId,
      conversationId: binding.conversation.id,
      ...(binding.conversation.threadId ? { threadId: binding.conversation.threadId } : {})
    } : input.target;
    if (!target) throw new Error('channel_delivery_target_required');
    const adapter = this.adapter(target.instanceId);
    if (!adapter) throw new Error(`channel_instance_not_running: ${target.instanceId}`);
    const formatted = formatChannelContent(input.content, adapter.capabilities);
    const baseKey = input.idempotencyKey ?? this.idGenerator();
    let first: ChannelOutboxItem | undefined;
    for (const [index, content] of formatted.entries()) {
      const id = this.idGenerator();
      const request = {
        id,
        target,
        content,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.correlation ? { correlation: input.correlation } : {}),
        mode: input.mode
      };
      const item = await this.store.enqueueOutbox({
        id, instanceId: target.instanceId, ...(binding ? { bindingId: binding.id } : {}),
        conversationId: target.conversationId, ...(target.threadId ? { threadId: target.threadId } : {}),
        request, idempotencyKey: `${baseKey}:${index}`, status: 'pending', attemptCount: 0,
        createdAt: this.now().toISOString()
      });
      first ??= item;
    }
    if (!first) throw new Error('channel_delivery_empty_content');
    await this.flush();
    const current = await this.store.getOutbox(first.id) ?? first;
    return {
      deliveryId: current.id, status: current.status,
      ...(current.nativeMessageId ? { nativeMessageId: current.nativeMessageId } : {})
    };
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushLoop(): Promise<void> {
    const ready = await this.store.listReadyOutbox(this.now().toISOString());
    for (const item of ready) await this.dispatch(item);
  }

  private async dispatch(item: ChannelOutboxItem): Promise<void> {
    const adapter = this.adapter(item.instanceId);
    if (!adapter) return;
    const sending = await this.store.updateOutbox(item.id, { status: 'sending', attemptCount: item.attemptCount + 1 });
    this.emit({ type: 'channel.delivery.changed', deliveryId: item.id, status: 'sending' });
    try {
      const receipt = await adapter.send(sending.request);
      await this.store.updateOutbox(item.id, {
        status: 'delivered', deliveredAt: receipt.deliveredAt,
        ...(receipt.nativeMessageId ? { nativeMessageId: receipt.nativeMessageId } : {})
      });
      this.emit({ type: 'channel.delivery.changed', deliveryId: item.id, status: 'delivered' });
    } catch (error) {
      const kind = channelDeliveryFailureKind(error);
      const message = error instanceof Error ? error.message : String(error);
      if (kind === 'retryable' && sending.attemptCount < 8) {
        const delay = Math.min(60_000, 1_000 * 2 ** (sending.attemptCount - 1));
        await this.store.updateOutbox(item.id, {
          status: 'pending', lastError: message,
          nextAttemptAt: new Date(this.now().getTime() + delay).toISOString()
        });
        this.emit({ type: 'channel.delivery.changed', deliveryId: item.id, status: 'pending' });
      } else {
        const status = kind === 'unknown' ? 'unknown' as const : 'failed' as const;
        await this.store.updateOutbox(item.id, { status, lastError: message });
        this.emit({ type: 'channel.delivery.changed', deliveryId: item.id, status });
      }
    }
  }
}

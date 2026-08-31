import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelInboundEvent,
  ChannelSendReceipt,
  ChannelSendRequest,
  ChannelValidationResult
} from './index.js';

export const FAKE_CHANNEL_CAPABILITIES: ChannelCapabilities = {
  inbound: { text: true, markdown: true, image: true, file: true, voice: false, video: false, interaction: true, thread: true },
  outbound: { text: true, markdown: true, image: true, file: true, buttons: true, edit: true, typing: true, thread: true },
  limits: { maxTextChars: 4_096, maxFileBytes: 50 * 1024 * 1024, maxButtons: 8 },
  transport: 'local'
};

export class FakeChannelAdapter implements ChannelAdapter {
  readonly capabilities = FAKE_CHANNEL_CAPABILITIES;
  readonly sent: ChannelSendRequest[] = [];
  private context: ChannelAdapterContext | undefined;

  constructor(readonly kind: string, readonly instanceId: string) {}

  async validateConfig(): Promise<ChannelValidationResult> { return { valid: true }; }
  async start(context: ChannelAdapterContext): Promise<void> { this.context = context; }
  async stop(): Promise<void> { this.context = undefined; }

  async send(request: ChannelSendRequest): Promise<ChannelSendReceipt> {
    this.sent.push(structuredClone(request));
    return { requestId: request.id, nativeMessageId: `native_${request.id}`, deliveredAt: new Date().toISOString() };
  }

  async receive(event: ChannelInboundEvent): Promise<void> {
    if (!this.context) throw new Error('fake_channel_not_started');
    await this.context.emit(structuredClone(event));
  }
}

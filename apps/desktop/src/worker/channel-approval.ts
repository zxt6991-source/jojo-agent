import { createHash, randomBytes } from 'node:crypto';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { ChannelActionToken, ChannelInboundEvent } from '@desktop-agent/channel-core';
import type { ChannelService, ChannelStore } from '@desktop-agent/channel-runtime';

export type DesktopActiveChannelRun = {
  runId: string;
  bindingId: string;
  senderId: string;
};

export type DesktopChannelApprovalBridgeOptions = {
  channels: ChannelService;
  store: ChannelStore;
  activeRun(sessionId: string): DesktopActiveChannelRun | undefined;
  resolve(approvalId: string, allowed: boolean): boolean;
  now?: () => Date;
  tokenTtlMs?: number;
  tokenGenerator?: () => string;
};

export class DesktopChannelApprovalBridge {
  private readonly now: () => Date;
  private readonly tokenGenerator: () => string;

  constructor(private readonly options: DesktopChannelApprovalBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.tokenGenerator = options.tokenGenerator ?? (() => `act_${randomBytes(24).toString('base64url')}`);
  }

  async publish(request: ApprovalRequest): Promise<boolean> {
    const active = this.options.activeRun(request.sessionId);
    if (!active) return false;
    const binding = await this.options.channels.getBinding(active.bindingId);
    if (!binding.policy.enabled) return false;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + (this.options.tokenTtlMs ?? 10 * 60_000)).toISOString();
    const allow = this.tokenGenerator();
    const deny = this.tokenGenerator();
    if (allow.length > 64 || deny.length > 64 || allow === deny || !allow.startsWith('act_') || !deny.startsWith('act_')) {
      throw new Error('channel_action_token_generator_invalid');
    }
    const tokens: ChannelActionToken[] = [
      actionToken(allow, request.requestId, 'allow', active.senderId, createdAt.toISOString(), expiresAt),
      actionToken(deny, request.requestId, 'deny', active.senderId, createdAt.toISOString(), expiresAt)
    ];
    await this.options.store.saveActionTokens(tokens);
    await this.options.channels.deliver({
      bindingId: binding.id,
      content: [
        { type: 'markdown', text: `需要审批\n\n工具：\`${request.call.name}\`\n原因：${request.reason}` },
        {
          type: 'actions',
          buttons: [
            { label: '允许一次', actionToken: allow, style: 'primary' },
            { label: '拒绝', actionToken: deny, style: 'danger' }
          ]
        }
      ],
      correlation: { sessionId: request.sessionId, runId: active.runId, approvalId: request.requestId },
      mode: 'system',
      idempotencyKey: `approval:${request.requestId}`
    });
    return true;
  }

  async handle(event: ChannelInboundEvent): Promise<boolean> {
    const raw = event.interaction?.actionToken;
    if (!raw?.startsWith('act_')) return false;
    const token = await this.options.store.consumeActionToken(hash(raw), event.sender.id, this.now().toISOString());
    if (token.actionType !== 'approval') throw new Error('channel_action_token_type_invalid');
    if (!this.options.resolve(token.payload.approvalId, token.payload.decision === 'allow')) {
      throw new Error(`channel_approval_not_pending: ${token.payload.approvalId}`);
    }
    await this.invalidate(token.payload.approvalId);
    return true;
  }

  async invalidate(approvalId: string): Promise<void> {
    await this.options.store.invalidateApprovalTokens(approvalId, this.now().toISOString());
  }
}

function actionToken(
  raw: string,
  approvalId: string,
  decision: 'allow' | 'deny',
  allowedSenderId: string,
  createdAt: string,
  expiresAt: string
): ChannelActionToken {
  return {
    tokenHash: hash(raw), actionType: 'approval', payload: { approvalId, decision },
    allowedSenderId, createdAt, expiresAt
  };
}

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

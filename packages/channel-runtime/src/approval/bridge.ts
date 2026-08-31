import { createHash, randomBytes } from 'node:crypto';
import type { AppServiceEvent, JojoAppService } from '@desktop-agent/app-service';
import type { ChannelActionToken, ChannelInboundEvent } from '@desktop-agent/channel-core';
import type { RequestContext } from '@desktop-agent/server-protocol';
import type { ActiveChannelRunTarget } from '../manager.js';
import type { ChannelService } from '../service.js';
import type { ChannelStore } from '../store/store.js';

export interface ActiveChannelRunResolver {
  getActiveRunTarget(runId: string): ActiveChannelRunTarget | undefined;
}

export type ChannelApprovalBridgeOptions = {
  app: JojoAppService;
  channels: ChannelService;
  activeRuns: ActiveChannelRunResolver;
  store: ChannelStore;
  now?: () => Date;
  tokenTtlMs?: number;
  tokenGenerator?: () => string;
};

export class ChannelApprovalBridge {
  private readonly now: () => Date;
  private readonly tokenGenerator: () => string;
  private readonly observations = new Set<Promise<void>>();
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly options: ChannelApprovalBridgeOptions) {
    this.now = options.now ?? (() => new Date());
    this.tokenGenerator = options.tokenGenerator ?? (() => `act_${randomBytes(24).toString('base64url')}`);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.options.app.subscribe((event) => this.observe(event));
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled([...this.observations]);
  }

  async handle(event: ChannelInboundEvent): Promise<boolean> {
    const raw = event.interaction?.actionToken;
    if (!raw?.startsWith('act_')) return false;
    const token = await this.options.store.consumeActionToken(hash(raw), event.sender.id, this.now().toISOString());
    if (token.actionType !== 'approval') throw new Error('channel_action_token_type_invalid');
    await this.options.app.resolveApproval(context(event), token.payload.approvalId, token.payload.decision);
    await this.options.store.invalidateApprovalTokens(token.payload.approvalId, this.now().toISOString());
    return true;
  }

  private observe(event: AppServiceEvent): void {
    const observation = event.type === 'approval.required'
      ? this.publish(event.approval)
      : event.type === 'approval.resolved'
        ? this.options.store.invalidateApprovalTokens(event.approval.id, this.now().toISOString())
        : undefined;
    if (!observation) return;
    const tracked = observation.finally(() => this.observations.delete(tracked));
    this.observations.add(tracked);
    void tracked.catch(() => undefined);
  }

  private async publish(approval: Extract<AppServiceEvent, { type: 'approval.required' }>['approval']): Promise<void> {
    const active = this.options.activeRuns.getActiveRunTarget(approval.runId);
    if (!active) return;
    const binding = await this.options.channels.getBinding(active.bindingId);
    if (!binding.policy.enabled) return;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + (this.options.tokenTtlMs ?? 10 * 60_000)).toISOString();
    const allow = this.tokenGenerator();
    const deny = this.tokenGenerator();
    if (allow.length > 64 || deny.length > 64 || allow === deny) throw new Error('channel_action_token_generator_invalid');
    const tokens: ChannelActionToken[] = [
      token(allow, approval.id, 'allow', active.senderId, createdAt.toISOString(), expiresAt),
      token(deny, approval.id, 'deny', active.senderId, createdAt.toISOString(), expiresAt)
    ];
    await this.options.store.saveActionTokens(tokens);
    await this.options.channels.deliver({
      bindingId: binding.id,
      content: [
        {
          type: 'markdown',
          text: `需要审批\n\n工具：\`${approval.request.call.name}\`\n原因：${approval.request.reason}`
        },
        {
          type: 'actions',
          buttons: [
            { label: '允许一次', actionToken: allow, style: 'primary' },
            { label: '拒绝', actionToken: deny, style: 'danger' }
          ]
        }
      ],
      correlation: { sessionId: approval.sessionId, runId: approval.runId, approvalId: approval.id },
      mode: 'system', idempotencyKey: `approval:${approval.id}`
    });
  }
}

function token(
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

function context(event: ChannelInboundEvent): RequestContext {
  return {
    requestId: crypto.randomUUID(),
    principal: {
      id: `channel-user:${event.channel.kind}:${event.channel.instanceId}:${event.sender.id}`,
      type: 'service', scopes: ['approvals:resolve']
    }
  };
}

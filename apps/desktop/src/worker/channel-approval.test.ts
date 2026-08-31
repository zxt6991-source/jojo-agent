import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@desktop-agent/contracts';
import type { ChannelBinding, ChannelDeliveryInput, ChannelInboundEvent } from '@desktop-agent/channel-core';
import { MemoryChannelStore, type ChannelService } from '@desktop-agent/channel-runtime';
import { DesktopChannelApprovalBridge } from './channel-approval';

const now = '2026-08-31T00:00:00.000Z';
const binding: ChannelBinding = {
  id: 'binding', instanceId: 'telegram', conversation: { id: '42', type: 'direct' },
  routing: { sessionMode: 'persistent', sessionId: 'session' },
  policy: { enabled: true, requireMention: false, queueMode: 'queue', allowedSenders: ['owner'], allowAttachments: false },
  revision: 1, createdAt: now, updatedAt: now
};
const approval: ApprovalRequest = {
  requestId: 'approval', sessionId: 'session',
  call: { id: 'call', name: 'terminal', input: {} }, reason: 'External side effect'
};

function interaction(senderId: string, raw: string): ChannelInboundEvent {
  return {
    id: crypto.randomUUID(), kind: 'interaction', channel: { kind: 'telegram', instanceId: 'telegram' },
    conversation: { id: '42', type: 'direct' }, sender: { id: senderId }, interaction: { actionToken: raw },
    receivedAt: now, dedupeKey: crypto.randomUUID(), security: { verified: true, verificationMethod: 'polling_api' }
  };
}

describe('DesktopChannelApprovalBridge', () => {
  it('publishes opaque buttons and resolves once for the initiating sender', async () => {
    const store = new MemoryChannelStore();
    const deliveries: ChannelDeliveryInput[] = [];
    const resolutions: Array<{ id: string; allowed: boolean }> = [];
    const channels = {
      getBinding: async () => binding,
      deliver: async (input: ChannelDeliveryInput) => {
        deliveries.push(input);
        return { deliveryId: 'delivery', status: 'delivered' as const };
      }
    } as unknown as ChannelService;
    const generated = ['act_allow_secure', 'act_deny_secure'];
    const bridge = new DesktopChannelApprovalBridge({
      channels, store,
      activeRun: () => ({ runId: 'run', bindingId: 'binding', senderId: 'owner' }),
      resolve: (id, allowed) => { resolutions.push({ id, allowed }); return true; },
      now: () => new Date(now), tokenGenerator: () => generated.shift()!
    });

    await expect(bridge.publish(approval)).resolves.toBe(true);
    const actions = deliveries[0]?.content.find((block) => block.type === 'actions');
    if (!actions || actions.type !== 'actions') throw new Error('missing actions');
    const allow = actions.buttons[0]!.actionToken;
    expect(JSON.stringify(deliveries[0])).not.toContain('approval:allow');
    await expect(bridge.handle(interaction('attacker', allow))).rejects.toThrow('channel_action_token_sender_mismatch');
    await expect(bridge.handle(interaction('owner', allow))).resolves.toBe(true);
    expect(resolutions).toEqual([{ id: 'approval', allowed: true }]);
    await expect(bridge.handle(interaction('owner', allow))).rejects.toThrow('channel_action_token_used');
  });

  it('does not publish approvals for non-channel sessions', async () => {
    const bridge = new DesktopChannelApprovalBridge({
      channels: {} as ChannelService,
      store: new MemoryChannelStore(),
      activeRun: () => undefined,
      resolve: () => false
    });
    await expect(bridge.publish(approval)).resolves.toBe(false);
  });
});

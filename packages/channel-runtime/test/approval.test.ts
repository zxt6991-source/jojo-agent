import { describe, expect, it } from 'vitest';
import type { AppServiceEvent, JojoAppService } from '@desktop-agent/app-service';
import type { ChannelBinding, ChannelDeliveryInput, ChannelInboundEvent } from '@desktop-agent/channel-core';
import {
  ChannelApprovalBridge,
  MemoryChannelStore,
  type ChannelService
} from '../src/index.js';

const now = '2026-08-30T00:00:00.000Z';
const binding: ChannelBinding = {
  id: 'binding', instanceId: 'telegram', conversation: { id: '42', type: 'direct' },
  routing: { sessionMode: 'persistent', sessionId: 'session' },
  policy: { enabled: true, requireMention: false, queueMode: 'queue', allowedSenders: ['owner'], allowAttachments: false },
  revision: 1, createdAt: now, updatedAt: now
};

function interaction(senderId: string, actionToken: string): ChannelInboundEvent {
  return {
    id: crypto.randomUUID(), kind: 'interaction', channel: { kind: 'telegram', instanceId: 'telegram' },
    conversation: { id: '42', type: 'direct' }, sender: { id: senderId }, interaction: { actionToken },
    receivedAt: now, dedupeKey: crypto.randomUUID(), security: { verified: true, verificationMethod: 'polling_api' }
  };
}

describe('ChannelApprovalBridge', () => {
  it('publishes opaque buttons and only lets the initiating sender resolve once', async () => {
    const store = new MemoryChannelStore();
    const deliveries: ChannelDeliveryInput[] = [];
    const resolutions: Array<{ id: string; decision: string; principal: string }> = [];
    let listener: ((event: AppServiceEvent) => void) | undefined;
    const app = {
      subscribe: (next: (event: AppServiceEvent) => void) => { listener = next; return () => { listener = undefined; }; },
      resolveApproval: async (ctx: { principal: { id: string } }, id: string, decision: string) => {
        resolutions.push({ id, decision, principal: ctx.principal.id });
      }
    } as unknown as JojoAppService;
    const channels = {
      getBinding: async () => binding,
      deliver: async (input: ChannelDeliveryInput) => {
        deliveries.push(input);
        return { deliveryId: 'delivery', status: 'delivered' as const };
      }
    } as unknown as ChannelService;
    const generated = ['act_allow_secure', 'act_deny_secure'];
    const bridge = new ChannelApprovalBridge({
      app, channels, store,
      activeRuns: { getActiveRunTarget: () => ({ runId: 'run', bindingId: 'binding', senderId: 'owner' }) },
      now: () => new Date(now), tokenGenerator: () => generated.shift()!
    });
    bridge.start();
    listener?.({
      type: 'approval.required',
      approval: {
        id: 'approval', sessionId: 'session', laneId: 'main', runId: 'run', createdAt: now,
        request: { requestId: 'approval', sessionId: 'session', call: { id: 'call', name: 'terminal', input: {} }, reason: 'External side effect' }
      }
    });
    await bridge.stop();

    expect(deliveries).toHaveLength(1);
    expect(JSON.stringify(deliveries[0])).not.toContain('approval:approval:allow');
    const actions = deliveries[0]?.content.find((block) => block.type === 'actions');
    if (!actions || actions.type !== 'actions') throw new Error('missing actions');
    const allow = actions.buttons[0]!.actionToken;
    await expect(bridge.handle(interaction('attacker', allow))).rejects.toThrow('channel_action_token_sender_mismatch');
    await expect(bridge.handle(interaction('owner', allow))).resolves.toBe(true);
    expect(resolutions).toEqual([{
      id: 'approval', decision: 'allow', principal: 'channel-user:telegram:telegram:owner'
    }]);
    await expect(bridge.handle(interaction('owner', allow))).rejects.toThrow('channel_action_token_used');
  });
});

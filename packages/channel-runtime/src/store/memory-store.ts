import type {
  ChannelBinding,
  ChannelActionToken,
  ChannelInboundEvent,
  ChannelInstance,
  ChannelOutboxItem,
  ChannelPairing
} from '@desktop-agent/channel-core';
import { assertChannelInstanceSecrets } from '@desktop-agent/channel-core';
import { clone, type ChannelInboundStatus, type ChannelStore } from './store.js';

export class MemoryChannelStore implements ChannelStore {
  private readonly instances = new Map<string, ChannelInstance>();
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly inbound = new Map<string, { instanceId: string; dedupeKey: string; status: ChannelInboundStatus; error?: string }>();
  private readonly dedupe = new Set<string>();
  private readonly pairings = new Map<string, ChannelPairing>();
  private readonly actionTokens = new Map<string, ChannelActionToken>();
  private readonly outbox = new Map<string, ChannelOutboxItem>();
  private readonly outboxKeys = new Map<string, string>();

  async listInstances(): Promise<ChannelInstance[]> { return [...this.instances.values()].map(clone); }
  async getInstance(id: string): Promise<ChannelInstance | undefined> { return clone(this.instances.get(id)); }
  async saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance> {
    assertChannelInstanceSecrets(instance);
    checkRevision(this.instances.get(instance.id)?.revision, expectedRevision, 'channel_instance_revision_conflict');
    this.instances.set(instance.id, clone(instance));
    return clone(instance);
  }
  async deleteInstance(id: string): Promise<void> {
    this.instances.delete(id);
    for (const [pairingId, pairing] of this.pairings) {
      if (pairing.instanceId === id) this.pairings.delete(pairingId);
    }
  }

  async listBindings(instanceId?: string): Promise<ChannelBinding[]> {
    return [...this.bindings.values()].filter((item) => !instanceId || item.instanceId === instanceId).map(clone);
  }
  async getBinding(id: string): Promise<ChannelBinding | undefined> { return clone(this.bindings.get(id)); }
  async findBinding(instanceId: string, conversationId: string, threadId?: string): Promise<ChannelBinding | undefined> {
    const candidates = [...this.bindings.values()].filter((item) => item.instanceId === instanceId && item.conversation.id === conversationId);
    const exact = candidates.find((item) => item.conversation.threadId === threadId);
    return clone(exact ?? candidates.find((item) => item.conversation.threadId === undefined));
  }
  async saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding> {
    checkRevision(this.bindings.get(binding.id)?.revision, expectedRevision, 'channel_binding_revision_conflict');
    const duplicate = [...this.bindings.values()].find((item) => item.id !== binding.id
      && item.instanceId === binding.instanceId
      && item.conversation.id === binding.conversation.id
      && item.conversation.threadId === binding.conversation.threadId);
    if (duplicate) throw new Error(`channel_binding_conflict: ${duplicate.id}`);
    this.bindings.set(binding.id, clone(binding));
    return clone(binding);
  }
  async deleteBinding(id: string): Promise<void> { this.bindings.delete(id); }

  async claimInbound(event: ChannelInboundEvent): Promise<boolean> {
    const key = `${event.channel.instanceId}\u0000${event.dedupeKey}`;
    if (this.dedupe.has(key)) return false;
    this.dedupe.add(key);
    this.inbound.set(event.id, { instanceId: event.channel.instanceId, dedupeKey: event.dedupeKey, status: 'received' });
    return true;
  }
  async markInbound(eventId: string, status: ChannelInboundStatus, error?: string): Promise<void> {
    const current = this.inbound.get(eventId);
    if (!current) throw new Error(`channel_inbound_not_found: ${eventId}`);
    this.inbound.set(eventId, { ...current, status, ...(error ? { error } : {}) });
  }

  async findPendingPairing(instanceId: string, conversationId: string, senderId: string): Promise<ChannelPairing | undefined> {
    return clone([...this.pairings.values()].find((item) => item.instanceId === instanceId
      && item.conversationId === conversationId && item.senderId === senderId && item.status === 'pending'));
  }
  async listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]> {
    return [...this.pairings.values()].filter((item) => !status || item.status === status).map(clone);
  }
  async savePairing(pairing: ChannelPairing): Promise<ChannelPairing> {
    this.pairings.set(pairing.id, clone(pairing));
    return clone(pairing);
  }
  async resolvePairing(id: string, status: 'approved' | 'rejected', resolvedAt: string): Promise<ChannelPairing> {
    const pairing = this.pairings.get(id);
    if (!pairing) throw new Error(`channel_pairing_not_found: ${id}`);
    if (pairing.status !== 'pending') throw new Error(`channel_pairing_already_resolved: ${id}`);
    const resolved = { ...pairing, status, resolvedAt };
    this.pairings.set(id, resolved);
    return clone(resolved);
  }

  async saveActionTokens(tokens: ChannelActionToken[]): Promise<void> {
    for (const token of tokens) {
      if (this.actionTokens.has(token.tokenHash)) throw new Error('channel_action_token_conflict');
      this.actionTokens.set(token.tokenHash, clone(token));
    }
  }
  async consumeActionToken(tokenHash: string, senderId: string, now: string): Promise<ChannelActionToken> {
    const token = this.actionTokens.get(tokenHash);
    if (!token) throw new Error('channel_action_token_invalid');
    if (token.usedAt) throw new Error('channel_action_token_used');
    if (token.expiresAt <= now) throw new Error('channel_action_token_expired');
    if (token.allowedSenderId && token.allowedSenderId !== senderId) throw new Error('channel_action_token_sender_mismatch');
    const used = { ...token, usedAt: now };
    this.actionTokens.set(tokenHash, used);
    return clone(used);
  }
  async invalidateApprovalTokens(approvalId: string, now: string): Promise<void> {
    for (const [hash, token] of this.actionTokens) {
      if (!token.usedAt && token.payload.approvalId === approvalId) this.actionTokens.set(hash, { ...token, usedAt: now });
    }
  }

  async enqueueOutbox(item: ChannelOutboxItem): Promise<ChannelOutboxItem> {
    const existingId = this.outboxKeys.get(item.idempotencyKey);
    if (existingId) return clone(this.outbox.get(existingId)!);
    this.outbox.set(item.id, clone(item));
    this.outboxKeys.set(item.idempotencyKey, item.id);
    return clone(item);
  }
  async getOutbox(id: string): Promise<ChannelOutboxItem | undefined> { return clone(this.outbox.get(id)); }
  async listOutbox(options: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number } = {}): Promise<ChannelOutboxItem[]> {
    return [...this.outbox.values()]
      .filter((item) => (!options.instanceId || item.instanceId === options.instanceId)
        && (!options.status || item.status === options.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, options.limit ?? 100)
      .map(clone);
  }
  async listReadyOutbox(now: string, limit = 100): Promise<ChannelOutboxItem[]> {
    return [...this.outbox.values()]
      .filter((item) => item.status === 'pending' && (!item.nextAttemptAt || item.nextAttemptAt <= now))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, limit).map(clone);
  }
  async updateOutbox(id: string, patch: Partial<Omit<ChannelOutboxItem, 'id' | 'request' | 'createdAt'>>): Promise<ChannelOutboxItem> {
    const current = this.outbox.get(id);
    if (!current) throw new Error(`channel_delivery_not_found: ${id}`);
    const updated = { ...current, ...clone(patch) };
    this.outbox.set(id, updated);
    return clone(updated);
  }
  async recoverOutbox(): Promise<void> {
    for (const [id, item] of this.outbox) if (item.status === 'sending') this.outbox.set(id, { ...item, status: 'unknown' });
  }
  async close(): Promise<void> {}
}

function checkRevision(current: number | undefined, expected: number | undefined, code: string): void {
  if (expected !== undefined && current !== expected) throw new Error(`${code}: expected ${expected}, got ${current ?? 'missing'}`);
}

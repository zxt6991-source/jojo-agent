import type {
  ChannelBinding,
  ChannelActionToken,
  ChannelInboundEvent,
  ChannelInstance,
  ChannelOutboxItem,
  ChannelPairing
} from '@desktop-agent/channel-core';

export type ChannelInboundStatus = 'received' | 'processing' | 'processed' | 'rejected' | 'failed';

export interface ChannelStore {
  listInstances(): Promise<ChannelInstance[]>;
  getInstance(id: string): Promise<ChannelInstance | undefined>;
  saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance>;
  deleteInstance(id: string): Promise<void>;

  listBindings(instanceId?: string): Promise<ChannelBinding[]>;
  getBinding(id: string): Promise<ChannelBinding | undefined>;
  findBinding(instanceId: string, conversationId: string, threadId?: string): Promise<ChannelBinding | undefined>;
  saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding>;
  deleteBinding(id: string): Promise<void>;

  claimInbound(event: ChannelInboundEvent): Promise<boolean>;
  markInbound(eventId: string, status: ChannelInboundStatus, error?: string): Promise<void>;

  findPendingPairing(instanceId: string, conversationId: string, senderId: string): Promise<ChannelPairing | undefined>;
  listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]>;
  savePairing(pairing: ChannelPairing): Promise<ChannelPairing>;
  resolvePairing(id: string, status: 'approved' | 'rejected', resolvedAt: string): Promise<ChannelPairing>;

  saveActionTokens(tokens: ChannelActionToken[]): Promise<void>;
  consumeActionToken(tokenHash: string, senderId: string, now: string): Promise<ChannelActionToken>;
  invalidateApprovalTokens(approvalId: string, now: string): Promise<void>;

  enqueueOutbox(item: ChannelOutboxItem): Promise<ChannelOutboxItem>;
  getOutbox(id: string): Promise<ChannelOutboxItem | undefined>;
  listOutbox(options?: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number }): Promise<ChannelOutboxItem[]>;
  listReadyOutbox(now: string, limit?: number): Promise<ChannelOutboxItem[]>;
  updateOutbox(id: string, patch: Partial<Omit<ChannelOutboxItem, 'id' | 'request' | 'createdAt'>>): Promise<ChannelOutboxItem>;
  recoverOutbox(): Promise<void>;

  close(): Promise<void>;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

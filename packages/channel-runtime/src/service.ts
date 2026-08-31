import type {
  ChannelBinding,
  ChannelDeliveryInput,
  ChannelDeliveryReceipt,
  ChannelInstance,
  ChannelInstanceHealth,
  ChannelOutboxItem,
  ChannelPairing,
  ChannelRuntimeEvent
} from '@desktop-agent/channel-core';

export interface ChannelService {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(input: ChannelDeliveryInput): Promise<ChannelDeliveryReceipt>;
  listBindings(): Promise<ChannelBinding[]>;
  getBinding(bindingId: string): Promise<ChannelBinding>;
  listInstances(): Promise<ChannelInstance[]>;
  getInstance(instanceId: string): Promise<ChannelInstance>;
  saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance>;
  deleteInstance(instanceId: string, expectedRevision?: number): Promise<void>;
  saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding>;
  deleteBinding(bindingId: string, expectedRevision?: number): Promise<void>;
  listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]>;
  approvePairing(pairingId: string, binding: ChannelBinding): Promise<ChannelBinding>;
  rejectPairing(pairingId: string): Promise<void>;
  listDeliveries(options?: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number }): Promise<ChannelOutboxItem[]>;
  getDelivery(deliveryId: string): Promise<ChannelOutboxItem>;
  listHealth(): Promise<Array<{ instanceId: string; health: ChannelInstanceHealth }>>;
  subscribe(listener: (event: ChannelRuntimeEvent) => void): () => void;
}

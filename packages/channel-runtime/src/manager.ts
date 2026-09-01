import { createHash, randomInt } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelAdapterHealthUpdate,
  ChannelAdapterRegistry,
  ChannelBinding,
  ChannelDeliveryInput,
  ChannelDeliveryReceipt,
  ChannelInboundEvent,
  ChannelInstance,
  ChannelInstanceHealth,
  ChannelOutboxItem,
  ChannelPairing,
  ChannelPrincipal,
  ChannelRuntimeEvent,
  ChannelSecretResolver,
  ChannelWebhookRequest,
  ChannelWebhookResponse
} from '@desktop-agent/channel-core';
import { ChannelConversationQueue } from './inbound/queue.js';
import { ChannelOutboxService } from './outbound/outbox.js';
import type { ChannelAgentBridge } from './runtime/app-service-bridge.js';
import type { ChannelStore } from './store/store.js';

export type ChannelManagerOptions = {
  store: ChannelStore;
  registry: ChannelAdapterRegistry;
  secrets: ChannelSecretResolver;
  agent: ChannelAgentBridge;
  now?: () => Date;
  idGenerator?: () => string;
  pairingTtlMs?: number;
  interactionHandler?: { handle(event: ChannelInboundEvent): Promise<boolean> };
};

export type ActiveChannelRunTarget = {
  runId: string;
  bindingId: string;
  senderId: string;
};

export class DefaultChannelManager {
  private readonly listeners = new Set<(event: ChannelRuntimeEvent) => void>();
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue = new ChannelConversationQueue();
  private readonly activeRuns = new Map<string, ActiveChannelRunTarget>();
  private readonly health = new Map<string, ChannelInstanceHealth>();
  private readonly outbox: ChannelOutboxService;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private interactionHandler: ChannelManagerOptions['interactionHandler'];
  private started = false;
  private stopping = false;

  constructor(private readonly options: ChannelManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.interactionHandler = options.interactionHandler;
    this.outbox = new ChannelOutboxService(options.store, (id) => this.adapters.get(id), (event) => {
      this.emit(event);
      if (event.type === 'channel.delivery.changed' && event.status === 'delivered') {
        void this.recordOutbound(event.deliveryId);
      }
    }, this.now, this.idGenerator);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    for (const instance of await this.options.store.listInstances()) {
      if (instance.enabled) await this.startInstance(instance);
      else this.health.set(instance.id, { status: 'stopped', reconnectCount: 0 });
    }
    await this.outbox.start();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort('channel_runtime_stopping');
    await Promise.allSettled([...this.adapters.entries()].map(async ([id, adapter]) => {
      await adapter.stop();
      this.setHealth(id, { status: 'stopped' });
    }));
    this.adapters.clear();
    this.controllers.clear();
    await this.queue.drain();
    await this.outbox.stop();
    await this.options.store.close();
    this.listeners.clear();
    this.started = false;
  }

  async listInstances(): Promise<ChannelInstance[]> { return this.options.store.listInstances(); }
  async getInstance(instanceId: string): Promise<ChannelInstance> {
    const instance = await this.options.store.getInstance(instanceId);
    if (!instance) throw new Error(`channel_instance_not_found: ${instanceId}`);
    return instance;
  }
  async listBindings(): Promise<ChannelBinding[]> { return this.options.store.listBindings(); }
  async getBinding(bindingId: string): Promise<ChannelBinding> {
    const binding = await this.options.store.getBinding(bindingId);
    if (!binding) throw new Error(`channel_binding_not_found: ${bindingId}`);
    return binding;
  }
  async listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]> { return this.options.store.listPairings(status); }

  async saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance> {
    const saved = await this.options.store.saveInstance(instance, expectedRevision);
    if (this.started) await this.reloadInstance(saved.id);
    return saved;
  }

  async deleteInstance(instanceId: string, expectedRevision?: number): Promise<void> {
    const instance = await this.getInstance(instanceId);
    if (expectedRevision !== undefined && expectedRevision !== instance.revision) {
      throw new Error(`channel_instance_revision_conflict: ${instanceId}`);
    }
    if ((await this.options.store.listBindings(instanceId)).length) throw new Error(`channel_instance_has_bindings: ${instanceId}`);
    const adapter = this.adapters.get(instanceId);
    this.controllers.get(instanceId)?.abort('channel_instance_deleted');
    if (adapter) await adapter.stop();
    this.adapters.delete(instanceId);
    this.controllers.delete(instanceId);
    await this.options.store.deleteInstance(instanceId);
    this.health.delete(instanceId);
  }

  async saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding> {
    if (!await this.options.store.getInstance(binding.instanceId)) throw new Error(`channel_instance_not_found: ${binding.instanceId}`);
    return this.options.store.saveBinding(binding, expectedRevision);
  }

  async deleteBinding(bindingId: string, expectedRevision?: number): Promise<void> {
    const binding = await this.getBinding(bindingId);
    if (expectedRevision !== undefined && expectedRevision !== binding.revision) {
      throw new Error(`channel_binding_revision_conflict: ${bindingId}`);
    }
    await this.options.store.deleteBinding(bindingId);
  }

  async listDeliveries(options?: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number }): Promise<ChannelOutboxItem[]> {
    return this.options.store.listOutbox(options);
  }

  async getDelivery(deliveryId: string): Promise<ChannelOutboxItem> {
    const delivery = await this.options.store.getOutbox(deliveryId);
    if (!delivery) throw new Error(`channel_delivery_not_found: ${deliveryId}`);
    return delivery;
  }

  async listHealth(): Promise<Array<{ instanceId: string; health: ChannelInstanceHealth }>> {
    return (await this.options.store.listInstances()).map((instance) => ({
      instanceId: instance.id,
      health: structuredClone(this.health.get(instance.id) ?? {
        status: instance.enabled ? 'starting' : 'stopped', reconnectCount: 0
      })
    }));
  }

  async approvePairing(pairingId: string, binding: ChannelBinding): Promise<ChannelBinding> {
    const pairing = (await this.options.store.listPairings()).find((item) => item.id === pairingId);
    if (!pairing) throw new Error(`channel_pairing_not_found: ${pairingId}`);
    if (pairing.expiresAt <= this.now().toISOString()) throw new Error(`channel_pairing_expired: ${pairingId}`);
    if (binding.instanceId !== pairing.instanceId || binding.conversation.id !== pairing.conversationId) {
      throw new Error('channel_pairing_binding_mismatch');
    }
    const allowedSenders = new Set(binding.policy.allowedSenders ?? []);
    allowedSenders.add(pairing.senderId);
    const saved = await this.saveBinding({
      ...binding,
      policy: { ...binding.policy, allowedSenders: [...allowedSenders] }
    });
    await this.options.store.resolvePairing(pairingId, 'approved', this.now().toISOString());
    return saved;
  }

  async rejectPairing(pairingId: string): Promise<void> {
    await this.options.store.resolvePairing(pairingId, 'rejected', this.now().toISOString());
  }

  async reloadInstance(instanceId: string): Promise<void> {
    const adapter = this.adapters.get(instanceId);
    this.controllers.get(instanceId)?.abort('channel_instance_reload');
    if (adapter) await adapter.stop();
    this.adapters.delete(instanceId);
    this.controllers.delete(instanceId);
    const instance = await this.options.store.getInstance(instanceId);
    if (instance?.enabled) await this.startInstance(instance);
    else if (instance) this.setHealth(instance.id, { status: 'stopped' });
  }

  async handleWebhook(instanceId: string, request: ChannelWebhookRequest): Promise<ChannelWebhookResponse> {
    const adapter = this.adapters.get(instanceId);
    if (!adapter) return { status: 404, body: { error: 'channel_instance_not_running' } };
    if (!adapter.handleWebhook) return { status: 405, body: { error: 'channel_webhook_not_supported' } };
    return adapter.handleWebhook(request);
  }

  async deliver(input: ChannelDeliveryInput): Promise<ChannelDeliveryReceipt> {
    const binding = input.bindingId ? await this.getBinding(input.bindingId) : undefined;
    if (binding && !binding.policy.enabled) throw new Error(`channel_binding_disabled: ${binding.id}`);
    return this.outbox.deliver(input, binding);
  }

  getActiveRunTarget(runId: string): ActiveChannelRunTarget | undefined {
    const target = this.activeRuns.get(runId);
    return target ? { ...target } : undefined;
  }

  setInteractionHandler(handler: NonNullable<ChannelManagerOptions['interactionHandler']>): void {
    this.interactionHandler = handler;
  }

  subscribe(listener: (event: ChannelRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async startInstance(instance: ChannelInstance): Promise<void> {
    this.setHealth(instance.id, { status: 'starting' });
    try {
      const adapter = await this.options.registry.get(instance.kind).create({ instance, secrets: this.options.secrets });
      if (adapter.instanceId !== instance.id || adapter.kind !== instance.kind) throw new Error('channel_adapter_identity_mismatch');
      const validation = await adapter.validateConfig();
      if (!validation.valid) throw new Error(`channel_config_invalid: ${validation.errors.join('; ')}`);
      const controller = new AbortController();
      this.adapters.set(instance.id, adapter);
      this.controllers.set(instance.id, controller);
      await adapter.start({
        signal: controller.signal,
        emit: (event) => this.receive(event),
        reportHealth: (update) => this.updateAdapterHealth(instance.id, update)
      });
      this.setHealth(instance.id, { status: 'connected' });
    } catch (error) {
      this.adapters.delete(instance.id);
      this.controllers.delete(instance.id);
      this.setHealth(instance.id, { status: 'failed', lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async receive(event: ChannelInboundEvent): Promise<void> {
    if (this.stopping) return;
    const current = this.health.get(event.channel.instanceId);
    if (current) this.health.set(event.channel.instanceId, { ...current, lastInboundAt: this.now().toISOString() });
    if (!await this.options.store.claimInbound(event)) return;
    this.emit({ type: 'channel.inbound.received', eventId: event.id, instanceId: event.channel.instanceId });
    try {
      await this.options.store.markInbound(event.id, 'processing');
      await this.route(event);
      await this.options.store.markInbound(event.id, 'processed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected = message.startsWith('channel_inbound_rejected:');
      await this.options.store.markInbound(event.id, rejected ? 'rejected' : 'failed', message);
      this.emit({ type: 'channel.inbound.rejected', eventId: event.id, instanceId: event.channel.instanceId, reason: message });
    }
  }

  private async route(event: ChannelInboundEvent): Promise<void> {
    const adapter = this.adapters.get(event.channel.instanceId);
    if (!adapter || adapter.kind !== event.channel.kind) throw new Error('channel_inbound_rejected: adapter identity mismatch');
    if (!event.security.verified) throw new Error('channel_inbound_rejected: unverified event');
    if (event.sender.isBot) throw new Error('channel_inbound_rejected: bot sender');
    if (event.kind === 'interaction') {
      if (await this.interactionHandler?.handle(event)) return;
      throw new Error('channel_inbound_rejected: unknown interaction');
    }
    if (event.kind !== 'message' || !event.message) throw new Error('channel_inbound_rejected: unsupported event kind');
    const binding = await this.options.store.findBinding(event.channel.instanceId, event.conversation.id, event.conversation.threadId);
    if (!binding) {
      if (event.conversation.type === 'group') throw new Error('channel_inbound_rejected: group not bound');
      await this.createPairing(event);
      throw new Error('channel_inbound_rejected: pairing required');
    }
    if (!binding.policy.enabled) throw new Error('channel_inbound_rejected: binding disabled');
    if (binding.conversation.type !== event.conversation.type) throw new Error('channel_inbound_rejected: conversation type mismatch');
    if (event.conversation.type === 'group' && binding.policy.requireMention && !event.message.mentions?.length) {
      throw new Error('channel_inbound_rejected: mention required');
    }
    if (binding.policy.allowedSenders?.length && !binding.policy.allowedSenders.includes(event.sender.id)) {
      throw new Error('channel_inbound_rejected: sender not allowed');
    }
    const attachments = event.message.content?.some((block) => !['text', 'markdown', 'actions'].includes(block.type));
    if (attachments && !binding.policy.allowAttachments) throw new Error('channel_inbound_rejected: attachments disabled');
    const text = messageText(event);
    if (!text.trim()) throw new Error('channel_inbound_rejected: empty message');

    const activeBinding = await this.resolveThreadBinding(binding, event);
    const key = [activeBinding.id, event.conversation.id, event.conversation.threadId ?? ''].join('\u0000');
    if (activeBinding.policy.queueMode === 'reject' && this.queue.depth(key) > 0) {
      throw new Error('channel_inbound_rejected: conversation busy');
    }
    await this.queue.enqueue(key, () => this.execute(activeBinding, event, text));
  }

  private async resolveThreadBinding(binding: ChannelBinding, event: ChannelInboundEvent): Promise<ChannelBinding> {
    if (binding.routing.sessionMode !== 'per_thread' || !event.conversation.threadId || binding.conversation.threadId) return binding;
    const existing = await this.options.store.findBinding(binding.instanceId, event.conversation.id, event.conversation.threadId);
    if (existing?.conversation.threadId === event.conversation.threadId) return existing;
    const digest = createHash('sha256').update(event.conversation.threadId).digest('hex').slice(0, 16);
    const now = this.now().toISOString();
    const threadRouting = structuredClone(binding.routing);
    delete threadRouting.sessionId;
    try {
      return await this.options.store.saveBinding({
        ...binding,
        id: `${binding.id}:thread:${digest}`,
        conversation: { ...binding.conversation, threadId: event.conversation.threadId },
        routing: threadRouting,
        revision: 1,
        createdAt: now,
        updatedAt: now
      });
    } catch (error) {
      if (!String(error).includes('channel_binding_conflict')) throw error;
      const raced = await this.options.store.findBinding(binding.instanceId, event.conversation.id, event.conversation.threadId);
      if (!raced) throw error;
      return raced;
    }
  }

  private async execute(binding: ChannelBinding, event: ChannelInboundEvent, text: string): Promise<void> {
    const instance = await this.options.store.getInstance(binding.instanceId);
    if (!instance?.enabled) throw new Error('channel_inbound_rejected: instance disabled');
    const principal: ChannelPrincipal = {
      id: `channel-user:${instance.kind}:${instance.id}:${event.sender.id}`,
      type: 'channel_user', channelKind: instance.kind, instanceId: instance.id,
      externalUserId: event.sender.id, conversationId: event.conversation.id, trusted: true
    };
    const sessionId = await this.options.agent.ensureSession(binding, principal);
    let activeBinding = binding;
    if (binding.routing.sessionMode !== 'stateless' && binding.routing.sessionId !== sessionId) {
      activeBinding = await this.options.store.saveBinding({
        ...binding, routing: { ...binding.routing, sessionId }, revision: binding.revision + 1,
        updatedAt: this.now().toISOString()
      }, binding.revision);
    }
    const runId = this.idGenerator();
    this.activeRuns.set(runId, { runId, bindingId: activeBinding.id, senderId: event.sender.id });
    let result;
    try {
      result = await this.options.agent.run({
        runId, sessionId, binding: activeBinding, event, principal, text,
        onStarted: (startedRunId) => this.emit({ type: 'channel.run.started', eventId: event.id, sessionId, runId: startedRunId })
      });
    } finally { this.activeRuns.delete(runId); }
    const finalText = result.status === 'completed' && result.finalText
      ? result.finalText
      : '任务执行未成功完成，请稍后重试。';
    await this.outbox.deliver({
      bindingId: activeBinding.id,
      content: [{ type: 'markdown', text: finalText }],
      ...(event.message?.id ? { replyTo: event.message.id } : {}),
      correlation: { sessionId, runId: result.runId },
      mode: 'reply', idempotencyKey: `reply:${event.channel.instanceId}:${event.dedupeKey}`
    }, activeBinding);
  }

  private async createPairing(event: ChannelInboundEvent): Promise<void> {
    const existing = await this.options.store.findPendingPairing(event.channel.instanceId, event.conversation.id, event.sender.id);
    if (existing && existing.expiresAt > this.now().toISOString()) return;
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const createdAt = this.now();
    const pairing: ChannelPairing = {
      id: this.idGenerator(), instanceId: event.channel.instanceId, conversationId: event.conversation.id,
      senderId: event.sender.id, codeHash: createHash('sha256').update(code).digest('hex'), status: 'pending',
      expiresAt: new Date(createdAt.getTime() + (this.options.pairingTtlMs ?? 15 * 60_000)).toISOString(),
      createdAt: createdAt.toISOString()
    };
    await this.options.store.savePairing(pairing);
    this.emit({ type: 'channel.pairing.created', pairingId: pairing.id, code });
    await this.outbox.deliver({
      target: {
        instanceId: event.channel.instanceId, conversationId: event.conversation.id,
        ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {})
      },
      content: [{ type: 'text', text: `此会话尚未授权。请在 Jojo 管理端批准配对码：${code}` }],
      mode: 'system', idempotencyKey: `pairing:${pairing.id}`
    });
  }

  private emit(event: ChannelRuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Channel observers are isolated. */ }
    }
  }

  private setHealth(instanceId: string, patch: Partial<ChannelInstanceHealth>): void {
    const previous = this.health.get(instanceId) ?? { status: 'stopped' as const, reconnectCount: 0 };
    const health: ChannelInstanceHealth = { ...previous, ...patch };
    if (patch.status === 'connected' && patch.lastError === undefined) delete health.lastError;
    this.health.set(instanceId, health);
    if (patch.status) this.emit({
      type: 'channel.instance.status', instanceId, status: patch.status,
      ...(patch.lastError ? { error: patch.lastError } : {})
    });
  }

  private updateAdapterHealth(instanceId: string, update: ChannelAdapterHealthUpdate): void {
    const previous = this.health.get(instanceId) ?? { status: 'starting' as const, reconnectCount: 0 };
    const patch: Partial<ChannelInstanceHealth> = {
      status: update.status,
      reconnectCount: previous.reconnectCount + (update.reconnectIncrement ?? 0)
    };
    if (update.error) patch.lastError = update.error;
    this.setHealth(instanceId, patch);
  }

  private async recordOutbound(deliveryId: string): Promise<void> {
    const delivery = await this.options.store.getOutbox(deliveryId);
    if (!delivery) return;
    const current = this.health.get(delivery.instanceId);
    if (current) this.health.set(delivery.instanceId, { ...current, lastOutboundAt: this.now().toISOString() });
  }
}

function messageText(event: ChannelInboundEvent): string {
  const blocks = event.message?.content?.flatMap((block) => block.type === 'text' || block.type === 'markdown' ? [block.text] : []) ?? [];
  return [event.message?.text, ...blocks].filter((value): value is string => Boolean(value)).join('\n\n');
}

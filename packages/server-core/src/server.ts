import { createHash } from 'node:crypto';
import type { AppServiceEvent, DurableIdempotencyStore, JojoAppService } from '@desktop-agent/app-service';
import type {
  ChannelBinding,
  ChannelDeliveryInput,
  ChannelDeliveryReceipt,
  ChannelInstance,
  ChannelInstanceHealth,
  ChannelOutboxItem,
  ChannelPairing
} from '@desktop-agent/channel-core';
import type {
  CreateScheduleInput as SchedulerCreateScheduleInput,
  ScheduleEvent,
  ScheduleRunListOptions as SchedulerRunListOptions,
  ScheduleService,
  UpdateScheduleInput as SchedulerUpdateScheduleInput
} from '@desktop-agent/scheduler';
import {
  JOJO_SERVER_PROTOCOL_VERSION,
  type ClientCommand,
  type ApproveChannelPairingInput,
  type ChannelBindingDto,
  type ChannelDeliveryDto,
  type ChannelDeliveryListQuery,
  type ChannelHealthDto,
  type ChannelInstanceDto,
  type ChannelPairingDto,
  type CreateChannelBindingInput,
  type CreateChannelInstanceInput,
  type CreateScheduleInput,
  type CreateSessionInput,
  type LeaseMode,
  type LeaseSnapshot,
  type ModelInfo,
  type PatchSessionMetadataInput,
  type RequestContext,
  type RunSnapshot,
  type RunScheduleNowInput,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunListQuery,
  type ServerCapabilities,
  type ServerInfo,
  type ServerSessionSnapshot,
  type ServerSessionSummary,
  type ServerSnapshot,
  type StartRunInput,
  type TranscriptPage,
  type TranscriptQuery,
  type TestChannelInput,
  type UpdateChannelBindingInput,
  type UpdateChannelInstanceInput,
  type UpdateScheduleInput
} from '@desktop-agent/server-protocol';
import { IdempotencyStore } from './idempotency.js';
import { LeaseManager } from './leases.js';
import { ScopePolicy } from './scope-policy.js';
import { ProtocolFailure } from './errors.js';

export type ServerCoreEvent = AppServiceEvent | ScheduleEvent;

export interface ChannelAdminService {
  listInstances(): Promise<ChannelInstance[]>;
  getInstance(instanceId: string): Promise<ChannelInstance>;
  saveInstance(instance: ChannelInstance, expectedRevision?: number): Promise<ChannelInstance>;
  deleteInstance(instanceId: string, expectedRevision?: number): Promise<void>;
  listBindings(): Promise<ChannelBinding[]>;
  getBinding(bindingId: string): Promise<ChannelBinding>;
  saveBinding(binding: ChannelBinding, expectedRevision?: number): Promise<ChannelBinding>;
  deleteBinding(bindingId: string, expectedRevision?: number): Promise<void>;
  listPairings(status?: ChannelPairing['status']): Promise<ChannelPairing[]>;
  approvePairing(pairingId: string, binding: ChannelBinding): Promise<ChannelBinding>;
  rejectPairing(pairingId: string): Promise<void>;
  listDeliveries(options?: { instanceId?: string; status?: ChannelOutboxItem['status']; limit?: number }): Promise<ChannelOutboxItem[]>;
  getDelivery(deliveryId: string): Promise<ChannelOutboxItem>;
  listHealth(): Promise<Array<{ instanceId: string; health: ChannelInstanceHealth }>>;
  deliver(input: ChannelDeliveryInput): Promise<ChannelDeliveryReceipt>;
}

export type JojoServerCoreOptions = {
  serverId?: string;
  serverVersion?: string;
  models?: ModelInfo[];
  capabilities?: Partial<ServerCapabilities>;
  workspaceRoots?: string[];
  idGenerator?: () => string;
  now?: () => Date;
  idempotencyStore?: DurableIdempotencyStore;
  scheduler?: ScheduleService;
  channels?: ChannelAdminService;
  channelKinds?: string[];
};

export interface JojoServerCore {
  readonly info: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly models: ModelInfo[];
  serverSnapshot(ctx: RequestContext): Promise<ServerSnapshot>;
  listSessions(ctx: RequestContext): Promise<ServerSessionSummary[]>;
  createSession(ctx: RequestContext, input: CreateSessionInput, idempotencyKey?: string): Promise<ServerSessionSnapshot>;
  patchSession(
    ctx: RequestContext,
    sessionId: string,
    input: PatchSessionMetadataInput,
    idempotencyKey?: string
  ): Promise<ServerSessionSnapshot>;
  getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot>;
  transcript(ctx: RequestContext, sessionId: string, query?: TranscriptQuery): Promise<TranscriptPage>;
  attach(ctx: RequestContext, sessionId: string, mode: LeaseMode): Promise<LeaseSnapshot>;
  detach(ctx: RequestContext, sessionId: string): Promise<void>;
  startRun(ctx: RequestContext, sessionId: string, input: StartRunInput, idempotencyKey?: string): Promise<RunSnapshot>;
  getRun(ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot>;
  cancelRun(ctx: RequestContext, sessionId: string, runId: string, reason?: string): Promise<void>;
  resolveApproval(ctx: RequestContext, approvalId: string, decision: 'allow' | 'deny', idempotencyKey?: string): Promise<void>;
  listSchedules(ctx: RequestContext): Promise<Schedule[]>;
  createSchedule(ctx: RequestContext, input: CreateScheduleInput, idempotencyKey?: string): Promise<Schedule>;
  getSchedule(ctx: RequestContext, scheduleId: string): Promise<Schedule>;
  updateSchedule(
    ctx: RequestContext,
    scheduleId: string,
    input: UpdateScheduleInput,
    idempotencyKey?: string
  ): Promise<Schedule>;
  deleteSchedule(ctx: RequestContext, scheduleId: string, idempotencyKey?: string): Promise<void>;
  runScheduleNow(
    ctx: RequestContext,
    scheduleId: string,
    input?: RunScheduleNowInput,
    idempotencyKey?: string
  ): Promise<ScheduleRun>;
  listScheduleRuns(ctx: RequestContext, scheduleId: string, query?: ScheduleRunListQuery): Promise<ScheduleRun[]>;
  getScheduleRun(ctx: RequestContext, runId: string): Promise<ScheduleRun>;
  cancelScheduleRun(ctx: RequestContext, runId: string, idempotencyKey?: string): Promise<void>;
  listChannelInstances(ctx: RequestContext): Promise<ChannelInstanceDto[]>;
  getChannelInstance(ctx: RequestContext, instanceId: string): Promise<ChannelInstanceDto>;
  createChannelInstance(ctx: RequestContext, input: CreateChannelInstanceInput, idempotencyKey?: string): Promise<ChannelInstanceDto>;
  updateChannelInstance(ctx: RequestContext, instanceId: string, input: UpdateChannelInstanceInput, idempotencyKey?: string): Promise<ChannelInstanceDto>;
  deleteChannelInstance(ctx: RequestContext, instanceId: string, expectedRevision?: number, idempotencyKey?: string): Promise<void>;
  testChannel(ctx: RequestContext, instanceId: string, input: TestChannelInput, idempotencyKey?: string): Promise<ChannelDeliveryReceipt>;
  listChannelBindings(ctx: RequestContext): Promise<ChannelBindingDto[]>;
  createChannelBinding(ctx: RequestContext, input: CreateChannelBindingInput, idempotencyKey?: string): Promise<ChannelBindingDto>;
  updateChannelBinding(ctx: RequestContext, bindingId: string, input: UpdateChannelBindingInput, idempotencyKey?: string): Promise<ChannelBindingDto>;
  deleteChannelBinding(ctx: RequestContext, bindingId: string, expectedRevision?: number, idempotencyKey?: string): Promise<void>;
  listChannelPairings(ctx: RequestContext, status?: ChannelPairing['status']): Promise<ChannelPairingDto[]>;
  approveChannelPairing(ctx: RequestContext, pairingId: string, input: ApproveChannelPairingInput, idempotencyKey?: string): Promise<ChannelBindingDto>;
  rejectChannelPairing(ctx: RequestContext, pairingId: string, idempotencyKey?: string): Promise<void>;
  listChannelDeliveries(ctx: RequestContext, query?: ChannelDeliveryListQuery): Promise<ChannelDeliveryDto[]>;
  getChannelDelivery(ctx: RequestContext, deliveryId: string): Promise<ChannelDeliveryDto>;
  listChannelHealth(ctx: RequestContext): Promise<ChannelHealthDto[]>;
  dispatch(ctx: RequestContext, command: ClientCommand): Promise<unknown>;
  closeConnection(connectionId: string): void;
  subscribe(listener: (event: ServerCoreEvent) => void): () => void;
  close(): Promise<void>;
}

class DefaultJojoServerCore implements JojoServerCore {
  readonly info: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly models: ModelInfo[];
  private readonly leases: LeaseManager;
  private readonly idempotency: IdempotencyStore;
  private readonly scopePolicy: ScopePolicy;
  private readonly scheduler: ScheduleService | undefined;
  private readonly channels: ChannelAdminService | undefined;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly listeners = new Set<(event: ServerCoreEvent) => void>();
  private readonly unsubscribes: Array<() => void>;

  constructor(private readonly service: JojoAppService, options: JojoServerCoreOptions) {
    this.info = {
      id: options.serverId ?? `srv_${crypto.randomUUID()}`,
      version: options.serverVersion ?? '0.1.0',
      protocolVersion: JOJO_SERVER_PROTOCOL_VERSION
    };
    this.capabilities = {
      runtime: {
        lanes: true, resumeOperation: true, transcriptQuery: true, runQuery: true,
        steer: false, followUp: false, durableSuspend: false
      },
      workflow: false,
      browser: false,
      memory: false,
      subagents: true,
      images: true,
      approvals: true,
      ...options.capabilities,
      scheduler: options.scheduler
        ? options.capabilities?.scheduler ?? { enabled: true, targets: ['agent'] }
        : { enabled: false, targets: [] },
      channels: options.channels
        ? options.capabilities?.channels ?? {
          enabled: true, kinds: [...(options.channelKinds ?? [])], inbound: true, outbound: true, approvals: true
        }
        : { enabled: false, kinds: [], inbound: false, outbound: false, approvals: false }
    };
    this.models = [...(options.models ?? [])];
    this.leases = new LeaseManager(options.idGenerator, options.now);
    this.scopePolicy = new ScopePolicy(options.workspaceRoots);
    this.idempotency = new IdempotencyStore(
      24 * 60 * 60 * 1000,
      options.now ? () => options.now!().getTime() : Date.now,
      options.idempotencyStore
    );
    this.scheduler = options.scheduler;
    this.channels = options.channels;
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date());
    this.unsubscribes = [
      service.subscribe((event) => this.emit(event)),
      ...(this.scheduler ? [this.scheduler.subscribe((event) => this.emit(event))] : [])
    ];
  }

  async serverSnapshot(ctx: RequestContext): Promise<ServerSnapshot> {
    return { server: this.info, capabilities: this.capabilities, sessions: await this.listSessions(ctx) };
  }

  listSessions(ctx: RequestContext): Promise<ServerSessionSummary[]> {
    authorize(ctx, 'sessions:read');
    return this.service.listSessions(ctx);
  }

  createSession(ctx: RequestContext, input: CreateSessionInput, key?: string): Promise<ServerSessionSnapshot> {
    authorize(ctx, 'sessions:write');
    return this.idempotency.execute(ctx.principal.id, 'session.create', key, input, async () => {
      const authorized = await this.scopePolicy.authorize(input);
      return this.withLease(ctx, await this.service.createSession(ctx, authorized));
    });
  }

  patchSession(
    ctx: RequestContext,
    sessionId: string,
    input: PatchSessionMetadataInput,
    key?: string
  ): Promise<ServerSessionSnapshot> {
    authorize(ctx, 'sessions:write');
    this.leases.requireControl(sessionId, ctx.connectionId);
    return this.idempotency.execute(ctx.principal.id, `session.patch:${sessionId}`, key, input, () => (
      this.service.patchSession(ctx, sessionId, input)
    ), { durable: false });
  }

  async getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot> {
    authorize(ctx, 'sessions:read');
    return this.withLease(ctx, await this.service.getSession(ctx, sessionId));
  }

  transcript(ctx: RequestContext, sessionId: string, query?: TranscriptQuery): Promise<TranscriptPage> {
    authorize(ctx, 'sessions:read');
    return this.service.getTranscript(ctx, sessionId, query);
  }

  async attach(ctx: RequestContext, sessionId: string, mode: LeaseMode): Promise<LeaseSnapshot> {
    authorize(ctx, mode === 'control' ? 'sessions:write' : 'sessions:read');
    if (!ctx.connectionId || !ctx.clientId) throw new Error('invalid_request: connection context is required');
    await this.service.getSession(ctx, sessionId);
    return this.leases.attach(sessionId, mode, ctx.clientId, ctx.connectionId);
  }

  async detach(ctx: RequestContext, sessionId: string): Promise<void> {
    authorize(ctx, 'sessions:read');
    if (ctx.connectionId) this.leases.detach(sessionId, ctx.connectionId);
  }

  async startRun(ctx: RequestContext, sessionId: string, input: StartRunInput, key?: string): Promise<RunSnapshot> {
    authorize(ctx, 'runs:start');
    this.leases.requireControl(sessionId, ctx.connectionId);
    return await this.idempotency.execute(ctx.principal.id, `run.start:${sessionId}`, key, input, () => (
      this.service.startRun(ctx, sessionId, input)
    ));
  }

  getRun(ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot> {
    authorize(ctx, 'sessions:read');
    return this.service.getRun(ctx, sessionId, runId);
  }

  async cancelRun(ctx: RequestContext, sessionId: string, runId: string, reason?: string): Promise<void> {
    authorize(ctx, 'runs:cancel');
    this.leases.requireControl(sessionId, ctx.connectionId);
    await this.service.cancelRun(ctx, sessionId, runId, reason);
  }

  async resolveApproval(
    ctx: RequestContext,
    approvalId: string,
    decision: 'allow' | 'deny',
    key?: string
  ): Promise<void> {
    authorize(ctx, 'approvals:resolve');
    const sessionId = await this.service.getApprovalSessionId(ctx, approvalId);
    this.leases.requireControl(sessionId, ctx.connectionId);
    await this.idempotency.execute(ctx.principal.id, `approval.resolve:${approvalId}`, key, { decision }, () => (
      this.service.resolveApproval(ctx, approvalId, decision)
    ));
  }

  listSchedules(ctx: RequestContext): Promise<Schedule[]> {
    authorize(ctx, 'schedules:read');
    return this.requireScheduler().list();
  }

  createSchedule(ctx: RequestContext, input: CreateScheduleInput, key?: string): Promise<Schedule> {
    authorize(ctx, 'schedules:write');
    return this.idempotency.execute(ctx.principal.id, 'schedule.create', key, input, () => (
      this.requireScheduler().create(compactSchedulerInput<SchedulerCreateScheduleInput>(input), {
        id: ctx.principal.id,
        type: ctx.principal.type === 'service' ? 'service' : 'user'
      })
    ));
  }

  getSchedule(ctx: RequestContext, scheduleId: string): Promise<Schedule> {
    authorize(ctx, 'schedules:read');
    return this.requireScheduler().get(scheduleId);
  }

  updateSchedule(
    ctx: RequestContext,
    scheduleId: string,
    input: UpdateScheduleInput,
    key?: string
  ): Promise<Schedule> {
    authorize(ctx, 'schedules:write');
    return this.idempotency.execute(ctx.principal.id, `schedule.update:${scheduleId}`, key, input, () => (
      this.requireScheduler().update(scheduleId, compactSchedulerInput<SchedulerUpdateScheduleInput>(input))
    ));
  }

  deleteSchedule(ctx: RequestContext, scheduleId: string, key?: string): Promise<void> {
    authorize(ctx, 'schedules:write');
    return this.idempotency.execute(ctx.principal.id, `schedule.delete:${scheduleId}`, key, { scheduleId }, () => (
      this.requireScheduler().delete(scheduleId)
    ));
  }

  runScheduleNow(
    ctx: RequestContext,
    scheduleId: string,
    input: RunScheduleNowInput = {},
    key?: string
  ): Promise<ScheduleRun> {
    authorize(ctx, 'schedules:run');
    return this.idempotency.execute(ctx.principal.id, `schedule.run:${scheduleId}`, key, input, () => (
      this.requireScheduler().runNow(
        scheduleId,
        compactSchedulerInput<{ respectConcurrency?: boolean }>(input)
      )
    ));
  }

  listScheduleRuns(
    ctx: RequestContext,
    scheduleId: string,
    query: ScheduleRunListQuery = { limit: 100 }
  ): Promise<ScheduleRun[]> {
    authorize(ctx, 'schedules:read');
    return this.requireScheduler().listRuns(
      scheduleId,
      compactSchedulerInput<SchedulerRunListOptions>(query)
    );
  }

  getScheduleRun(ctx: RequestContext, runId: string): Promise<ScheduleRun> {
    authorize(ctx, 'schedules:read');
    return this.requireScheduler().getRun(runId);
  }

  cancelScheduleRun(ctx: RequestContext, runId: string, key?: string): Promise<void> {
    authorize(ctx, 'schedules:cancel');
    return this.idempotency.execute(ctx.principal.id, `schedule.cancel:${runId}`, key, { runId }, () => (
      this.requireScheduler().cancelRun(runId)
    ));
  }

  async listChannelInstances(ctx: RequestContext): Promise<ChannelInstanceDto[]> {
    authorize(ctx, 'channels:read');
    return (await this.requireChannels().listInstances()).map(channelInstanceDto);
  }

  async getChannelInstance(ctx: RequestContext, instanceId: string): Promise<ChannelInstanceDto> {
    authorize(ctx, 'channels:read');
    return channelInstanceDto(await this.requireChannels().getInstance(instanceId));
  }

  createChannelInstance(ctx: RequestContext, input: CreateChannelInstanceInput, key?: string): Promise<ChannelInstanceDto> {
    authorize(ctx, 'channels:write');
    return this.idempotency.execute(ctx.principal.id, 'channel.instance.create', key, input, async () => {
      if (!this.capabilities.channels.kinds.includes(input.kind)) {
        throw new ProtocolFailure({ code: 'invalid_request', message: `Unsupported channel kind: ${input.kind}` });
      }
      const timestamp = this.now().toISOString();
      const instance: ChannelInstance = {
        id: input.id ?? `channel_${this.idGenerator()}`,
        kind: input.kind,
        name: input.name,
        enabled: input.enabled,
        config: compactChannel(input.config),
        secretRefs: { ...input.secretRefs },
        revision: 1,
        fingerprint: channelFingerprint(input.kind, input.config, input.secretRefs),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      return channelInstanceDto(await this.requireChannels().saveInstance(instance));
    });
  }

  updateChannelInstance(
    ctx: RequestContext,
    instanceId: string,
    input: UpdateChannelInstanceInput,
    key?: string
  ): Promise<ChannelInstanceDto> {
    authorize(ctx, 'channels:write');
    return this.idempotency.execute(ctx.principal.id, `channel.instance.update:${instanceId}`, key, input, async () => {
      const current = await this.requireChannels().getInstance(instanceId);
      const expected = input.expectedRevision ?? current.revision;
      const config = input.config === undefined ? current.config : compactChannel<Record<string, unknown>>(input.config);
      const secretRefs = input.secretRefs === undefined ? current.secretRefs : { ...input.secretRefs };
      return channelInstanceDto(await this.requireChannels().saveInstance({
        ...current,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        config,
        secretRefs,
        fingerprint: channelFingerprint(current.kind, config, secretRefs),
        revision: current.revision + 1,
        updatedAt: this.now().toISOString()
      }, expected));
    });
  }

  deleteChannelInstance(ctx: RequestContext, instanceId: string, expectedRevision?: number, key?: string): Promise<void> {
    authorize(ctx, 'channels:write');
    return this.idempotency.execute(ctx.principal.id, `channel.instance.delete:${instanceId}`, key, {
      instanceId, expectedRevision
    }, () => this.requireChannels().deleteInstance(instanceId, expectedRevision));
  }

  testChannel(ctx: RequestContext, instanceId: string, input: TestChannelInput, key?: string): Promise<ChannelDeliveryReceipt> {
    authorize(ctx, 'channels:send');
    return this.idempotency.execute(ctx.principal.id, `channel.instance.test:${instanceId}`, key, input, async () => {
      await this.requireChannels().getInstance(instanceId);
      if (input.bindingId) {
        const binding = await this.requireChannels().getBinding(input.bindingId);
        if (binding.instanceId !== instanceId) throw new ProtocolFailure({ code: 'invalid_request', message: 'Binding belongs to another channel instance.' });
      }
      return this.requireChannels().deliver({
        ...(input.bindingId ? { bindingId: input.bindingId } : {
          target: {
            instanceId,
            conversationId: input.conversationId!,
            ...(input.threadId ? { threadId: input.threadId } : {})
          }
        }),
        content: [{ type: 'text', text: input.text }], mode: 'system', idempotencyKey: key ?? `test:${this.idGenerator()}`
      });
    });
  }

  async listChannelBindings(ctx: RequestContext): Promise<ChannelBindingDto[]> {
    authorize(ctx, 'channels:read');
    return (await this.requireChannels().listBindings()).map(channelBindingDto);
  }

  createChannelBinding(ctx: RequestContext, input: CreateChannelBindingInput, key?: string): Promise<ChannelBindingDto> {
    authorize(ctx, 'channels:bind');
    return this.idempotency.execute(ctx.principal.id, 'channel.binding.create', key, input, async () => (
      channelBindingDto(await this.requireChannels().saveBinding(await this.newBinding(input)))
    ));
  }

  updateChannelBinding(
    ctx: RequestContext,
    bindingId: string,
    input: UpdateChannelBindingInput,
    key?: string
  ): Promise<ChannelBindingDto> {
    authorize(ctx, 'channels:bind');
    return this.idempotency.execute(ctx.principal.id, `channel.binding.update:${bindingId}`, key, input, async () => {
      const current = await this.requireChannels().getBinding(bindingId);
      const expected = input.expectedRevision ?? current.revision;
      const routing = input.routing ? await this.authorizeChannelRouting(input.routing) : current.routing;
      return channelBindingDto(await this.requireChannels().saveBinding({
        ...current,
        routing,
        ...(input.policy ? { policy: compactChannel<ChannelBinding['policy']>(input.policy) } : {}),
        revision: current.revision + 1,
        updatedAt: this.now().toISOString()
      }, expected));
    });
  }

  deleteChannelBinding(ctx: RequestContext, bindingId: string, expectedRevision?: number, key?: string): Promise<void> {
    authorize(ctx, 'channels:bind');
    return this.idempotency.execute(ctx.principal.id, `channel.binding.delete:${bindingId}`, key, {
      bindingId, expectedRevision
    }, () => this.requireChannels().deleteBinding(bindingId, expectedRevision));
  }

  async listChannelPairings(ctx: RequestContext, status?: ChannelPairing['status']): Promise<ChannelPairingDto[]> {
    authorize(ctx, 'channels:approve');
    return (await this.requireChannels().listPairings(status)).map(channelPairingDto);
  }

  approveChannelPairing(
    ctx: RequestContext,
    pairingId: string,
    input: ApproveChannelPairingInput,
    key?: string
  ): Promise<ChannelBindingDto> {
    authorize(ctx, 'channels:approve');
    return this.idempotency.execute(ctx.principal.id, `channel.pairing.approve:${pairingId}`, key, input, async () => (
      channelBindingDto(await this.requireChannels().approvePairing(pairingId, await this.newBinding(input.binding)))
    ));
  }

  rejectChannelPairing(ctx: RequestContext, pairingId: string, key?: string): Promise<void> {
    authorize(ctx, 'channels:approve');
    return this.idempotency.execute(ctx.principal.id, `channel.pairing.reject:${pairingId}`, key, { pairingId }, () => (
      this.requireChannels().rejectPairing(pairingId)
    ));
  }

  async listChannelDeliveries(ctx: RequestContext, query: ChannelDeliveryListQuery = { limit: 100 }): Promise<ChannelDeliveryDto[]> {
    authorize(ctx, 'channels:read');
    return (await this.requireChannels().listDeliveries({
      limit: query.limit,
      ...(query.instanceId ? { instanceId: query.instanceId } : {}),
      ...(query.status ? { status: query.status } : {})
    })).map(channelDeliveryDto);
  }

  async getChannelDelivery(ctx: RequestContext, deliveryId: string): Promise<ChannelDeliveryDto> {
    authorize(ctx, 'channels:read');
    return channelDeliveryDto(await this.requireChannels().getDelivery(deliveryId));
  }

  async listChannelHealth(ctx: RequestContext): Promise<ChannelHealthDto[]> {
    authorize(ctx, 'channels:read');
    return (await this.requireChannels().listHealth()).map(({ instanceId, health }) => ({ instanceId, ...health }));
  }

  async dispatch(ctx: RequestContext, command: ClientCommand): Promise<unknown> {
    switch (command.type) {
      case 'server.snapshot': return this.serverSnapshot(ctx);
      case 'session.list': return this.listSessions(ctx);
      case 'session.create': return this.createSession(ctx, command.input, command.id);
      case 'session.patch': return this.patchSession(ctx, command.sessionId, command.input, command.id);
      case 'session.attach': return this.attach(ctx, command.input.sessionId, command.input.mode);
      case 'session.detach': return this.detach(ctx, command.sessionId);
      case 'session.snapshot': return this.getSession(ctx, command.sessionId);
      case 'run.start': return this.startRun(ctx, command.sessionId, command.input, command.id);
      case 'run.cancel': return this.cancelRun(ctx, command.sessionId, command.runId, command.reason);
      case 'run.get': return this.getRun(ctx, command.sessionId, command.runId);
      case 'approval.resolve': return this.resolveApproval(ctx, command.approvalId, command.input.decision, command.id);
    }
  }

  closeConnection(connectionId: string): void {
    this.leases.releaseConnection(connectionId);
  }

  subscribe(listener: (event: ServerCoreEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
    await this.scheduler?.close();
    await this.service.close();
  }

  private withLease(ctx: RequestContext, snapshot: ServerSessionSnapshot): ServerSessionSnapshot {
    return { ...snapshot, lease: this.leases.get(snapshot.id, ctx.connectionId) };
  }

  private requireScheduler(): ScheduleService {
    if (!this.scheduler) throw new ProtocolFailure({ code: 'scheduler_unavailable', message: 'Scheduler is not enabled.' });
    return this.scheduler;
  }

  private requireChannels(): ChannelAdminService {
    if (!this.channels) throw new ProtocolFailure({ code: 'channels_unavailable', message: 'Channels are not enabled.' });
    return this.channels;
  }

  private async newBinding(input: CreateChannelBindingInput): Promise<ChannelBinding> {
    const timestamp = this.now().toISOString();
    return {
      id: input.id ?? `binding_${this.idGenerator()}`,
      instanceId: input.instanceId,
      conversation: compactChannel(input.conversation),
      routing: await this.authorizeChannelRouting(input.routing),
      policy: compactChannel(input.policy),
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  private async authorizeChannelRouting(routing: CreateChannelBindingInput['routing']): Promise<ChannelBinding['routing']> {
    const compact = compactChannel<ChannelBinding['routing']>(routing);
    if (!compact.workspaceRoot) return compact;
    return { ...compact, workspaceRoot: await this.scopePolicy.authorizeWorkspaceRoot(compact.workspaceRoot) };
  }

  private emit(event: ServerCoreEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers are isolated. */ }
    }
  }
}

export function createJojoServerCore(service: JojoAppService, options: JojoServerCoreOptions = {}): JojoServerCore {
  return new DefaultJojoServerCore(service, options);
}

function authorize(ctx: RequestContext, scope: string): void {
  if (ctx.principal.scopes.includes('admin') || ctx.principal.scopes.includes(scope)) return;
  throw new ProtocolFailure({ code: 'forbidden', message: `The principal lacks the ${scope} scope.` });
}

function compactSchedulerInput<T>(input: unknown): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function compactChannel<T>(input: unknown): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

function channelInstanceDto(instance: ChannelInstance): ChannelInstanceDto {
  return compactChannel(instance);
}

function channelBindingDto(binding: ChannelBinding): ChannelBindingDto {
  return compactChannel(binding);
}

function channelPairingDto(pairing: ChannelPairing): ChannelPairingDto {
  return {
    id: pairing.id,
    instanceId: pairing.instanceId,
    conversationId: pairing.conversationId,
    senderId: pairing.senderId,
    status: pairing.status,
    expiresAt: pairing.expiresAt,
    createdAt: pairing.createdAt,
    ...(pairing.resolvedAt ? { resolvedAt: pairing.resolvedAt } : {})
  };
}

function channelDeliveryDto(delivery: ChannelOutboxItem): ChannelDeliveryDto {
  return {
    id: delivery.id,
    instanceId: delivery.instanceId,
    ...(delivery.bindingId ? { bindingId: delivery.bindingId } : {}),
    conversationId: delivery.conversationId,
    ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
    ...(delivery.request.mode ? { mode: delivery.request.mode } : {}),
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    createdAt: delivery.createdAt,
    ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
    ...(delivery.nativeMessageId ? { nativeMessageId: delivery.nativeMessageId } : {}),
    ...(delivery.lastError ? { lastError: delivery.lastError } : {})
  };
}

function channelFingerprint(kind: string, config: unknown, secretRefs: Record<string, string>): string {
  return createHash('sha256').update(stableChannelJson({ kind, config, secretRefs })).digest('hex');
}

function stableChannelJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableChannelJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableChannelJson(record[key])}`).join(',')}}`;
}

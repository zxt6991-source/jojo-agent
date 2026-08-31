import { createHash } from 'node:crypto';
import type { AgentRuntime, RunHandle, RunRequest, RuntimeActor, RuntimeTriggerContext } from '@desktop-agent/agent-runtime';
import type { RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';
import type {
  ApprovalDecision,
  CreateSessionInput,
  PatchSessionMetadataInput,
  PendingApprovalSnapshot,
  ProtocolError,
  RequestContext,
  RunSnapshot,
  ServerSessionSnapshot,
  ServerSessionSummary,
  StartRunInput,
  TranscriptPage,
  TranscriptQuery
} from '@desktop-agent/server-protocol';
import { ServerApprovalBroker, type ApprovalEvent } from './approval-service.js';
import { MemoryServerStateStore, type PersistedRunRecord, type ServerStateStore } from './persistence.js';
import { LiveRunRegistry } from './run-registry.js';

export type AppServiceEvent =
  | { type: 'runtime.event'; envelope: RuntimeEventEnvelope }
  | { type: 'run.updated'; run: RunSnapshot }
  | { type: 'session.metadata.updated'; sessionId: string; revision: number }
  | ApprovalEvent;

export type JojoAppServiceOptions = {
  approvalBroker?: ServerApprovalBroker;
  stateStore?: ServerStateStore;
  idGenerator?: () => string;
  now?: () => Date;
};

export type StartRunOptions = {
  runId?: string;
  actor?: RuntimeActor;
  trigger?: RuntimeTriggerContext;
  metadata?: {
    scheduleId?: string;
    scheduleRunId?: string;
    channel?: {
      bindingId: string;
      instanceId: string;
      conversationId: string;
      threadId?: string;
      senderId: string;
      inboundMessageId: string;
    };
  };
};

export interface JojoAppService {
  listSessions(ctx: RequestContext): Promise<ServerSessionSummary[]>;
  createSession(ctx: RequestContext, input: CreateSessionInput): Promise<ServerSessionSnapshot>;
  patchSession(
    ctx: RequestContext,
    sessionId: string,
    input: PatchSessionMetadataInput
  ): Promise<ServerSessionSnapshot>;
  getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot>;
  getTranscript(ctx: RequestContext, sessionId: string, input?: TranscriptQuery): Promise<TranscriptPage>;
  startRun(ctx: RequestContext, sessionId: string, input: StartRunInput, options?: StartRunOptions): Promise<RunSnapshot>;
  getRun(ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot>;
  cancelRun(ctx: RequestContext, sessionId: string, runId: string, reason?: string): Promise<void>;
  listApprovals(ctx: RequestContext, sessionId: string): Promise<PendingApprovalSnapshot[]>;
  getApprovalSessionId(ctx: RequestContext, approvalId: string): Promise<string>;
  resolveApproval(ctx: RequestContext, approvalId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(listener: (event: AppServiceEvent) => void): () => void;
  close(): Promise<void>;
}

class DefaultJojoAppService implements JojoAppService {
  private readonly listeners = new Set<(event: AppServiceEvent) => void>();
  private readonly liveRuns = new LiveRunRegistry();
  private readonly observations = new Set<Promise<void>>();
  private readonly approvalBroker: ServerApprovalBroker;
  private readonly stateStore: ServerStateStore;
  private readonly idGenerator: () => string;
  private readonly unsubscribeRuntime: () => void;
  private readonly unsubscribeApproval: () => void;
  private closed = false;

  constructor(private readonly runtime: AgentRuntime, options: JojoAppServiceOptions) {
    this.stateStore = options.stateStore ?? new MemoryServerStateStore(options.now);
    this.approvalBroker = options.approvalBroker ?? new ServerApprovalBroker({
      store: this.stateStore.approvals,
      ...(options.now ? { now: options.now } : {})
    });
    if (options.approvalBroker) this.approvalBroker.bindStore(this.stateStore.approvals);
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.unsubscribeRuntime = runtime.subscribe((envelope) => {
      this.emit({ type: 'runtime.event', envelope });
    });
    this.unsubscribeApproval = this.approvalBroker.subscribe((event) => this.emit(event));
  }

  async listSessions(_ctx: RequestContext): Promise<ServerSessionSummary[]> {
    return Promise.all((await this.runtime.listSessions()).map(async (session) => {
      const metadata = await this.stateStore.sessions.ensureActive({ sessionId: session.id });
      return {
        id: session.id,
        ...(metadata.title !== undefined ? { title: metadata.title } : {}),
        labels: [...metadata.labels],
        favorite: metadata.favorite,
        ...(metadata.defaultProviderId !== undefined ? { defaultProviderId: metadata.defaultProviderId } : {}),
        ...(metadata.defaultModel !== undefined ? { defaultModel: metadata.defaultModel } : {}),
        createdAt: session.createdAt,
        executionScope: session.executionScope,
        revision: metadata.revision
      };
    }));
  }

  async createSession(ctx: RequestContext, input: CreateSessionInput): Promise<ServerSessionSnapshot> {
    const sessionId = input.id ?? this.idGenerator();
    await this.stateStore.sessions.createCreating({
      sessionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      createdBy: ctx.principal.id
    });
    try {
      await this.runtime.openSession({ id: sessionId, executionScope: input.executionScope });
      await this.stateStore.sessions.activate(sessionId);
    } catch (error) {
      if (!await this.runtime.getSession(sessionId)) await this.stateStore.sessions.deleteCreating(sessionId);
      throw error;
    }
    return this.getSession(ctx, sessionId);
  }

  async patchSession(
    ctx: RequestContext,
    sessionId: string,
    input: PatchSessionMetadataInput
  ): Promise<ServerSessionSnapshot> {
    if (!await this.runtime.getSession(sessionId)) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const metadata = await this.stateStore.sessions.patch(sessionId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
      ...(input.defaultProviderId !== undefined ? { defaultProviderId: input.defaultProviderId } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
    });
    this.emit({ type: 'session.metadata.updated', sessionId, revision: metadata.revision });
    return this.getSession(ctx, sessionId);
  }

  async getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const runtime = await session.getSnapshot();
    const metadata = await this.stateStore.sessions.ensureActive({ sessionId });
    const transcript = await this.getTranscript(ctx, sessionId, { laneId: 'main', limit: 100 });
    const runs = await this.stateStore.runs.list(sessionId, { activeOnly: true });
    return {
      id: sessionId,
      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
      labels: [...metadata.labels],
      favorite: metadata.favorite,
      ...(metadata.defaultProviderId !== undefined ? { defaultProviderId: metadata.defaultProviderId } : {}),
      ...(metadata.defaultModel !== undefined ? { defaultModel: metadata.defaultModel } : {}),
      executionScope: runtime.session.executionScope,
      revision: metadata.revision,
      runtime,
      activeRuns: runs.map(toRunSnapshot),
      transcript: transcript.items,
      pendingApprovals: this.approvalBroker.list(sessionId),
      lease: null
    };
  }

  async getTranscript(
    _ctx: RequestContext,
    sessionId: string,
    input: TranscriptQuery = { laneId: 'main', limit: 100 }
  ): Promise<TranscriptPage> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const lane = await session.getLane(input.laneId);
    const page = await lane.readTranscript({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit: input.limit
    });
    const offset = input.cursor ? Number(input.cursor) : 0;
    return {
      items: page.items.map((message, index) => ({
        id: message.id,
        laneId: input.laneId,
        sequence: offset + index + 1,
        message
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
    };
  }

  async startRun(_ctx: RequestContext, sessionId: string, input: StartRunInput, options: StartRunOptions = {}): Promise<RunSnapshot> {
    const runId = options.runId ?? this.idGenerator();
    const trigger = options.trigger ?? { kind: 'api' as const };
    const originKind = trigger.kind === 'scheduler'
      ? 'scheduler' as const
      : trigger.kind === 'user'
        ? 'user' as const
        : trigger.kind === 'channel_message' ? 'channel' as const : 'api' as const;
    const requestMeta = {
      ...(input.budget ? { budget: compactBudget(input.budget) } : {}),
      origin: {
        kind: originKind,
        ...(options.metadata?.scheduleId ? { scheduleId: options.metadata.scheduleId } : {}),
        ...(options.metadata?.scheduleRunId ? { scheduleRunId: options.metadata.scheduleRunId } : {}),
        ...(options.metadata?.channel ? { channel: options.metadata.channel } : {})
      }
    };
    const accepted = await this.stateStore.runs.createAccepted({
      id: runId,
      sessionId,
      laneId: input.laneId,
      providerId: input.providerId,
      model: input.model,
      inputHash: createHash('sha256').update(stableJson(input.input)).digest('hex'),
      requestMeta
    });
    this.emit({ type: 'run.updated', run: toRunSnapshot(accepted) });
    const starting = await this.stateStore.runs.markStarting(runId, accepted.version);
    this.emit({ type: 'run.updated', run: toRunSnapshot(starting) });
    let handle: RunHandle | undefined;
    try {
      const session = await this.runtime.getSession(sessionId);
      if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
      const lane = await session.getLane(input.laneId);
      const budget = input.budget ? {
        ...(input.budget.maxIterations !== undefined ? { maxIterations: input.budget.maxIterations } : {}),
        ...(input.budget.allowPartialOnLimit !== undefined ? { allowPartialOnLimit: input.budget.allowPartialOnLimit } : {}),
        ...(input.budget.contextWindowTokens !== undefined ? { contextWindowTokens: input.budget.contextWindowTokens } : {}),
        ...(input.budget.maxOutputTokens !== undefined ? { maxOutputTokens: input.budget.maxOutputTokens } : {})
      } : undefined;
      const request: RunRequest = {
        runId,
        input: input.input,
        providerId: input.providerId,
        model: input.model,
        actor: options.actor ?? { kind: 'main' },
        trigger,
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(budget ? { budget } : {})
      };
      handle = await lane.run(request);
      this.liveRuns.attach(runId, handle);
      const running = await this.stateStore.runs.markRunning(runId, starting.version);
      this.emit({ type: 'run.updated', run: toRunSnapshot(running) });
      this.observe(handle);
      return toRunSnapshot(running);
    } catch (error) {
      await handle?.cancel('server_run_start_failed');
      const failed = await this.stateStore.runs.markFailed(runId, protocolError(error));
      this.emit({ type: 'run.updated', run: toRunSnapshot(failed) });
      throw error;
    }
  }

  async getRun(_ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot> {
    const run = await this.stateStore.runs.get(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    return toRunSnapshot(run);
  }

  async cancelRun(
    _ctx: RequestContext,
    sessionId: string,
    runId: string,
    reason?: string
  ): Promise<void> {
    const run = await this.stateStore.runs.get(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    const handle = this.liveRuns.getHandle(runId);
    if (handle) {
      await handle.cancel(reason);
      return;
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return;
    throw new Error(`runtime_interrupted: live handle is unavailable for ${runId}`);
  }

  async listApprovals(_ctx: RequestContext, sessionId: string): Promise<PendingApprovalSnapshot[]> {
    return this.approvalBroker.list(sessionId);
  }

  async getApprovalSessionId(_ctx: RequestContext, approvalId: string): Promise<string> {
    const approval = await this.stateStore.approvals.get(approvalId);
    if (!approval) throw new Error(`approval_not_found: ${approvalId}`);
    return approval.sessionId;
  }

  async resolveApproval(ctx: RequestContext, approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.approvalBroker.resolve(approvalId, decision, ctx.principal.id);
  }

  subscribe(listener: (event: AppServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.liveRuns.list()) await handle.cancel('server_shutdown');
    await Promise.allSettled([...this.observations]);
    for (const run of await this.stateStore.runs.listRecoverable()) {
      const interrupted = await this.stateStore.runs.markInterrupted(run.id, {
        code: 'server_shutdown',
        message: 'Server shut down before the run reached a proven terminal state.',
        retryable: true
      });
      this.emit({ type: 'run.updated', run: toRunSnapshot(interrupted) });
    }
    await this.approvalBroker.interruptAll('server_shutdown');
    this.unsubscribeRuntime();
    this.unsubscribeApproval();
    this.liveRuns.clear();
    this.listeners.clear();
    await this.runtime.close();
    await this.stateStore.close();
  }

  private observe(handle: RunHandle): void {
    const observation = handle.result.then(async (result) => {
      const record = result.status === 'completed'
        ? await this.stateStore.runs.markCompleted(handle.id, result)
        : result.status === 'cancelled'
          ? await this.stateStore.runs.markCancelled(handle.id, result)
          : await this.stateStore.runs.markFailed(handle.id, protocolError(result.error), result);
      this.emit({ type: 'run.updated', run: toRunSnapshot(record) });
    }).finally(() => {
      this.liveRuns.detach(handle.id);
      this.observations.delete(observation);
    });
    this.observations.add(observation);
    void observation.catch(() => undefined);
  }

  private emit(event: AppServiceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* App-service observers are isolated. */ }
    }
  }
}

export function createJojoAppService(
  runtime: AgentRuntime,
  options: JojoAppServiceOptions = {}
): JojoAppService {
  return new DefaultJojoAppService(runtime, options);
}

function toRunSnapshot(record: PersistedRunRecord): RunSnapshot {
  return {
    id: record.id,
    sessionId: record.sessionId,
    laneId: record.laneId,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {})
  };
}

function protocolError(error: unknown): ProtocolError {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown; detail?: unknown; details?: unknown };
    const message = typeof value.message === 'string' ? value.message : String(error);
    const code = typeof value.code === 'string'
      ? value.code
      : /^(runtime_[a-z_]+)(?::|$)/u.exec(message)?.[1] ?? 'runtime_internal';
    return {
      code,
      message,
      ...(value.details !== undefined ? { details: value.details as never }
        : value.detail !== undefined ? { details: value.detail as never } : {})
    };
  }
  return { code: 'runtime_internal', message: String(error) };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
}

function compactBudget(budget: NonNullable<StartRunInput['budget']>): NonNullable<
  NonNullable<PersistedRunRecord['requestMeta']>['budget']
> {
  return {
    ...(budget.maxIterations !== undefined ? { maxIterations: budget.maxIterations } : {}),
    ...(budget.contextWindowTokens !== undefined ? { contextWindowTokens: budget.contextWindowTokens } : {}),
    ...(budget.maxOutputTokens !== undefined ? { maxOutputTokens: budget.maxOutputTokens } : {}),
    ...(budget.allowPartialOnLimit !== undefined ? { allowPartialOnLimit: budget.allowPartialOnLimit } : {})
  };
}

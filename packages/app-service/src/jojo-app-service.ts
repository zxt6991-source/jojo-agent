import { SessionSearchQuerySchema, SessionReadWindowQuerySchema, type SessionSearchQuery, type SessionSearchHit, type SessionReadWindowQuery, type SessionReadWindow } from '@desktop-agent/contracts';
import { createHash } from 'node:crypto';
import type { AgentRuntime, OpenSessionRequest, RunHandle, RunRequest, RuntimeActor, RuntimeTriggerContext, RuntimeRunSnapshot } from '@desktop-agent/agent-runtime';
import type { RunResult, SessionSnapshot, RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';
import type {
  ApprovalDecision,
  CreateSessionInput,
  PatchSessionMetadataInput,
  PendingApprovalSnapshot,
  ApplicationError,
  ApplicationContext,
  RunSnapshot,
  ApplicationSessionSnapshot,
  ApplicationSessionSummary,
  StartRunInput,
  TranscriptPage,
  TranscriptQuery
} from '@desktop-agent/contracts/application';
import { ServerApprovalBroker, type ApprovalEvent, type ApplicationApprovalBroker } from './approval-service.js';
import { MemoryServerStateStore, type PersistedRunRecord, type ServerStateStore } from './persistence.js';
import { LiveRunRegistry } from './run-registry.js';

export type AppServiceEvent =
  | { type: 'runtime.event'; envelope: RuntimeEventEnvelope }
  | { type: 'run.updated'; run: RunSnapshot }
  | { type: 'session.metadata.updated'; sessionId: string; revision: number }
  | ApprovalEvent;

export type JojoAppServiceOptions = {
  /** Explicit per-session policy for non-local identities. No scope=all bypass. */
  canReadSessionHistory?: (ctx: ApplicationContext, sessionId: string) => boolean | Promise<boolean>;
  approvalBroker?: ApplicationApprovalBroker;
  stateStore?: ServerStateStore;
  idGenerator?: () => string;
  now?: () => Date;
};

export type StartRunOptions = {
  /** Host cancellation; never serialized into transport input or durable metadata. */
  signal?: AbortSignal;
  runId?: string;
  actor?: RuntimeActor;
  trigger?: RuntimeTriggerContext;
  workflow?: RunRequest['workflow'];
  team?: RunRequest['team'];
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
  searchSessionHistory?(ctx: ApplicationContext, projectSessionId: string, query: SessionSearchQuery): Promise<SessionSearchHit[]>;
  readSessionHistoryWindow?(ctx: ApplicationContext, query: SessionReadWindowQuery): Promise<SessionReadWindow>;
  /** Prepare an existing host-owned session without recreating its metadata. */
  openSession(ctx: ApplicationContext, input: OpenSessionRequest): Promise<SessionSnapshot>;
  executeRun(ctx: ApplicationContext, sessionId: string, input: StartRunInput, options?: StartRunOptions): Promise<RunResult>;
  startRunHandle(ctx: ApplicationContext, sessionId: string, input: StartRunInput, options?: StartRunOptions): Promise<RunHandle>;
  resumeRun(ctx: ApplicationContext, sessionId: string, runId: string, options?: { signal?: AbortSignal }): Promise<RunResult>;
  listSessions(ctx: ApplicationContext): Promise<ApplicationSessionSummary[]>;
  createSession(ctx: ApplicationContext, input: CreateSessionInput): Promise<ApplicationSessionSnapshot>;
  patchSession(
    ctx: ApplicationContext,
    sessionId: string,
    input: PatchSessionMetadataInput
  ): Promise<ApplicationSessionSnapshot>;
  getSession(ctx: ApplicationContext, sessionId: string): Promise<ApplicationSessionSnapshot>;
  getTranscript(ctx: ApplicationContext, sessionId: string, input?: TranscriptQuery): Promise<TranscriptPage>;
  startRun(ctx: ApplicationContext, sessionId: string, input: StartRunInput, options?: StartRunOptions): Promise<RunSnapshot>;
  getRun(ctx: ApplicationContext, sessionId: string, runId: string): Promise<RunSnapshot>;
  cancelRun(ctx: ApplicationContext, sessionId: string, runId: string, reason?: string): Promise<void>;
  listApprovals(ctx: ApplicationContext, sessionId: string): Promise<PendingApprovalSnapshot[]>;
  getApprovalSessionId(ctx: ApplicationContext, approvalId: string): Promise<string>;
  resolveApproval(ctx: ApplicationContext, approvalId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(listener: (event: AppServiceEvent) => void): () => void;
  close(): Promise<void>;
}

class DefaultJojoAppService implements JojoAppService {
  private readonly listeners = new Set<(event: AppServiceEvent) => void>();
  private readonly liveRuns = new LiveRunRegistry();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly resumptions = new Map<string, Promise<RunResult>>();
  private readonly approvalBroker: ApplicationApprovalBroker;
  private readonly stateStore: ServerStateStore;
  private readonly idGenerator: () => string;
  private readonly unsubscribeRuntime: () => void;
  private readonly unsubscribeApproval: () => void;
  private closed = false;

  constructor(private readonly runtime: AgentRuntime, private readonly options: JojoAppServiceOptions) {
    this.stateStore = options.stateStore ?? new MemoryServerStateStore(options.now);
    this.approvalBroker = options.approvalBroker ?? new ServerApprovalBroker({
      store: this.stateStore.approvals,
      ...(options.now ? { now: options.now } : {})
    });
    if (options.approvalBroker) this.approvalBroker.bindStore?.(this.stateStore.approvals);
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.unsubscribeRuntime = runtime.subscribe((envelope) => {
      this.emit({ type: 'runtime.event', envelope });
    });
    this.unsubscribeApproval = this.approvalBroker.subscribe((event) => this.emit(event));
  }

  private async canReadHistory(ctx: ApplicationContext, sessionId: string): Promise<boolean> {
    return this.options.canReadSessionHistory ? this.options.canReadSessionHistory(ctx, sessionId) : ctx.principal.type === 'local';
  }
  async searchSessionHistory(ctx: ApplicationContext, projectSessionId: string, input: SessionSearchQuery): Promise<SessionSearchHit[]> {
    const query = SessionSearchQuerySchema.parse(input);
    if (!await this.canReadHistory(ctx, projectSessionId)) throw new Error('forbidden: Session history is not accessible to this identity.');
    const sessions = await this.runtime.listSessions();
    const current = sessions.find(session => session.id === projectSessionId);
    if (!current) throw new Error('runtime_session_not_found');
    const project = current.executionScope.kind === 'workspace' ? current.executionScope.workingDirectory : undefined;
    const candidates = sessions.filter(session => session.id === projectSessionId || (project && session.executionScope.kind === 'workspace' && session.executionScope.workingDirectory === project));
    const allowed: string[] = [];
    for (const session of candidates) if (await this.canReadHistory(ctx, session.id)) allowed.push(session.id);
    return this.runtime.searchSessionMessages?.(query, allowed) ?? [];
  }
  async readSessionHistoryWindow(ctx: ApplicationContext, input: SessionReadWindowQuery): Promise<SessionReadWindow> {
    const query = SessionReadWindowQuerySchema.parse(input);
    if (!await this.canReadHistory(ctx, query.sessionId)) throw new Error('forbidden: Session history is not accessible to this identity.');
    if (!await this.runtime.getSession(query.sessionId)) throw new Error('runtime_session_not_found');
    return this.runtime.readSessionMessageWindow?.(query) ?? { items: [], truncated: false };
  }

  async listSessions(_ctx: ApplicationContext): Promise<ApplicationSessionSummary[]> {
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

  async openSession(_ctx: ApplicationContext, input: OpenSessionRequest): Promise<SessionSnapshot> {
    const session = await this.runtime.openSession(input);
    await this.stateStore.sessions.ensureActive({ sessionId: session.id });
    return session.getSnapshot();
  }

  async executeRun(ctx: ApplicationContext, sessionId: string, input: StartRunInput, options: StartRunOptions = {}): Promise<RunResult> {
    const run = await this.startRun(ctx, sessionId, input, options);
    return this.waitForResult(run.id);
  }

  async startRunHandle(ctx: ApplicationContext, sessionId: string, input: StartRunInput, options: StartRunOptions = {}): Promise<RunHandle> {
    if (!await this.runtime.getSession(sessionId)) throw new Error(`runtime_session_not_found: ${sessionId}`);
    await this.stateStore.sessions.ensureActive({ sessionId });
    const run = await this.startRun(ctx, sessionId, input, options);
    const result = this.waitForResult(run.id);
    // The caller attaches its observer after dispatch returns.
    void result.catch(() => undefined);
    return { id: run.id, result, cancel: reason => this.cancelRun(ctx, sessionId, run.id, reason) };
  }

  async resumeRun(_ctx: ApplicationContext, sessionId: string, runId: string, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    // Validate ownership before joining an in-flight recovery or returning its result.
    const snapshot = await this.runtime.inspectRun(runId);
    if (!snapshot || snapshot.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    const pending = this.resumptions.get(runId);
    if (pending) return pending;
    if (this.liveRuns.getHandle(runId)) return this.waitForResult(runId);
    const resumption = this.resumeCapturedRun(snapshot, options).finally(() => this.resumptions.delete(runId));
    this.resumptions.set(runId, resumption);
    return resumption;
  }

  private async resumeCapturedRun(snapshot: RuntimeRunSnapshot, options: { signal?: AbortSignal }): Promise<RunResult> {
    let record = await this.stateStore.runs.get(snapshot.id);
    if (record && (record.sessionId !== snapshot.sessionId || record.laneId !== snapshot.laneId)) {
      throw new Error('runtime_run_identity_conflict');
    }
    if (record?.result) return record.result;
    if (record && !['accepted', 'starting', 'running'].includes(record.status)) throw new Error('runtime_run_state_conflict');
    if (!record) {
      if (!snapshot.execution) throw new Error('runtime_resume_context_missing');
      await this.stateStore.sessions.ensureActive({ sessionId: snapshot.sessionId });
      record = await this.stateStore.runs.createAccepted({
        id: snapshot.id, sessionId: snapshot.sessionId, laneId: snapshot.laneId,
        providerId: snapshot.execution.providerBinding.providerId,
        model: snapshot.execution.providerBinding.model,
        // The original request is owned by Runtime; this sentinel is not a request replay hash.
        inputHash: `recovered:${snapshot.id}`
      });
    }
    if (record.status === 'accepted') record = await this.stateStore.runs.markStarting(record.id, record.version);
    if (snapshot.result) {
      await this.recordResult(snapshot.result);
      return snapshot.result;
    }
    // A preparation failure leaves the captured operation retryable, not terminally failed.
    const handle = await this.runtime.resumeOperation({ operationId: snapshot.id, ...options });
    this.liveRuns.attach(snapshot.id, handle);
    try {
      if (record.status === 'starting') record = await this.stateStore.runs.markRunning(record.id, record.version);
      this.emit({ type: 'run.updated', run: toRunSnapshot(record) });
      this.observe(handle);
    } catch (error) {
      await handle.cancel('application_resume_tracking_failed');
      this.liveRuns.detach(handle.id);
      throw error;
    }
    return this.waitForResult(snapshot.id);
  }

  private async waitForResult(runId: string): Promise<RunResult> {
    await this.observations.get(runId);
    const record = await this.stateStore.runs.get(runId);
    if (!record?.result) throw new Error(`runtime_result_unavailable: ${runId}`);
    return record.result;
  }

  async createSession(ctx: ApplicationContext, input: CreateSessionInput): Promise<ApplicationSessionSnapshot> {
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
    ctx: ApplicationContext,
    sessionId: string,
    input: PatchSessionMetadataInput
  ): Promise<ApplicationSessionSnapshot> {
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

  async getSession(ctx: ApplicationContext, sessionId: string): Promise<ApplicationSessionSnapshot> {
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
      pendingApprovals: this.approvalBroker.list(sessionId)
    };
  }

  async getTranscript(
    _ctx: ApplicationContext,
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

  async startRun(_ctx: ApplicationContext, sessionId: string, input: StartRunInput, options: StartRunOptions = {}): Promise<RunSnapshot> {
    const runId = options.runId ?? this.idGenerator();
    const trigger = options.trigger ?? { kind: 'api' as const };
    const originKind = trigger.kind === 'scheduler'
      ? 'scheduler' as const
      : trigger.kind === 'user'
        ? 'user' as const
        : trigger.kind === 'channel_message' ? 'channel' as const
          : trigger.kind === 'workflow' || trigger.kind === 'subagent' || trigger.kind === 'team_member'
            ? trigger.kind : 'api' as const;
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
        ...(options.workflow ? { workflow: options.workflow } : {}),
        ...(options.team ? { team: options.team } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
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
      const failed = await this.stateStore.runs.markFailed(runId, applicationError(error));
      this.emit({ type: 'run.updated', run: toRunSnapshot(failed) });
      throw error;
    }
  }

  async getRun(_ctx: ApplicationContext, sessionId: string, runId: string): Promise<RunSnapshot> {
    const run = await this.stateStore.runs.get(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    return toRunSnapshot(run);
  }

  async cancelRun(
    _ctx: ApplicationContext,
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

  async listApprovals(_ctx: ApplicationContext, sessionId: string): Promise<PendingApprovalSnapshot[]> {
    return this.approvalBroker.list(sessionId);
  }

  async getApprovalSessionId(_ctx: ApplicationContext, approvalId: string): Promise<string> {
    return this.approvalBroker.getSessionId(approvalId);
  }

  async resolveApproval(ctx: ApplicationContext, approvalId: string, decision: ApprovalDecision): Promise<void> {
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
    await Promise.allSettled([...this.observations.values()]);
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
    const observation = handle.result.then(result => this.recordResult(result)).finally(() => {
      this.liveRuns.detach(handle.id);
      this.observations.delete(handle.id);
    });
    this.observations.set(handle.id, observation);
    void observation.catch(() => undefined);
  }

  private async recordResult(result: RunResult): Promise<void> {
    const record = result.status === 'completed'
      ? await this.stateStore.runs.markCompleted(result.runId, result)
      : result.status === 'cancelled'
        ? await this.stateStore.runs.markCancelled(result.runId, result)
        : await this.stateStore.runs.markFailed(result.runId, applicationError(result.error), result);
    this.emit({ type: 'run.updated', run: toRunSnapshot(record) });
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

function applicationError(error: unknown): ApplicationError {
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

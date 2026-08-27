import type { AgentRuntime, RunRequest } from '@desktop-agent/agent-runtime';
import type { RuntimeEventEnvelope } from '@desktop-agent/contracts/runtime';
import type {
  ApprovalDecision,
  CreateSessionInput,
  PendingApprovalSnapshot,
  RequestContext,
  RunSnapshot,
  ServerSessionSnapshot,
  ServerSessionSummary,
  StartRunInput,
  TranscriptPage,
  TranscriptQuery
} from '@desktop-agent/server-protocol';
import { ServerApprovalBroker, type ApprovalEvent } from './approval-service.js';
import { RunRegistry } from './run-registry.js';

type SessionMetadata = { title?: string; labels: string[] };

export type AppServiceEvent =
  | { type: 'runtime.event'; envelope: RuntimeEventEnvelope }
  | { type: 'run.updated'; run: RunSnapshot }
  | ApprovalEvent;

export type JojoAppServiceOptions = {
  approvalBroker?: ServerApprovalBroker;
  now?: () => Date;
};

export interface JojoAppService {
  listSessions(ctx: RequestContext): Promise<ServerSessionSummary[]>;
  createSession(ctx: RequestContext, input: CreateSessionInput): Promise<ServerSessionSnapshot>;
  getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot>;
  getTranscript(ctx: RequestContext, sessionId: string, input?: TranscriptQuery): Promise<TranscriptPage>;
  startRun(ctx: RequestContext, sessionId: string, input: StartRunInput): Promise<RunSnapshot>;
  getRun(ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot>;
  cancelRun(ctx: RequestContext, sessionId: string, runId: string, reason?: string): Promise<void>;
  listApprovals(ctx: RequestContext, sessionId: string): Promise<PendingApprovalSnapshot[]>;
  resolveApproval(ctx: RequestContext, approvalId: string, decision: ApprovalDecision): Promise<void>;
  subscribe(listener: (event: AppServiceEvent) => void): () => void;
  close(): Promise<void>;
}

class DefaultJojoAppService implements JojoAppService {
  private readonly metadata = new Map<string, SessionMetadata>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Set<(event: AppServiceEvent) => void>();
  private readonly runRegistry: RunRegistry;
  private readonly approvalBroker: ServerApprovalBroker;
  private readonly unsubscribeRuntime: () => void;
  private readonly unsubscribeApproval: () => void;

  constructor(private readonly runtime: AgentRuntime, options: JojoAppServiceOptions) {
    this.approvalBroker = options.approvalBroker ?? new ServerApprovalBroker(options.now);
    this.runRegistry = new RunRegistry(options.now, (run) => {
      this.bump(run.sessionId);
      this.emit({ type: 'run.updated', run });
    });
    this.unsubscribeRuntime = runtime.subscribe((envelope) => {
      this.bump(envelope.sessionId);
      this.emit({ type: 'runtime.event', envelope });
    });
    this.unsubscribeApproval = this.approvalBroker.subscribe((event) => {
      this.bump(event.approval.sessionId);
      this.emit(event);
    });
  }

  async listSessions(_ctx: RequestContext): Promise<ServerSessionSummary[]> {
    return Promise.all((await this.runtime.listSessions()).map(async (session) => {
      const metadata = this.metadata.get(session.id) ?? { labels: [] };
      return {
        id: session.id,
        ...(metadata.title ? { title: metadata.title } : {}),
        labels: [...metadata.labels],
        createdAt: session.createdAt,
        executionScope: session.executionScope,
        revision: this.revisions.get(session.id) ?? 0
      };
    }));
  }

  async createSession(ctx: RequestContext, input: CreateSessionInput): Promise<ServerSessionSnapshot> {
    const session = await this.runtime.openSession({
      ...(input.id ? { id: input.id } : {}),
      executionScope: input.executionScope
    });
    this.metadata.set(session.id, {
      ...(input.title ? { title: input.title } : {}),
      labels: [...(input.labels ?? [])]
    });
    this.bump(session.id);
    return this.getSession(ctx, session.id);
  }

  async getSession(ctx: RequestContext, sessionId: string): Promise<ServerSessionSnapshot> {
    const session = await this.runtime.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const runtime = await session.getSnapshot();
    const metadata = this.metadata.get(sessionId) ?? { labels: [] };
    const transcript = await this.getTranscript(ctx, sessionId, { laneId: 'main', limit: 100 });
    return {
      id: sessionId,
      ...(metadata.title ? { title: metadata.title } : {}),
      labels: [...metadata.labels],
      executionScope: runtime.session.executionScope,
      revision: this.revisions.get(sessionId) ?? 0,
      runtime,
      activeRuns: this.runRegistry.list(sessionId, true),
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

  async startRun(_ctx: RequestContext, sessionId: string, input: StartRunInput): Promise<RunSnapshot> {
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
      input: input.input,
      providerId: input.providerId,
      model: input.model,
      actor: { kind: 'main' },
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(budget ? { budget } : {})
    };
    const handle = await lane.run(request);
    return this.runRegistry.register(handle, sessionId, input.laneId);
  }

  async getRun(_ctx: RequestContext, sessionId: string, runId: string): Promise<RunSnapshot> {
    const run = this.runRegistry.get(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    return run;
  }

  async cancelRun(
    _ctx: RequestContext,
    sessionId: string,
    runId: string,
    reason?: string
  ): Promise<void> {
    const run = this.runRegistry.get(runId);
    if (!run || run.sessionId !== sessionId) throw new Error(`run_not_found: ${runId}`);
    if (!await this.runRegistry.cancel(runId, reason) && ['accepted', 'running'].includes(run.status)) {
      throw new Error(`run_not_found: ${runId}`);
    }
  }

  async listApprovals(_ctx: RequestContext, sessionId: string): Promise<PendingApprovalSnapshot[]> {
    return this.approvalBroker.list(sessionId);
  }

  async resolveApproval(_ctx: RequestContext, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.approvalBroker.resolve(approvalId, decision);
  }

  subscribe(listener: (event: AppServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.unsubscribeRuntime();
    this.unsubscribeApproval();
    this.runRegistry.markInterrupted();
    this.listeners.clear();
    await this.runtime.close();
  }

  private bump(sessionId: string): void {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
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

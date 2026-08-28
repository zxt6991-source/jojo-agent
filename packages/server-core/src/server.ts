import type { AppServiceEvent, JojoAppService } from '@desktop-agent/app-service';
import {
  JOJO_SERVER_PROTOCOL_VERSION,
  type ClientCommand,
  type CreateSessionInput,
  type LeaseMode,
  type LeaseSnapshot,
  type ModelInfo,
  type PatchSessionMetadataInput,
  type RequestContext,
  type RunSnapshot,
  type ServerCapabilities,
  type ServerInfo,
  type ServerSessionSnapshot,
  type ServerSessionSummary,
  type ServerSnapshot,
  type StartRunInput,
  type TranscriptPage,
  type TranscriptQuery
} from '@desktop-agent/server-protocol';
import { IdempotencyStore } from './idempotency.js';
import { LeaseManager } from './leases.js';
import { ScopePolicy } from './scope-policy.js';
import { ProtocolFailure } from './errors.js';

export type ServerCoreEvent = AppServiceEvent;

export type JojoServerCoreOptions = {
  serverId?: string;
  serverVersion?: string;
  models?: ModelInfo[];
  capabilities?: Partial<ServerCapabilities>;
  workspaceRoots?: string[];
  idGenerator?: () => string;
  now?: () => Date;
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
  private readonly idempotency = new IdempotencyStore();
  private readonly scopePolicy: ScopePolicy;

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
      ...options.capabilities
    };
    this.models = [...(options.models ?? [])];
    this.leases = new LeaseManager(options.idGenerator, options.now);
    this.scopePolicy = new ScopePolicy(options.workspaceRoots);
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
    ));
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
    return this.service.subscribe(listener);
  }

  close(): Promise<void> {
    return this.service.close();
  }

  private withLease(ctx: RequestContext, snapshot: ServerSessionSnapshot): ServerSessionSnapshot {
    return { ...snapshot, lease: this.leases.get(snapshot.id, ctx.connectionId) };
  }
}

export function createJojoServerCore(service: JojoAppService, options: JojoServerCoreOptions = {}): JojoServerCore {
  return new DefaultJojoServerCore(service, options);
}

function authorize(ctx: RequestContext, scope: string): void {
  if (ctx.principal.scopes.includes('admin') || ctx.principal.scopes.includes(scope)) return;
  throw new ProtocolFailure({ code: 'forbidden', message: `The principal lacks the ${scope} scope.` });
}

import type {
  AgentEvent,
  ApprovalRequest,
  HookRuntime,
  ModelProvider,
  PermissionDecision,
  ProjectIdentity,
  SubAgentMemoryBinding,
  ToolCall,
  Tool,
  WorkflowMemoryBinding
} from '@desktop-agent/contracts';
import type {
  ExecutionScope,
  JsonValue,
  LaneInfo,
  LaneSnapshot,
  RunResult,
  RuntimeError,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeInput,
  SessionInfo,
  SessionSnapshot
} from '@desktop-agent/contracts/runtime';
import { errorMessage } from '@desktop-agent/agent';
import { MemoryAgentRuntimeStore } from '../memory-store.js';
import type { MemoryRuntime } from '../memory/runtime.js';
import type { AgentRuntimeStore } from '../store.js';
import { resumeAgentTurn, runAgentTurn, type RuntimeAgentRunOptions } from '../harness/runner.js';
import { projectEntriesToMessages } from '../context/projection.js';
import type { RuntimeEventListener } from './events.js';
import type { RuntimeLane, RuntimeTranscriptPage, TranscriptReadOptions } from './lane.js';
import type { RunHandle, RunRequest, TelemetrySink } from './run.js';
import type { CreateLaneRequest, RuntimeSession } from './session.js';
import {
  EXECUTION_SCOPE_METADATA,
  scopeFromMetadata
} from '../scope.js';

const eventSequencesByStore = new WeakMap<AgentRuntimeStore, Map<string, number>>();

export type OpenSessionRequest = {
  id?: string;
  executionScope?: ExecutionScope;
  metadata?: Record<string, JsonValue>;
};

export type ResumeOperationRequest = {
  operationId: string;
  signal?: AbortSignal;
};

export type RuntimeRunSnapshot = {
  id: string;
  sessionId: string;
  laneId: string;
  status: 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled';
  result?: RunResult;
};

export type RuntimeResolutionContext = {
  sessionId: string;
  laneId: string;
  runId: string;
  executionScope: ExecutionScope;
  providerId: string;
  model: string;
  /** Empty when executionScope.kind is not workspace. */
  workingDirectory: string;
  actor?: RunRequest['actor'];
  workflow?: RunRequest['workflow'];
};

export type RuntimeHostDescriptor = {
  kind: 'desktop' | 'server' | 'test' | 'cli' | 'unknown';
  instanceId?: string;
};

export interface ModelProviderResolver {
  resolve(context: RuntimeResolutionContext): ModelProvider | Promise<ModelProvider>;
}

export type ToolSnapshotContext = RuntimeResolutionContext & {
  contextWindowTokens: number;
  maxOutputTokens: number;
};

export interface RuntimeToolSource {
  snapshot(context: ToolSnapshotContext): Tool[];
  dispose?(): Promise<void>;
}

export interface ToolResolver {
  resolve(context: RuntimeResolutionContext): RuntimeToolSource | Promise<RuntimeToolSource>;
}

export interface ApprovalBroker {
  requestApproval(request: ApprovalRequest, context: RuntimeResolutionContext, signal: AbortSignal): Promise<boolean>;
}

export interface RuntimePermissionGate {
  check(call: ToolCall, context: RuntimeResolutionContext): Promise<PermissionDecision>;
}

export interface RuntimeSummarizer {
  summarize(
    request: { sessionId: string; laneId: string; runId: string; source: string },
    signal: AbortSignal
  ): Promise<string>;
}

export interface RuntimeHookResolver {
  resolve(context: RuntimeResolutionContext): HookRuntime | Promise<HookRuntime>;
}

export type RuntimeRunContext = {
  projectIdentity?: ProjectIdentity;
  memoryBinding?: SubAgentMemoryBinding | WorkflowMemoryBinding;
};

export interface RuntimeRunContextResolver {
  resolve(context: RuntimeResolutionContext): RuntimeRunContext | Promise<RuntimeRunContext>;
}

export interface RuntimeEnvironment {
  host: RuntimeHostDescriptor;
  providers: ModelProviderResolver;
  tools: ToolResolver;
  permissions: RuntimePermissionGate;
  memory?: MemoryRuntime;
  hooks?: HookRuntime | RuntimeHookResolver;
  runContext?: RuntimeRunContextResolver;
  approval?: ApprovalBroker;
  summarizer?: RuntimeSummarizer;
  telemetry?: TelemetrySink;
  dispose?(): Promise<void>;
}

export type AgentRuntimeOptions = {
  environment: RuntimeEnvironment;
  store?: AgentRuntimeStore;
  idGenerator?: () => string;
  now?: () => Date;
};

export interface AgentRuntime {
  openSession(request: OpenSessionRequest): Promise<RuntimeSession>;
  getSession(id: string): Promise<RuntimeSession | undefined>;
  listSessions(): Promise<SessionInfo[]>;
  inspectRun(runId: string): Promise<RuntimeRunSnapshot | undefined>;
  /** Crash recovery only. Continue a conversation with RuntimeLane.run(). */
  resumeOperation(request: ResumeOperationRequest): Promise<RunHandle>;
  subscribe(listener: RuntimeEventListener): () => void;
  close(): Promise<void>;
}

type ActiveRun = {
  controller: AbortController;
  handle: RunHandle;
};

function defaultId(): string {
  return crypto.randomUUID();
}

function finalAssistantText(messages: RunResult['messages']): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = message.content
      .flatMap((block) => block.type === 'text' ? [block.text] : [])
      .join('')
      .trim();
    if (text) return text;
  }
  return undefined;
}

function runtimeError(error: unknown): RuntimeError {
  const message = errorMessage(error);
  const explicitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  const boundaryCode = /^(runtime_[a-z_]+)(?::|$)/u.exec(message)?.[1];
  const code = explicitCode ?? boundaryCode ?? 'runtime_internal';
  return { code, message: errorMessage(error) };
}

function userSessionMetadata(metadata: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!metadata) return undefined;
  const visible = Object.fromEntries(Object.entries(metadata).filter(([key]) => (
    key !== EXECUTION_SCOPE_METADATA
  )));
  return Object.keys(visible).length > 0 ? visible : undefined;
}

class DefaultAgentRuntime implements AgentRuntime {
  readonly store: AgentRuntimeStore;
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly sequence: Map<string, number>;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private closed = false;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.store = options.store ?? new MemoryAgentRuntimeStore();
    this.sequence = eventSequencesByStore.get(this.store) ?? new Map<string, number>();
    eventSequencesByStore.set(this.store, this.sequence);
    this.idGenerator = options.idGenerator ?? defaultId;
    this.now = options.now ?? (() => new Date());
  }

  async openSession(request: OpenSessionRequest): Promise<RuntimeSession> {
    this.assertOpen();
    const id = request.id ?? this.idGenerator();
    const existing = await this.store.getSession(id);
    if (!existing) {
      const scope = request.executionScope ?? { kind: 'none' as const };
      await this.store.createSession({
        id,
        createdAt: this.now().getTime(),
        metadata: {
          ...(request.metadata ?? {}),
          [EXECUTION_SCOPE_METADATA]: scope as JsonValue
        }
      });
      await this.store.saveLane({ sessionId: id, name: 'main', leafId: null, currentOperationId: null });
    }
    return new DefaultRuntimeSession(this, id);
  }

  async getSession(id: string): Promise<RuntimeSession | undefined> {
    this.assertOpen();
    return await this.store.getSession(id) ? new DefaultRuntimeSession(this, id) : undefined;
  }

  async listSessions(): Promise<SessionInfo[]> {
    this.assertOpen();
    return Promise.all((await this.store.listSessions()).map((session) => this.sessionInfo(session.id)));
  }

  async inspectRun(runId: string): Promise<RuntimeRunSnapshot | undefined> {
    this.assertOpen();
    const operation = await this.store.loadOperation(runId);
    if (!operation) return undefined;
    const { meta, state } = operation;
    if (state.phase !== 'completed' && state.phase !== 'failed' && state.phase !== 'aborted') {
      return {
        id: runId,
        sessionId: meta.sessionId,
        laneId: meta.lane,
        status: state.phase === 'suspended' ? 'suspended' : 'running'
      };
    }
    const lane = await this.store.getLane(meta.sessionId, meta.lane);
    const messages = projectEntriesToMessages(await this.store.readPath(lane?.leafId ?? null));
    if (state.phase === 'completed') {
      const finalText = finalAssistantText(messages);
      const result: RunResult = {
        runId,
        sessionId: meta.sessionId,
        laneId: meta.lane,
        status: 'completed',
        stopReason: state.stopReason,
        ...(finalText ? { finalText } : {}),
        messages
      };
      return { id: runId, sessionId: meta.sessionId, laneId: meta.lane, status: 'completed', result };
    }
    if (state.phase === 'aborted') {
      const result: RunResult = {
        runId,
        sessionId: meta.sessionId,
        laneId: meta.lane,
        status: 'cancelled',
        stopReason: state.reason,
        messages
      };
      return { id: runId, sessionId: meta.sessionId, laneId: meta.lane, status: 'cancelled', result };
    }
    const result: RunResult = {
      runId,
      sessionId: meta.sessionId,
      laneId: meta.lane,
      status: 'failed',
      messages: [],
      error: runtimeError(state.error)
    };
    return { id: runId, sessionId: meta.sessionId, laneId: meta.lane, status: 'failed', result };
  }

  async resumeOperation(request: ResumeOperationRequest): Promise<RunHandle> {
    this.assertOpen();
    const operation = await this.store.loadOperation(request.operationId);
    if (!operation) throw new Error(`runtime_operation_not_found: ${request.operationId}`);
    const session = await this.store.getSession(operation.meta.sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${operation.meta.sessionId}`);
    return this.startRun(
      operation.meta.sessionId,
      operation.meta.lane,
      {
        input: '',
        providerId: operation.meta.providerId,
        model: operation.meta.model,
        budget: { maxIterations: operation.meta.maxIterations },
        ...(request.signal ? { signal: request.signal } : {})
      },
      request.operationId,
      true
    );
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = [...this.activeRuns.values()];
    for (const run of active) run.controller.abort('runtime_closed');
    await Promise.allSettled(active.map((run) => run.handle.result));
    await this.options.environment.dispose?.();
    this.listeners.clear();
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const metadata = userSessionMetadata(session.metadata);
    return {
      id: session.id,
      createdAt: new Date(session.createdAt).toISOString(),
      executionScope: scopeFromMetadata(session.metadata),
      ...(metadata ? { metadata } : {})
    };
  }

  async laneInfo(sessionId: string, laneId: string): Promise<LaneInfo> {
    const lane = await this.store.getLane(sessionId, laneId);
    if (!lane) throw new Error(`runtime_lane_not_found: ${laneId}`);
    return {
      id: lane.name,
      sessionId,
      ...(lane.currentOperationId ? { activeRunId: lane.currentOperationId } : {})
    };
  }

  async laneSnapshot(sessionId: string, laneId: string): Promise<LaneSnapshot> {
    const lane = await this.store.getLane(sessionId, laneId);
    if (!lane) throw new Error(`runtime_lane_not_found: ${laneId}`);
    const entries = await this.store.readPath(lane.leafId);
    return {
      lane: await this.laneInfo(sessionId, laneId),
      messageCount: entries.filter((entry) => entry.type === 'message').length,
      ...(lane.leafId ? { leafEntryId: lane.leafId } : {})
    };
  }

  async readTranscript(
    sessionId: string,
    laneId: string,
    options: TranscriptReadOptions = {}
  ): Promise<RuntimeTranscriptPage> {
    const lane = await this.store.getLane(sessionId, laneId);
    if (!lane) throw new Error(`runtime_lane_not_found: ${laneId}`);
    const messages = (await this.store.readPath(lane.leafId))
      .flatMap((entry) => entry.type === 'message' ? [structuredClone(entry.message)] : []);
    const cursor = parseTranscriptCursor(options.cursor);
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    if (cursor > messages.length) throw new Error('runtime_transcript_cursor_invalid');
    const items = messages.slice(cursor, cursor + limit);
    const next = cursor + items.length;
    return {
      items,
      ...(next < messages.length ? { nextCursor: String(next) } : {})
    };
  }

  async listLaneInfo(sessionId: string): Promise<LaneInfo[]> {
    return Promise.all((await this.store.listLanes(sessionId)).map((lane) => this.laneInfo(sessionId, lane.name)));
  }

  async createLane(sessionId: string, request: CreateLaneRequest): Promise<RuntimeLane> {
    this.assertOpen();
    if (await this.store.getLane(sessionId, request.id)) {
      throw new Error(`runtime_lane_exists: ${request.id}`);
    }
    let leafId: string | null = null;
    if (request.parentLaneId) {
      const parent = await this.store.getLane(sessionId, request.parentLaneId);
      if (!parent) throw new Error(`runtime_parent_lane_not_found: ${request.parentLaneId}`);
      leafId = parent.leafId;
    }
    await this.store.saveLane({ sessionId, name: request.id, leafId, currentOperationId: null });
    return new DefaultRuntimeLane(this, sessionId, request.id);
  }

  async startRun(
    sessionId: string,
    laneId: string,
    request: RunRequest,
    runId = this.idGenerator(),
    resuming = false
  ): Promise<RunHandle> {
    this.assertOpen();
    const lane = await this.store.getLane(sessionId, laneId);
    if (!lane) throw new Error(`runtime_lane_not_found: ${laneId}`);
    if (lane.currentOperationId && lane.currentOperationId !== runId) {
      throw new Error(`runtime_lane_busy: ${laneId}`);
    }
    if (this.activeRuns.has(runId)) throw new Error(`runtime_run_active: ${runId}`);

    const session = await this.store.getSession(sessionId);
    if (!session) throw new Error(`runtime_session_not_found: ${sessionId}`);
    const persistedScope = scopeFromMetadata(session.metadata);
    const executionScope = persistedScope;
    const workingDirectory = executionScope.kind === 'workspace' ? executionScope.workingDirectory : '';
    const context: RuntimeResolutionContext = {
      sessionId,
      laneId,
      runId,
      executionScope,
      providerId: request.providerId,
      model: request.model,
      workingDirectory,
      ...(request.actor ? { actor: request.actor } : {}),
      ...(request.workflow ? { workflow: request.workflow } : {})
    };
    const [provider, toolSource, hooks, runContext] = await Promise.all([
      this.options.environment.providers.resolve(context),
      this.options.environment.tools.resolve(context),
      resolveHooks(this.options.environment.hooks, context),
      this.options.environment.runContext?.resolve(context)
    ]);
    const controller = new AbortController();
    let cancelReason: string | undefined;
    const abortFromRequest = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromRequest();
    else request.signal?.addEventListener('abort', abortFromRequest, { once: true });

    const handle: RunHandle = {
      id: runId,
      result: Promise.resolve(undefined as never),
      cancel: async (reason) => {
        cancelReason = reason;
        controller.abort(reason ?? 'cancelled');
      }
    };
    this.activeRuns.set(runId, { controller, handle });
    if (resuming) this.publish(sessionId, laneId, runId, { type: 'run.resumed' });

    const input = normalizeInput(request.input);
    const history = projectEntriesToMessages(await this.store.readPath(lane.leafId));
    const budget = request.budget;
    const contextWindowTokens = budget?.contextWindowTokens;
    const maxOutputTokens = budget?.maxOutputTokens;
    const runnerOptions: RuntimeAgentRunOptions = {
      sessionId,
      workingDirectory,
      executionScope,
      model: request.model,
      providerId: request.providerId,
      history,
      userText: input.text,
      ...(input.images.length ? { userImages: input.images } : {}),
      provider,
      tools: [],
      getTools: ({ contextWindowTokens: resolvedContextWindow, maxOutputTokens: resolvedMaxOutput }) => toolSource.snapshot({
        ...context,
        contextWindowTokens: resolvedContextWindow,
        maxOutputTokens: resolvedMaxOutput
      }),
      permissionGate: {
        check: (call) => this.options.environment.permissions.check(call, context)
      },
      signal: controller.signal,
      runtimeStore: this.store,
      operationId: runId,
      lane: laneId,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...(budget?.maxIterations !== undefined ? { maxIterations: budget.maxIterations } : {}),
      ...(budget?.allowPartialOnLimit !== undefined
        ? { allowPartialOnMaxIterations: budget.allowPartialOnLimit }
        : {}),
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(runContext?.projectIdentity ? { projectIdentity: runContext.projectIdentity } : {}),
      ...(runContext?.memoryBinding ? { memoryBinding: runContext.memoryBinding } : {}),
      hookMeta: {
        transport: hostTransport(this.options.environment.host.kind),
        agent: request.actor ?? { kind: 'main' },
        ...(request.workflow ? { workflow: {
          runId: request.workflow.runId ?? request.workflow.id,
          ...(request.workflow.stepId ? { stepId: request.workflow.stepId } : {})
        } } : {})
      },
      ...(this.options.environment.memory ? { memoryRuntime: this.options.environment.memory } : {}),
      ...(hooks ? { hooks } : {}),
      ...(this.options.environment.summarizer ? {
        summarize: (source, signal) => this.options.environment.summarizer!.summarize({
          sessionId, laneId, runId, source
        }, signal)
      } : {}),
      emit: (event) => this.onAgentEvent(sessionId, laneId, runId, event, resuming, () => cancelReason),
      approve: (approvalRequest, signal) => this.options.environment.approval
        ? this.options.environment.approval.requestApproval(approvalRequest, context, signal)
        : Promise.resolve(false)
    };

    const result = (async (): Promise<RunResult> => {
      try {
        const completed = resuming
          ? await resumeAgentTurn({ ...runnerOptions, runtimeStore: this.store, operationId: runId })
          : await runAgentTurn(runnerOptions);
        const status = completed.stopReason === 'cancelled' ? 'cancelled' as const : 'completed' as const;
        const finalText = finalAssistantText(completed.messages);
        return {
          runId,
          sessionId,
          laneId,
          status,
          stopReason: completed.stopReason,
          ...(finalText ? { finalText } : {}),
          messages: completed.messages
        };
      } catch (error) {
        return {
          runId,
          sessionId,
          laneId,
          status: 'failed',
          messages: [],
          error: runtimeError(error)
        };
      } finally {
        request.signal?.removeEventListener('abort', abortFromRequest);
        this.activeRuns.delete(runId);
        try { await toolSource.dispose?.(); }
        catch { /* Capability cleanup never replaces the Run result. */ }
      }
    })();
    Object.defineProperty(handle, 'result', { value: result, enumerable: true });
    return handle;
  }

  async cancelLane(sessionId: string, laneId: string, reason?: string): Promise<void> {
    const lane = await this.store.getLane(sessionId, laneId);
    if (!lane?.currentOperationId) return;
    await this.activeRuns.get(lane.currentOperationId)?.handle.cancel(reason);
  }

  private onAgentEvent(
    sessionId: string,
    laneId: string,
    runId: string,
    event: AgentEvent,
    resuming: boolean,
    cancelReason: () => string | undefined
  ): void {
    try { this.options.environment.telemetry?.diagnostic(event, { sessionId, laneId, runId }); }
    catch { /* Observers never change runtime behavior. */ }
    let projected: RuntimeEvent[] = [];
    switch (event.type) {
      case 'turn.started':
        if (!resuming) projected = [{ type: 'run.started' }];
        break;
      case 'text.delta': projected = [{ type: 'assistant.delta', text: event.text }]; break;
      case 'tool.started':
        projected = [
          { type: 'tool.requested', toolCallId: event.id, name: event.name, input: event.input as JsonValue },
          { type: 'tool.started', toolCallId: event.id, name: event.name, input: event.input as JsonValue }
        ];
        break;
      case 'approval.required': projected = [{ type: 'approval.required', request: event.request }]; break;
      case 'tool.finished':
        projected = [{
          type: 'tool.completed',
          toolCallId: event.id,
          ok: event.result.ok,
          ...(event.result.code ? { code: event.result.code } : {})
        }];
        break;
      case 'tool.progress':
        projected = [{ type: 'tool.progress', toolCallId: event.id, text: event.text }];
        break;
      case 'context.updated':
        if (event.compactedMessages > 0) {
          projected = [{
            type: 'context.compacted',
            compactedMessages: event.compactedMessages,
            reclaimedToolCharacters: event.reclaimedToolCharacters
          }];
        }
        break;
      case 'turn.completed': projected = [{ type: 'run.completed', stopReason: event.stopReason }]; break;
      case 'turn.cancelled': {
        const reason = cancelReason();
        projected = [{ type: 'run.cancelled', ...(reason ? { reason } : {}) }];
        break;
      }
      case 'turn.failed': projected = [{ type: 'run.failed', error: { code: event.code, message: event.message } }]; break;
      case 'usage': projected = [{ type: 'usage.updated',
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        ...(event.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: event.cacheReadInputTokens } : {}),
        ...(event.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: event.cacheWriteInputTokens } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {})
      }]; break;
      default: break;
    }
    for (const item of projected) this.publish(sessionId, laneId, runId, item);
  }

  private publish(sessionId: string, laneId: string, runId: string | undefined, event: RuntimeEvent): void {
    const sequence = (this.sequence.get(sessionId) ?? 0) + 1;
    this.sequence.set(sessionId, sequence);
    const envelope: RuntimeEventEnvelope = {
      schemaVersion: 1,
      eventId: this.idGenerator(),
      sequence,
      timestamp: this.now().toISOString(),
      sessionId,
      laneId,
      ...(runId ? { runId } : {}),
      event
    };
    for (const listener of this.listeners) {
      try { listener(envelope); }
      catch { /* Subscribers are isolated from the operation. */ }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('runtime_closed');
  }
}

class DefaultRuntimeSession implements RuntimeSession {
  constructor(private readonly runtime: DefaultAgentRuntime, readonly id: string) {}

  async getLane(id = 'main'): Promise<RuntimeLane> {
    await this.runtime.laneInfo(this.id, id);
    return new DefaultRuntimeLane(this.runtime, this.id, id);
  }

  createLane(request: CreateLaneRequest): Promise<RuntimeLane> {
    return this.runtime.createLane(this.id, request);
  }

  listLanes(): Promise<LaneInfo[]> {
    return this.runtime.listLaneInfo(this.id);
  }

  async getSnapshot(): Promise<SessionSnapshot> {
    return { session: await this.runtime.sessionInfo(this.id), lanes: await this.listLanes() };
  }
}

class DefaultRuntimeLane implements RuntimeLane {
  constructor(
    private readonly runtime: DefaultAgentRuntime,
    readonly sessionId: string,
    readonly id: string
  ) {}

  run(request: RunRequest): Promise<RunHandle> {
    return this.runtime.startRun(this.sessionId, this.id, request, request.runId);
  }

  cancelActiveRun(reason?: string): Promise<void> {
    return this.runtime.cancelLane(this.sessionId, this.id, reason);
  }

  getSnapshot(): Promise<LaneSnapshot> {
    return this.runtime.laneSnapshot(this.sessionId, this.id);
  }

  readTranscript(options?: TranscriptReadOptions): Promise<RuntimeTranscriptPage> {
    return this.runtime.readTranscript(this.sessionId, this.id, options);
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new DefaultAgentRuntime(options);
}

function normalizeInput(input: RuntimeInput | string): {
  text: string;
  images: Extract<RuntimeInput['content'][number], { type: 'image' }>[];
} {
  if (typeof input === 'string') return { text: input, images: [] };
  return {
    text: input.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join(''),
    images: input.content.filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
  };
}

function resolveHooks(
  hooks: RuntimeEnvironment['hooks'],
  context: RuntimeResolutionContext
): HookRuntime | Promise<HookRuntime | undefined> | undefined {
  if (!hooks) return undefined;
  return 'resolve' in hooks ? hooks.resolve(context) : hooks;
}

function hostTransport(kind: RuntimeHostDescriptor['kind']): 'desktop' | 'server' | 'cli' | 'unknown' {
  return kind === 'desktop' || kind === 'server' || kind === 'cli' ? kind : 'unknown';
}

function parseTranscriptCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) throw new Error('runtime_transcript_cursor_invalid');
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('runtime_transcript_cursor_invalid');
  return value;
}

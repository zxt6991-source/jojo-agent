import type {
  AgentEvent,
  ApprovalRequest,
  HookRuntime,
  ModelProvider,
  PermissionGate,
  Tool
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
  SessionInfo,
  SessionSnapshot
} from '@desktop-agent/contracts/runtime';
import { errorMessage } from '@desktop-agent/agent';
import { MemoryAgentRuntimeStore } from '../memory-store.js';
import type { MemoryRuntime } from '../memory/runtime.js';
import type { AgentRuntimeStore } from '../store.js';
import { resumeAgentTurn, runAgentTurn, type RuntimeAgentRunOptions } from '../harness/runner.js';
import type { RuntimeEventListener } from './events.js';
import type { RuntimeLane } from './lane.js';
import type { RunHandle, RunRequest, TelemetrySink } from './run.js';
import type { CreateLaneRequest, RuntimeSession } from './session.js';
import {
  EXECUTION_SCOPE_METADATA,
  LEGACY_WORKING_DIRECTORY_METADATA,
  scopeFromMetadata
} from '../scope.js';

const eventSequencesByStore = new WeakMap<AgentRuntimeStore, Map<string, number>>();

export type OpenSessionRequest = {
  id?: string;
  executionScope?: ExecutionScope;
  /** Compatibility input used to derive a workspace scope when executionScope is omitted. */
  workingDirectory?: string;
  metadata?: Record<string, JsonValue>;
};

export type ResumeOperationRequest = {
  operationId: string;
  signal?: AbortSignal;
};

export type RuntimeResolutionContext = {
  sessionId: string;
  laneId: string;
  runId: string;
  executionScope: ExecutionScope;
  providerId: string;
  model: string;
};

export interface ModelProviderResolver {
  resolve(context: RuntimeResolutionContext): ModelProvider | Promise<ModelProvider>;
}

export interface ToolResolver {
  resolve(context: RuntimeResolutionContext): Tool[] | Promise<Tool[]>;
}

export interface ApprovalBroker {
  requestApproval(request: ApprovalRequest, context: RuntimeResolutionContext, signal: AbortSignal): Promise<boolean>;
}

export interface RuntimeEnvironment {
  providers: ModelProviderResolver;
  tools: ToolResolver;
  permissions: PermissionGate;
  memory?: MemoryRuntime;
  hooks?: HookRuntime;
  approval?: ApprovalBroker;
  telemetry?: TelemetrySink;
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
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'runtime_error';
  return { code, message: errorMessage(error) };
}

function userSessionMetadata(metadata: Record<string, JsonValue> | undefined): Record<string, JsonValue> | undefined {
  if (!metadata) return undefined;
  const visible = Object.fromEntries(Object.entries(metadata).filter(([key]) => (
    key !== EXECUTION_SCOPE_METADATA && key !== LEGACY_WORKING_DIRECTORY_METADATA
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
      const scope = request.executionScope
        ?? (request.workingDirectory
          ? { kind: 'workspace' as const, workingDirectory: request.workingDirectory }
          : { kind: 'none' as const });
      const legacyWorkingDirectory = request.workingDirectory
        ?? (scope.kind === 'workspace' ? scope.workingDirectory : process.cwd());
      await this.store.createSession({
        id,
        createdAt: this.now().getTime(),
        metadata: {
          ...(request.metadata ?? {}),
          [EXECUTION_SCOPE_METADATA]: scope as JsonValue,
          [LEGACY_WORKING_DIRECTORY_METADATA]: legacyWorkingDirectory
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
        maxIterations: operation.meta.maxIterations,
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
    const executionScope = persistedScope.kind === 'none' && request.workingDirectory
      ? { kind: 'workspace' as const, workingDirectory: request.workingDirectory }
      : persistedScope;
    const workingDirectory = request.workingDirectory
      ?? (executionScope.kind === 'workspace' ? executionScope.workingDirectory : undefined)
      ?? (typeof session.metadata?.[LEGACY_WORKING_DIRECTORY_METADATA] === 'string'
        ? session.metadata[LEGACY_WORKING_DIRECTORY_METADATA] as string
        : process.cwd());
    const context: RuntimeResolutionContext = {
      sessionId,
      laneId,
      runId,
      executionScope,
      providerId: request.providerId,
      model: request.model
    };
    const [provider, tools] = await Promise.all([
      this.options.environment.providers.resolve(context),
      this.options.environment.tools.resolve(context)
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

    const runnerOptions: RuntimeAgentRunOptions = {
      sessionId,
      workingDirectory,
      executionScope,
      model: request.model,
      providerId: request.providerId,
      history: request.history ?? [],
      userText: request.input,
      provider,
      tools,
      permissionGate: this.options.environment.permissions,
      signal: controller.signal,
      runtimeStore: this.store,
      operationId: runId,
      lane: laneId,
      ...(request.instructions ? { instructions: request.instructions } : {}),
      ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
      ...(request.allowPartialOnMaxIterations !== undefined
        ? { allowPartialOnMaxIterations: request.allowPartialOnMaxIterations }
        : {}),
      ...(request.contextWindowTokens !== undefined ? { contextWindowTokens: request.contextWindowTokens } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.projectIdentity ? { projectIdentity: request.projectIdentity } : {}),
      ...(request.memoryBinding ? { memoryBinding: request.memoryBinding } : {}),
      ...(request.hookMeta ? { hookMeta: request.hookMeta } : {}),
      ...(this.options.environment.memory ? { memoryRuntime: this.options.environment.memory } : {}),
      ...(this.options.environment.hooks ? { hooks: this.options.environment.hooks } : {}),
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
    try { this.options.environment.telemetry?.diagnostic(event); }
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
    return this.runtime.startRun(this.sessionId, this.id, request);
  }

  cancelActiveRun(reason?: string): Promise<void> {
    return this.runtime.cancelLane(this.sessionId, this.id, reason);
  }

  getSnapshot(): Promise<LaneSnapshot> {
    return this.runtime.laneSnapshot(this.sessionId, this.id);
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  return new DefaultAgentRuntime(options);
}

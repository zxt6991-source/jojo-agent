import type {
  OrchestrationEvent,
  SubAgentErrorCode,
  SubAgentRound,
  SubAgentSnapshot,
  SubAgentState,
  HookRuntime,
  SubagentStopPayload,
  UsageTotals
} from '@desktop-agent/contracts';
import { abortError } from '../abort.js';
import { OrchestrationError } from '../errors.js';
import { IsolationManager } from '../isolation/manager.js';
import { resolveIsolationType, withIsolationTask } from '../isolation/policy.js';
import { copyIsolationSnapshot, type IsolationContext } from '../isolation/types.js';
import { assertOutputSchema, validateStructuredOutput } from '../structured-output.js';
import { accrueUsage, emptyUsage } from '../usage.js';
import { AgentProfileRegistry, createBuiltinAgentProfileRegistry } from './profile-registry.js';
import { AgentExecutionScheduler } from './scheduler.js';
import { acquireResourceAndAgentSlots, ResourceGroupLimiter } from './resource-groups.js';
import { ProviderSemaphore } from './provider-semaphore.js';
import type { LeafAgentRunner, SubAgentStartRequest } from './types.js';

const TERMINAL_STATES = new Set<SubAgentState>(['completed', 'failed', 'cancelled', 'timed_out', 'closed']);

type LiveSubAgent = {
  snapshot: SubAgentSnapshot;
  request: SubAgentStartRequest & { timeoutMs: number };
  controller: AbortController | undefined;
  continuationId: string | undefined;
  isolationContext: IsolationContext | undefined;
  done: Promise<void>;
  resolveDone: () => void;
  settled: boolean;
  hooks: HookRuntime | undefined;
};

export type SubAgentManagerOptions = {
  maxPerSession?: number;
  retention?: number;
  profileRegistry?: AgentProfileRegistry;
  isolation?: IsolationManager;
  resourceGroups?: ResourceGroupLimiter;
  providers?: ProviderSemaphore;
  resolveHooks?: (input: { sessionId: string; workingDirectory: string; signal: AbortSignal }) => Promise<HookRuntime>;
};

function copySnapshot(snapshot: SubAgentSnapshot): SubAgentSnapshot {
  return {
    ...snapshot,
    ...(snapshot.memory ? { memory: structuredClone(snapshot.memory) } : {}),
    ...(snapshot.structuredResult !== undefined ? { structuredResult: structuredClone(snapshot.structuredResult) } : {}),
    ...(snapshot.isolation ? { isolation: copyIsolationSnapshot(snapshot.isolation) } : {}),
    usage: { ...snapshot.usage },
    rounds: snapshot.rounds.map((round) => ({ ...round, usage: { ...round.usage } }))
  };
}

function addUsage(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens
  };
}

function subtractUsage(total: UsageTotals, base: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, total.inputTokens - base.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - base.outputTokens),
    cacheReadInputTokens: Math.max(0, total.cacheReadInputTokens - base.cacheReadInputTokens),
    cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens - base.cacheWriteInputTokens)
  };
}

export class SubAgentManager {
  private readonly agents = new Map<string, LiveSubAgent>();
  private readonly maxPerSession: number;
  private readonly retention: number;
  private readonly profileRegistry: AgentProfileRegistry;
  private readonly isolation: IsolationManager | undefined;
  private readonly resourceGroups: ResourceGroupLimiter;
  private readonly providers: ProviderSemaphore;
  private readonly resolveHooks: SubAgentManagerOptions['resolveHooks'];

  constructor(
    private readonly runner: LeafAgentRunner,
    private readonly scheduler: AgentExecutionScheduler,
    private readonly emit: (event: OrchestrationEvent) => void,
    options: SubAgentManagerOptions = {}
  ) {
    this.maxPerSession = options.maxPerSession ?? 8;
    this.retention = options.retention ?? 32;
    this.profileRegistry = options.profileRegistry ?? createBuiltinAgentProfileRegistry();
    this.isolation = options.isolation;
    this.resourceGroups = options.resourceGroups ?? new ResourceGroupLimiter();
    this.providers = options.providers ?? new ProviderSemaphore();
    this.resolveHooks = options.resolveHooks;
  }

  start(request: SubAgentStartRequest): SubAgentSnapshot {
    if ((request.depth ?? 0) >= 1) throw new OrchestrationError('nested_subagent_forbidden', 'Nested sub-agents are not allowed.');
    const profile = this.profileRegistry.get(request.profile, request.workingDirectory);
    const isolationType = resolveIsolationType({
      profile,
      ...(request.readOnly !== undefined ? { requestReadOnly: request.readOnly } : {}),
      ...(request.isolation?.type ? { requestedType: request.isolation.type } : {})
    });
    if (isolationType === 'worktree' && !this.isolation) {
      throw new OrchestrationError('worktree_create_failed', 'Worktree isolation is not configured.');
    }
    const effectiveRequest: SubAgentStartRequest & { timeoutMs: number } = {
      ...request,
      model: profile.model && profile.model !== 'inherit' ? profile.model : request.model,
      maxIterations: request.maxIterations ?? profile.maxIterations ?? 8,
      timeoutMs: request.timeoutMs ?? profile.timeoutMs ?? 120_000,
      ...(request.outputSchema ?? profile.outputSchema
        ? { outputSchema: request.outputSchema ?? profile.outputSchema }
        : {})
    };
    if (effectiveRequest.outputSchema) assertOutputSchema(effectiveRequest.outputSchema);
    if (effectiveRequest.resources) this.resourceGroups.register(effectiveRequest.resources);
    const liveForSession = this.list(request.sessionId).filter((agent) => !TERMINAL_STATES.has(agent.state));
    if (liveForSession.length >= this.maxPerSession) {
      throw new OrchestrationError('subagent_limit_reached', `A session may have at most ${this.maxPerSession} active sub-agents.`);
    }
    this.prune();
    const id = `sa_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const live: LiveSubAgent = {
      snapshot: {
        id,
        sessionId: request.sessionId,
        label: request.label?.trim() || request.task.trim().slice(0, 120),
        task: request.task,
        profile: request.profile,
        state: 'queued',
        createdAt,
        model: effectiveRequest.model,
        usage: emptyUsage(),
        incomplete: false,
        ...(effectiveRequest.resources ? { resourceGroup: effectiveRequest.resources.group } : {}),
        ...(effectiveRequest.memoryBinding ? { memory: structuredClone(effectiveRequest.memoryBinding) } : {}),
        rounds: [{ index: 1, input: request.task, usage: emptyUsage(), incomplete: false }]
      },
      request: effectiveRequest,
      controller: new AbortController(),
      continuationId: undefined,
      isolationContext: undefined,
      done,
      resolveDone,
      settled: false,
      hooks: undefined
    };
    this.agents.set(id, live);
    this.notify(live);
    void this.execute(live, request.task, false);
    return copySnapshot(live.snapshot);
  }

  async wait(ids: string[], signal: AbortSignal, timeoutMs: number): Promise<SubAgentSnapshot[]> {
    const agents = ids.map((id) => {
      const live = this.agents.get(id);
      if (!live) throw new Error(`subagent_not_found: ${id}`);
      return live;
    });
    if (signal.aborted) throw abortError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs);
      onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([Promise.all(agents.map((agent) => agent.done)).then(() => undefined), interrupted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
    return agents.map((agent) => copySnapshot(agent.snapshot));
  }

  get(id: string): SubAgentSnapshot | undefined {
    const live = this.agents.get(id);
    return live ? copySnapshot(live.snapshot) : undefined;
  }

  list(sessionId: string): SubAgentSnapshot[] {
    return [...this.agents.values()]
      .filter((agent) => agent.snapshot.sessionId === sessionId)
      .map((agent) => copySnapshot(agent.snapshot));
  }

  cancel(id: string): SubAgentSnapshot | undefined {
    const live = this.agents.get(id);
    if (!live || TERMINAL_STATES.has(live.snapshot.state)) return live ? copySnapshot(live.snapshot) : undefined;
    if (live.snapshot.state === 'idle') {
      live.snapshot = { ...live.snapshot, state: 'cancelled', finishedAt: new Date().toISOString(), stopReason: 'cancelled', incomplete: true };
      void this.closeContinuation(live);
      void this.settleIsolation(live);
      this.notify(live);
      void this.dispatchSubagentStop(live);
      return copySnapshot(live.snapshot);
    }
    live.controller?.abort();
    const currentRoundUsage = live.snapshot.rounds.at(-1)?.usage ?? emptyUsage();
    this.finish(live, 'cancelled', subtractUsage(live.snapshot.usage, currentRoundUsage), { stopReason: 'cancelled' });
    return copySnapshot(live.snapshot);
  }

  send(id: string, message: string): SubAgentSnapshot {
    const live = this.agents.get(id);
    if (!live) throw new OrchestrationError('subagent_not_found', `Sub-agent not found: ${id}`);
    if (live.snapshot.state === 'queued' || live.snapshot.state === 'running') {
      throw new OrchestrationError('subagent_busy', `Sub-agent is busy: ${id}`);
    }
    if (live.snapshot.state !== 'idle' || !live.continuationId || !this.runner.continue) {
      throw new OrchestrationError('subagent_closed', `Sub-agent cannot continue: ${id}`);
    }
    const input = message.trim();
    if (!input) throw new OrchestrationError('invalid_input', 'Continuation message is required.');
    let resolveDone: () => void = () => undefined;
    live.done = new Promise<void>((resolve) => { resolveDone = resolve; });
    live.resolveDone = resolveDone;
    live.controller = new AbortController();
    live.settled = false;
    live.snapshot = {
      ...live.snapshot,
      state: 'queued',
      rounds: [...live.snapshot.rounds, {
        index: live.snapshot.rounds.length + 1, input, usage: emptyUsage(), incomplete: false
      }]
    };
    this.notify(live);
    void this.execute(live, input, true);
    return copySnapshot(live.snapshot);
  }

  async close(id: string): Promise<SubAgentSnapshot> {
    const live = this.agents.get(id);
    if (!live) throw new OrchestrationError('subagent_not_found', `Sub-agent not found: ${id}`);
    if (live.snapshot.state === 'queued' || live.snapshot.state === 'running') {
      throw new OrchestrationError('subagent_busy', `Sub-agent is busy: ${id}`);
    }
    if (live.snapshot.state === 'closed') return copySnapshot(live.snapshot);
    if (live.snapshot.state !== 'idle') throw new OrchestrationError('subagent_closed', `Sub-agent cannot be closed from state: ${live.snapshot.state}`);
    await this.closeContinuation(live);
    live.snapshot = { ...live.snapshot, state: 'closed', finishedAt: new Date().toISOString() };
    await this.settleIsolation(live);
    this.notify(live);
    await this.dispatchSubagentStop(live);
    return copySnapshot(live.snapshot);
  }

  cancelSession(sessionId: string): void {
    for (const agent of this.agents.values()) {
      if (agent.snapshot.sessionId === sessionId) this.cancel(agent.snapshot.id);
    }
  }

  async quiesceSession(sessionId: string): Promise<void> {
    const agents = [...this.agents.values()].filter((agent) => agent.snapshot.sessionId === sessionId);
    for (const agent of agents) this.cancel(agent.snapshot.id);
    await Promise.all(agents.map((agent) => agent.done));
    await Promise.all(agents.map((agent) => this.closeContinuation(agent)));
    await Promise.all(agents.map((agent) => this.settleIsolation(agent)));
  }

  private async execute(live: LiveSubAgent, message: string, continuation: boolean): Promise<void> {
    const request = live.request;
    const controller = live.controller;
    if (!controller) return;
    const baseUsage = { ...live.snapshot.usage };
    let release: (() => void) | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      release = await acquireResourceAndAgentSlots({
        resourceGroups: this.resourceGroups,
        signal: controller.signal,
        scheduler: this.scheduler,
        providers: this.providers,
        providerId: request.providerId,
        ...(request.resources ? { resources: request.resources } : {})
      });
      if (live.settled) return;
      const startedAt = new Date().toISOString();
      live.snapshot = {
        ...live.snapshot,
        state: 'running',
        startedAt: live.snapshot.startedAt ?? startedAt,
        rounds: this.updateCurrentRound(live.snapshot.rounds, { startedAt })
      };
      this.notify(live);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);
      if (!continuation && !live.isolationContext) {
        const profile = this.profileRegistry.get(request.profile, request.workingDirectory);
        const isolationType = resolveIsolationType({
          profile,
          ...(request.readOnly !== undefined ? { requestReadOnly: request.readOnly } : {}),
          ...(request.isolation?.type ? { requestedType: request.isolation.type } : {})
        });
        if (isolationType === 'worktree') {
          if (!this.isolation) throw new OrchestrationError('worktree_create_failed', 'Worktree isolation is not configured.');
          live.isolationContext = await this.isolation.prepare({
            ownerId: live.snapshot.id,
            sessionId: request.sessionId,
            workingDirectory: request.workingDirectory,
            branchHint: live.snapshot.id
          });
        }
      }
      if (!live.hooks && this.resolveHooks) {
        live.hooks = await this.resolveHooks({
          sessionId: request.sessionId,
          workingDirectory: live.isolationContext?.workingDirectory ?? request.workingDirectory,
          signal: controller.signal
        });
      }
      const handleEvent: Parameters<LeafAgentRunner['run']>[2] = (event) => {
        if (event.type !== 'usage' || live.settled) return;
        accrueUsage(live.snapshot.usage, event);
        const roundUsage = subtractUsage(live.snapshot.usage, baseUsage);
        live.snapshot = { ...live.snapshot, rounds: this.updateCurrentRound(live.snapshot.rounds, { usage: roundUsage }) };
        this.notify(live);
      };
      const result = continuation
        ? await this.runner.continue!(live.continuationId!, withIsolationTask(message, live.isolationContext), controller.signal, handleEvent)
        : await this.runner.run({
            id: live.snapshot.id,
            sessionId: request.sessionId,
            workingDirectory: live.isolationContext?.workingDirectory ?? request.workingDirectory,
            task: withIsolationTask(message, live.isolationContext),
            profile: request.profile,
            providerId: request.providerId,
            model: request.model,
            maxIterations: request.maxIterations ?? 8,
            timeoutMs: request.timeoutMs,
            continuable: true,
            runtimeLane: { name: `agent:${live.snapshot.id}`, parentLane: 'main' },
            ...(request.memoryBinding ? { memoryBinding: request.memoryBinding } : {}),
            ...(live.hooks ? { hooks: live.hooks } : {}),
            ...(request.tools ? { tools: request.tools } : {}),
            ...(request.readOnly !== undefined ? { readOnly: request.readOnly } : {}),
            ...(request.outputSchema ? { outputSchema: request.outputSchema } : {})
          }, controller.signal, handleEvent);
      if (live.settled) return;
      if (result.continuationId) live.continuationId = result.continuationId;
      if (timedOut) this.finish(live, 'timed_out', baseUsage, { stopReason: 'timeout', result: result.result, incomplete: true, usage: result.usage });
      else if (result.stopReason === 'cancelled') this.finish(live, 'cancelled', baseUsage, { stopReason: result.stopReason, result: result.result, incomplete: true, usage: result.usage });
      else if (request.outputSchema) {
        const structured = validateStructuredOutput(result.result, request.outputSchema);
        if (!structured.ok) {
          void this.closeContinuation(live).catch(() => undefined);
          this.finish(live, 'failed', baseUsage, {
            stopReason: structured.code,
            result: result.result,
            error: structured.message,
            errorCode: structured.code,
            schemaValid: false,
            incomplete: true,
            usage: result.usage
          });
        } else {
          this.finish(live, result.continuationId && this.runner.continue ? 'idle' : 'completed', baseUsage, {
            ...result,
            structuredResult: structured.value,
            schemaValid: true
          });
        }
      } else this.finish(live, result.continuationId && this.runner.continue ? 'idle' : 'completed', baseUsage, result);
    } catch (error) {
      if (live.settled) return;
      if (timedOut) this.finish(live, 'timed_out', baseUsage, { stopReason: 'timeout', error: 'Sub-agent timed out.', incomplete: true });
      else if (controller.signal.aborted) this.finish(live, 'cancelled', baseUsage, { stopReason: 'cancelled' });
      else this.finish(live, 'failed', baseUsage, {
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof OrchestrationError ? { errorCode: error.code as SubAgentErrorCode } : {}),
        incomplete: true
      });
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
      await this.settleIsolation(live);
    }
  }

  private finish(
    live: LiveSubAgent,
    state: Extract<SubAgentState, 'idle' | 'completed' | 'failed' | 'cancelled' | 'timed_out'>,
    baseUsage: UsageTotals,
    values: {
      stopReason?: string;
      result?: string;
      structuredResult?: unknown;
      schemaValid?: boolean;
      error?: string;
      errorCode?: SubAgentErrorCode;
      incomplete?: boolean;
      usage?: SubAgentSnapshot['usage'];
    }
  ): void {
    if (live.settled) return;
    live.settled = true;
    const finishedAt = new Date().toISOString();
    const usage = values.usage ? addUsage(baseUsage, values.usage) : live.snapshot.usage;
    const roundUsage = values.usage ?? subtractUsage(usage, baseUsage);
    const previousSnapshot = { ...live.snapshot };
    delete previousSnapshot.structuredResult;
    delete previousSnapshot.schemaValid;
    delete previousSnapshot.errorCode;
    delete previousSnapshot.error;
    live.snapshot = {
      ...previousSnapshot,
      state,
      ...(state !== 'idle' ? { finishedAt } : {}),
      ...(values.stopReason ? { stopReason: values.stopReason } : {}),
      ...(values.result ? { result: values.result } : {}),
      ...(values.structuredResult !== undefined ? { structuredResult: structuredClone(values.structuredResult) } : {}),
      ...(values.schemaValid !== undefined ? { schemaValid: values.schemaValid } : {}),
      ...(values.error ? { error: values.error } : {}),
      ...(values.errorCode ? { errorCode: values.errorCode } : {}),
      usage: { ...usage },
      incomplete: values.incomplete ?? false,
      rounds: this.updateCurrentRound(live.snapshot.rounds, {
        finishedAt,
        usage: roundUsage,
        ...(values.stopReason ? { stopReason: values.stopReason } : {}),
        ...(values.result ? { output: values.result } : {}),
        ...(values.error ? { error: values.error } : {}),
        incomplete: values.incomplete ?? false
      })
    };
    live.controller = undefined;
    this.notify(live);
    if (state === 'idle') live.resolveDone();
    else void this.dispatchSubagentStop(live).finally(live.resolveDone);
  }

  private async dispatchSubagentStop(live: LiveSubAgent): Promise<void> {
    if (!live.hooks?.configured('SubagentStop')) return;
    const state = live.snapshot.state === 'cancelled' ? 'cancelled'
      : live.snapshot.state === 'completed' || live.snapshot.state === 'closed' ? 'completed'
        : 'failed';
    const payload: SubagentStopPayload = {
      schemaVersion: 1,
      eventId: `hookevt_${crypto.randomUUID()}`,
      event: 'SubagentStop',
      timestamp: new Date().toISOString(),
      sessionId: live.snapshot.sessionId,
      operationId: `subagent:${live.snapshot.id}`,
      lane: `agent:${live.snapshot.id}`,
      agent: { kind: 'subagent', id: live.snapshot.id, profile: live.snapshot.profile },
      workingDirectory: live.isolationContext?.workingDirectory ?? live.request.workingDirectory,
      provider: { id: live.request.providerId, model: live.snapshot.model },
      transport: 'desktop',
      subagentId: live.snapshot.id,
      profile: live.snapshot.profile,
      state,
      ...(live.snapshot.result ? { result: live.snapshot.result } : {})
    };
    try { await live.hooks.dispatch('SubagentStop', payload); }
    catch { /* Hook failure is isolated from sub-agent settlement. */ }
  }

  private updateCurrentRound(rounds: SubAgentRound[], update: Partial<SubAgentRound>): SubAgentRound[] {
    const current = rounds.length - 1;
    return rounds.map((round, index) => index === current ? { ...round, ...update } : round);
  }

  private async settleIsolation(live: LiveSubAgent): Promise<void> {
    const context = live.isolationContext;
    if (!context || !this.isolation) return;
    const keep = live.snapshot.state === 'idle' || live.snapshot.state === 'queued' || live.snapshot.state === 'running';
    try {
      const isolation = keep
        ? await this.isolation.inspect(context)
        : await this.isolation.finish(context);
      if (!keep) live.isolationContext = undefined;
      live.snapshot = { ...live.snapshot, isolation };
      this.notify(live);
    } catch {
      if (!keep) live.isolationContext = undefined;
    }
  }

  private async closeContinuation(live: LiveSubAgent): Promise<void> {
    const continuationId = live.continuationId;
    live.continuationId = undefined;
    if (continuationId && this.runner.close) await this.runner.close(continuationId);
  }

  private notify(live: LiveSubAgent): void {
    this.emit({ type: 'subagent.changed', subagent: copySnapshot(live.snapshot) });
  }

  private prune(): void {
    const terminal = [...this.agents.values()]
      .filter((agent) => TERMINAL_STATES.has(agent.snapshot.state))
      .sort((left, right) => left.snapshot.createdAt.localeCompare(right.snapshot.createdAt));
    for (const agent of terminal.slice(0, Math.max(0, terminal.length - this.retention + 1))) {
      this.agents.delete(agent.snapshot.id);
    }
  }
}

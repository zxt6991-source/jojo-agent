import type { OrchestrationEvent, SubAgentSnapshot, SubAgentState } from '@desktop-agent/contracts';
import { abortError } from '../abort.js';
import { accrueUsage, emptyUsage } from '../usage.js';
import { AgentExecutionScheduler } from './scheduler.js';
import type { LeafAgentRunner, SubAgentStartRequest } from './types.js';

const TERMINAL_STATES = new Set<SubAgentState>(['completed', 'failed', 'cancelled', 'timed_out']);

type LiveSubAgent = {
  snapshot: SubAgentSnapshot;
  controller: AbortController;
  done: Promise<void>;
  resolveDone: () => void;
  settled: boolean;
};

export type SubAgentManagerOptions = {
  maxPerSession?: number;
  retention?: number;
};

function copySnapshot(snapshot: SubAgentSnapshot): SubAgentSnapshot {
  return { ...snapshot, usage: { ...snapshot.usage } };
}

export class SubAgentManager {
  private readonly agents = new Map<string, LiveSubAgent>();
  private readonly maxPerSession: number;
  private readonly retention: number;

  constructor(
    private readonly runner: LeafAgentRunner,
    private readonly scheduler: AgentExecutionScheduler,
    private readonly emit: (event: OrchestrationEvent) => void,
    options: SubAgentManagerOptions = {}
  ) {
    this.maxPerSession = options.maxPerSession ?? 8;
    this.retention = options.retention ?? 32;
  }

  start(request: SubAgentStartRequest): SubAgentSnapshot {
    if ((request.depth ?? 0) >= 1) throw new Error('nested_subagent_forbidden: Nested sub-agents are not allowed.');
    const liveForSession = this.list(request.sessionId).filter((agent) => !TERMINAL_STATES.has(agent.state));
    if (liveForSession.length >= this.maxPerSession) {
      throw new Error(`subagent_limit_reached: A session may have at most ${this.maxPerSession} active sub-agents.`);
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
        model: request.model,
        usage: emptyUsage(),
        incomplete: false
      },
      controller: new AbortController(),
      done,
      resolveDone,
      settled: false
    };
    this.agents.set(id, live);
    this.notify(live);
    void this.execute(live, request);
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
    live.controller.abort();
    this.finish(live, 'cancelled', { stopReason: 'cancelled' });
    return copySnapshot(live.snapshot);
  }

  cancelSession(sessionId: string): void {
    for (const agent of this.agents.values()) {
      if (agent.snapshot.sessionId === sessionId) this.cancel(agent.snapshot.id);
    }
  }

  private async execute(live: LiveSubAgent, request: SubAgentStartRequest): Promise<void> {
    let release: (() => void) | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      release = await this.scheduler.acquire(live.controller.signal);
      if (live.settled) return;
      live.snapshot = { ...live.snapshot, state: 'running', startedAt: new Date().toISOString() };
      this.notify(live);
      timer = setTimeout(() => {
        timedOut = true;
        live.controller.abort();
      }, request.timeoutMs);
      const result = await this.runner.run({
        id: live.snapshot.id,
        sessionId: request.sessionId,
        workingDirectory: request.workingDirectory,
        task: request.task,
        profile: request.profile,
        providerId: request.providerId,
        model: request.model,
        maxIterations: request.maxIterations ?? 8,
        timeoutMs: request.timeoutMs
      }, live.controller.signal, (event) => {
        if (event.type !== 'usage' || live.settled) return;
        accrueUsage(live.snapshot.usage, event);
        this.notify(live);
      });
      if (live.settled) return;
      if (timedOut) this.finish(live, 'timed_out', { stopReason: 'timeout', result: result.result, incomplete: true, usage: result.usage });
      else if (result.stopReason === 'cancelled') this.finish(live, 'cancelled', { stopReason: result.stopReason, result: result.result, incomplete: true, usage: result.usage });
      else this.finish(live, 'completed', result);
    } catch (error) {
      if (live.settled) return;
      if (timedOut) this.finish(live, 'timed_out', { stopReason: 'timeout', error: 'Sub-agent timed out.', incomplete: true });
      else if (live.controller.signal.aborted) this.finish(live, 'cancelled', { stopReason: 'cancelled' });
      else this.finish(live, 'failed', { error: error instanceof Error ? error.message : String(error), incomplete: true });
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
    }
  }

  private finish(
    live: LiveSubAgent,
    state: Extract<SubAgentState, 'completed' | 'failed' | 'cancelled' | 'timed_out'>,
    values: { stopReason?: string; result?: string; error?: string; incomplete?: boolean; usage?: SubAgentSnapshot['usage'] }
  ): void {
    if (live.settled) return;
    live.settled = true;
    live.snapshot = {
      ...live.snapshot,
      state,
      finishedAt: new Date().toISOString(),
      ...(values.stopReason ? { stopReason: values.stopReason } : {}),
      ...(values.result ? { result: values.result } : {}),
      ...(values.error ? { error: values.error } : {}),
      ...(values.usage ? { usage: { ...values.usage } } : {}),
      incomplete: values.incomplete ?? false
    };
    this.notify(live);
    live.resolveDone();
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

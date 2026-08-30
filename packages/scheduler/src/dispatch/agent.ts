import type { AgentRuntime, RunHandle } from '@desktop-agent/agent-runtime';
import type { ScheduleTargetValidator } from '../service.js';
import type { AgentScheduleTarget } from '../types.js';
import type {
  ScheduleDispatchRequest,
  TargetExecutionEvent,
  TargetExecutionReference,
  TargetExecutionSnapshot,
  TypedScheduleTargetDispatcher
} from './dispatcher.js';

const PREVIEW_LIMIT = 4_096;

function preview(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= PREVIEW_LIMIT ? value : value.slice(0, PREVIEW_LIMIT);
}

export class AgentScheduleDispatcher implements TypedScheduleTargetDispatcher<AgentScheduleTarget> {
  readonly kind = 'agent' as const;
  readonly idempotent = true;
  private readonly handles = new Map<string, RunHandle>();
  private readonly states = new Map<string, TargetExecutionSnapshot>();
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();
  private readonly unsubscribeRuntime: () => void;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly options: {
      prepare?: (
        input: ScheduleDispatchRequest<AgentScheduleTarget>,
        laneId: string
      ) => Promise<{ dispose(): void } | void>;
    } = {}
  ) {
    this.unsubscribeRuntime = runtime.subscribe((envelope) => {
      if (!envelope.runId) return;
      const current = this.states.get(envelope.runId);
      if (!current) return;
      if (envelope.event.type === 'approval.required') {
        this.publish({ ...current, state: 'waiting_approval' });
      } else if (envelope.event.type === 'run.resumed' || envelope.event.type === 'tool.started') {
        this.publish({ ...current, state: 'running' });
      }
    });
  }

  async dispatch(input: ScheduleDispatchRequest<AgentScheduleTarget>): Promise<TargetExecutionSnapshot> {
    const existing = await this.inspect({ kind: 'agent', id: input.executionId });
    if (existing) return existing;
    const laneId = input.target.lane?.mode === 'main'
      ? 'main'
      : input.target.lane?.id ?? `schedule:${input.schedule.id}`;
    const prepared = await this.options.prepare?.(input, laneId);
    let handle: RunHandle;
    try {
      const session = await this.runtime.getSession(input.target.sessionId);
      if (!session) throw new Error(`schedule_target_not_found: Session ${input.target.sessionId} does not exist.`);
      const lanes = await session.listLanes();
      const lane = lanes.some((item) => item.id === laneId)
        ? await session.getLane(laneId)
        : await session.createLane({ id: laneId, parentLaneId: 'main' });
      handle = await lane.run({
        runId: input.executionId,
        input: input.target.input,
        providerId: input.target.providerId,
        model: input.target.model,
        actor: { kind: 'main' },
        trigger: { kind: 'scheduler', id: input.run.id },
        ...(input.target.instructions ? { instructions: input.target.instructions } : {}),
        ...(input.target.budget ? { budget: input.target.budget } : {})
      });
    } catch (error) {
      prepared?.dispose();
      throw error;
    }
    this.handles.set(handle.id, handle);
    const running: TargetExecutionSnapshot = { kind: 'agent', id: handle.id, state: 'running' };
    this.states.set(handle.id, running);
    void handle.result.then((result) => {
      const finalPreview = preview(result.finalText);
      const snapshot: TargetExecutionSnapshot = result.status === 'completed'
        ? { kind: 'agent', id: handle.id, state: 'completed', ...(finalPreview ? { resultPreview: finalPreview } : {}) }
        : result.status === 'cancelled'
          ? { kind: 'agent', id: handle.id, state: 'cancelled' }
          : {
              kind: 'agent', id: handle.id, state: 'failed',
              ...(result.error?.code ? { errorCode: result.error.code } : {}),
              ...(result.error?.message ? { error: result.error.message } : {})
            };
      this.publish(snapshot);
    }).finally(() => {
      this.handles.delete(handle.id);
      prepared?.dispose();
    }).catch(() => undefined);
    return running;
  }

  async inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    const live = this.states.get(reference.id);
    if (live && this.handles.has(reference.id)) return { ...live };
    const snapshot = await this.runtime.inspectRun(reference.id);
    if (!snapshot) return live ? { ...live } : undefined;
    const finalPreview = preview(snapshot.result?.finalText);
    const mapped: TargetExecutionSnapshot = snapshot.status === 'completed'
      ? { kind: 'agent', id: reference.id, state: 'completed', ...(finalPreview ? { resultPreview: finalPreview } : {}) }
      : snapshot.status === 'failed'
        ? {
            kind: 'agent', id: reference.id, state: 'failed',
            ...(snapshot.result?.error?.code ? { errorCode: snapshot.result.error.code } : {}),
            ...(snapshot.result?.error?.message ? { error: snapshot.result.error.message } : {})
          }
        : snapshot.status === 'cancelled'
          ? { kind: 'agent', id: reference.id, state: 'cancelled' }
          : snapshot.status === 'suspended'
            ? { kind: 'agent', id: reference.id, state: 'interrupted', errorCode: 'runtime_suspended' }
            : live?.state === 'waiting_approval'
              ? { ...live }
              : { kind: 'agent', id: reference.id, state: 'running' };
    this.states.set(reference.id, mapped);
    return { ...mapped };
  }

  async cancel(reference: TargetExecutionReference): Promise<void> {
    const handle = this.handles.get(reference.id);
    if (!handle) throw new Error(`schedule_run_not_cancellable: ${reference.id}`);
    await handle.cancel('schedule_cancelled');
  }

  subscribe(listener: (event: TargetExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribeRuntime();
    this.listeners.clear();
  }

  private publish(snapshot: TargetExecutionSnapshot): void {
    this.states.set(snapshot.id, snapshot);
    for (const listener of this.listeners) {
      try { listener({ snapshot: { ...snapshot } }); } catch { /* Observers are isolated. */ }
    }
  }
}

export class AgentScheduleTargetValidator implements ScheduleTargetValidator {
  constructor(private readonly runtime: AgentRuntime) {}

  async validate(target: import('../types.js').ScheduleTarget): Promise<void> {
    if (target.kind !== 'agent') return;
    const session = await this.runtime.getSession(target.sessionId);
    if (!session) throw new Error(`schedule_target_not_found: Session ${target.sessionId} does not exist.`);
    if (target.lane?.id && target.lane.mode === 'main') {
      throw new Error('schedule_target_invalid: A main lane target cannot specify a custom lane id.');
    }
    await session.listLanes();
  }
}

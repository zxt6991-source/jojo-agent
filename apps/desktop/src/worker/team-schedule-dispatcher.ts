import type { OrchestrationEvent, TeamTaskSnapshot } from '@desktop-agent/contracts';
import type { TeamManager } from '@desktop-agent/orchestration';
import type {
  ScheduleDispatchRequest,
  TargetExecutionEvent,
  TargetExecutionReference,
  TargetExecutionSnapshot,
  TeamMemberScheduleTarget,
  TypedScheduleTargetDispatcher
} from '@desktop-agent/scheduler';

const PREVIEW_LIMIT = 4_096;

function taskSnapshot(task: TeamTaskSnapshot): TargetExecutionSnapshot {
  const state = task.state === 'queued' ? 'queued' : task.state;
  return {
    kind: 'team_member',
    id: task.id,
    state,
    ...(task.result ? { resultPreview: task.result.slice(0, PREVIEW_LIMIT) } : {}),
    ...(task.errorCode ? { errorCode: task.errorCode } : {}),
    ...(task.error ? { error: task.error } : {})
  };
}

export class TeamMemberScheduleDispatcher implements TypedScheduleTargetDispatcher<TeamMemberScheduleTarget> {
  readonly kind = 'team_member' as const;
  readonly idempotent = true;
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();
  private readonly unsubscribeOrchestration: () => void;

  constructor(
    private readonly manager: TeamManager,
    subscribeOrchestration: (listener: (event: OrchestrationEvent) => void) => () => void
  ) {
    this.unsubscribeOrchestration = subscribeOrchestration((event) => {
      if (event.type !== 'team.task.changed') return;
      this.publish(taskSnapshot(event.task));
    });
  }

  async dispatch(input: ScheduleDispatchRequest<TeamMemberScheduleTarget>): Promise<TargetExecutionSnapshot> {
    const existing = await this.manager.getTask(input.executionId);
    if (existing) return taskSnapshot(existing);
    const task = await this.manager.delegate({
      taskId: input.executionId,
      teamId: input.target.teamId,
      memberId: input.target.memberId,
      task: input.target.task,
      parent: { sessionId: input.target.parentSessionId, runId: input.run.id },
      ...(input.target.providerId ? { providerId: input.target.providerId } : {}),
      ...(input.target.model ? { model: input.target.model } : {}),
      ...(input.target.timeoutMs !== undefined ? { timeoutMs: input.target.timeoutMs } : {}),
      ...(input.target.maxIterations !== undefined ? { maxIterations: input.target.maxIterations } : {}),
      ...(input.target.outputSchema ? { outputSchema: input.target.outputSchema } : {})
    });
    return taskSnapshot(task);
  }

  async inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    const task = await this.manager.getTask(reference.id);
    return task ? taskSnapshot(task) : undefined;
  }

  async cancel(reference: TargetExecutionReference): Promise<void> {
    await this.manager.cancel(reference.id);
  }

  subscribe(listener: (event: TargetExecutionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.unsubscribeOrchestration();
    this.listeners.clear();
  }

  private publish(snapshot: TargetExecutionSnapshot): void {
    for (const listener of this.listeners) {
      try { listener({ snapshot }); } catch { /* Observers are isolated. */ }
    }
  }
}

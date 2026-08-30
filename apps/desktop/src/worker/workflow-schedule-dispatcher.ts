import type { OrchestrationEvent, WorkflowRunSnapshot } from '@desktop-agent/contracts';
import type { WorkflowManager } from '@desktop-agent/orchestration';
import type {
  ScheduleDispatchRequest,
  TargetExecutionEvent,
  TargetExecutionReference,
  TargetExecutionSnapshot,
  TypedScheduleTargetDispatcher,
  WorkflowScheduleTarget
} from '@desktop-agent/scheduler';

const PREVIEW_LIMIT = 4_096;

function workflowSnapshot(workflow: WorkflowRunSnapshot): TargetExecutionSnapshot {
  const state = workflow.state === 'timed_out'
    ? 'failed'
    : workflow.state === 'suspended'
      ? 'interrupted'
      : workflow.state;
  return {
    kind: 'workflow',
    id: workflow.id,
    state,
    ...(workflow.result ? { resultPreview: workflow.result.slice(0, PREVIEW_LIMIT) } : {}),
    ...(workflow.errorCode ? { errorCode: workflow.errorCode } : {}),
    ...(workflow.error ? { error: workflow.error } : {})
  };
}

export class WorkflowScheduleDispatcher implements TypedScheduleTargetDispatcher<WorkflowScheduleTarget> {
  readonly kind = 'workflow' as const;
  readonly idempotent = true;
  private readonly listeners = new Set<(event: TargetExecutionEvent) => void>();
  private readonly unsubscribeOrchestration: () => void;

  constructor(
    private readonly manager: WorkflowManager,
    subscribeOrchestration: (listener: (event: OrchestrationEvent) => void) => () => void
  ) {
    this.unsubscribeOrchestration = subscribeOrchestration((event) => {
      if (event.type === 'workflow.changed') this.publish(workflowSnapshot(event.workflow));
    });
  }

  async dispatch(input: ScheduleDispatchRequest<WorkflowScheduleTarget>): Promise<TargetExecutionSnapshot> {
    const existing = this.manager.get(input.executionId);
    if (existing) return workflowSnapshot(existing);
    const workflow = this.manager.start({
      id: input.executionId,
      sessionId: input.target.sessionId,
      workingDirectory: input.target.workingDirectory,
      providerId: input.target.providerId,
      model: input.target.model,
      ...(input.target.workflow.kind === 'saved'
        ? { name: input.target.workflow.name }
        : { definition: input.target.workflow.definition }),
      ...(input.target.workflow.args ? { args: input.target.workflow.args } : {})
    });
    return workflowSnapshot(workflow);
  }

  async inspect(reference: TargetExecutionReference): Promise<TargetExecutionSnapshot | undefined> {
    const workflow = this.manager.get(reference.id);
    return workflow ? workflowSnapshot(workflow) : undefined;
  }

  async cancel(reference: TargetExecutionReference): Promise<void> {
    this.manager.cancel(reference.id);
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

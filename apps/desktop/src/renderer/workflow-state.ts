import type { WorkflowRunSnapshot, WorkflowRunState, WorkflowStepState } from '@desktop-agent/contracts';

export function mergeWorkflowSnapshot(
  workflows: WorkflowRunSnapshot[],
  incoming: WorkflowRunSnapshot
): WorkflowRunSnapshot[] {
  const current = workflows.find((workflow) => workflow.id === incoming.id);
  if (current && incoming.revision <= current.revision) return workflows;
  const next = current
    ? workflows.map((workflow) => workflow.id === incoming.id ? incoming : workflow)
    : [...workflows, incoming];
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function workflowsForSession(workflows: WorkflowRunSnapshot[], sessionId: string | null): WorkflowRunSnapshot[] {
  return sessionId ? workflows.filter((workflow) => workflow.sessionId === sessionId) : [];
}

export function workflowStateLabel(state: WorkflowRunState): string {
  return {
    running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消',
    timed_out: '已超时', interrupted: '已中断'
  }[state];
}

export function workflowStepStateLabel(state: WorkflowStepState): string {
  return {
    pending: '等待中', queued: '排队中', running: '运行中', completed: '已完成', failed: '失败',
    cancelled: '已取消', timed_out: '已超时', blocked: '已阻塞', interrupted: '已中断'
  }[state];
}

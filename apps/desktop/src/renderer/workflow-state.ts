import type { WorkflowRunSnapshot, WorkflowRunState, WorkflowStepState } from '@desktop-agent/contracts';
import type { ConversationTurn } from './conversation';

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

export function workflowsByConversationTurn(
  workflows: WorkflowRunSnapshot[],
  turns: ConversationTurn[]
): Map<string, WorkflowRunSnapshot[]> {
  const grouped = new Map<string, WorkflowRunSnapshot[]>();
  const datedTurns = turns.flatMap((turn) => {
    if (!turn.startedAt) return [];
    const timestamp = Date.parse(turn.startedAt);
    return Number.isFinite(timestamp) ? [{ turn, timestamp }] : [];
  });
  for (const workflow of workflows) {
    const createdAt = Date.parse(workflow.createdAt);
    let owner = datedTurns[0]?.turn;
    for (const candidate of datedTurns) {
      if (candidate.timestamp > createdAt) break;
      owner = candidate.turn;
    }
    if (!owner) continue;
    const current = grouped.get(owner.id) ?? [];
    current.push(workflow);
    grouped.set(owner.id, current);
  }
  return grouped;
}

export function workflowStateLabel(state: WorkflowRunState): string {
  return {
    running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消',
    timed_out: '已超时', interrupted: '已中断', suspended: '待人工恢复'
  }[state];
}

export function workflowStepStateLabel(state: WorkflowStepState): string {
  return {
    pending: '等待中', queued: '排队中', running: '运行中', completed: '已完成', failed: '失败',
    cancelled: '已取消', timed_out: '已超时', blocked: '已阻塞', interrupted: '已中断', skipped: '已跳过'
  }[state];
}

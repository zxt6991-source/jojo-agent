import { describe, expect, it } from 'vitest';
import type { WorkflowRunSnapshot } from '@desktop-agent/contracts';
import { emptyUsage } from '@desktop-agent/orchestration';
import {
  mergeWorkflowSnapshot,
  workflowsByConversationTurn,
  workflowsForSession,
  workflowStateLabel,
  workflowStepStateLabel
} from './workflow-state';

function snapshot(id: string, sessionId: string, revision: number): WorkflowRunSnapshot {
  const createdAt = new Date(1_700_000_000_000 + Number(id.slice(-1)) * 1_000).toISOString();
  return {
    id, sessionId, name: id, state: 'running', revision, createdAt, startedAt: createdAt,
    steps: [], usage: emptyUsage(), failedStepIds: [], blockedStepIds: [], incomplete: false
  };
}

describe('workflow renderer state', () => {
  it('adds workflows and replaces them only with a newer revision', () => {
    const first = snapshot('wf_1', 'session', 1);
    const stale = { ...first, revision: 1, state: 'failed' as const };
    const newer = { ...first, revision: 2, state: 'completed' as const };
    expect(mergeWorkflowSnapshot([first], stale)).toEqual([first]);
    expect(mergeWorkflowSnapshot([first], newer)[0]).toMatchObject({ revision: 2, state: 'completed' });
  });

  it('keeps deterministic creation order and filters by session', () => {
    const later = snapshot('wf_2', 'b', 1);
    const earlier = snapshot('wf_1', 'a', 1);
    const merged = mergeWorkflowSnapshot([later], earlier);
    expect(merged.map((workflow) => workflow.id)).toEqual(['wf_1', 'wf_2']);
    expect(workflowsForSession(merged, 'b')).toEqual([later]);
    expect(workflowsForSession(merged, null)).toEqual([]);
  });

  it('keeps workflows attached to the user turn in which they were created', () => {
    const first = snapshot('wf_1', 'session', 1);
    const second = snapshot('wf_2', 'session', 1);
    const turns = [
      { id: 'turn-1', index: 1, startedAt: '2023-11-14T22:13:19.000Z', nodes: [] },
      { id: 'turn-2', index: 2, startedAt: '2023-11-14T22:13:21.500Z', nodes: [] }
    ];

    const grouped = workflowsByConversationTurn([first, second], turns);

    expect(grouped.get('turn-1')?.map((workflow) => workflow.id)).toEqual(['wf_1']);
    expect(grouped.get('turn-2')?.map((workflow) => workflow.id)).toEqual(['wf_2']);
  });

  it('provides labels for every workflow state used by cards', () => {
    expect(workflowStateLabel('timed_out')).toBe('已超时');
    expect(workflowStepStateLabel('blocked')).toBe('已阻塞');
  });
});

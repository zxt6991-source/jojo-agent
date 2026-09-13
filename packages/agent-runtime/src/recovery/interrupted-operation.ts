import { createToolMessage } from '@desktop-agent/agent';
import type { StoredOperation } from '../operation/meta.js';
import { isTerminalState } from '../operation/state.js';
import type { AgentRuntimeStore } from '../store.js';
import type { LaneState, SessionEntry } from '../session/types.js';

export type RecoveryOutcome = {
  operationId: string;
  sessionId: string;
  laneId: string;
  status: 'interrupted' | 'already_terminal' | 'conflict';
  uncertainToolCallIds: string[];
  errorCode?: string;
};
export type RuntimeRecoveryReport = { outcomes: RecoveryOutcome[]; ready: boolean };
export type InterruptOperationRequest = {
  operationId: string;
  reason: 'host_restart' | 'resume_unavailable';
};

export async function interruptStoredOperation(
  store: AgentRuntimeStore, operation: StoredOperation, lane: LaneState, reason: InterruptOperationRequest['reason']
): Promise<RecoveryOutcome> {
  const { meta, state } = operation;
  const outcome: RecoveryOutcome = {
    operationId: meta.id, sessionId: lane.sessionId, laneId: lane.name,
    status: 'interrupted', uncertainToolCallIds: []
  };
  const conflict = (errorCode: string): RecoveryOutcome => ({ ...outcome, status: 'conflict', errorCode });
  if (meta.id !== state.operationId || meta.sessionId !== lane.sessionId || meta.lane !== lane.name || state.lane !== lane.name) {
    return conflict('runtime_operation_identity_conflict');
  }
  if (isTerminalState(state) && lane.currentOperationId !== meta.id) return { ...outcome, status: 'already_terminal' };
  if (lane.currentOperationId !== meta.id) return conflict('runtime_operation_owner_conflict');
  try {
    if (!isTerminalState(state)) {
      let path = await store.readPath(lane.leafId);
      if (path.some(entry => entry.sessionId !== meta.sessionId)) throw new Error('runtime_transcript_conflict');
      const connect = async (entry: SessionEntry) => {
        if (entry.sessionId !== meta.sessionId) throw new Error('runtime_transcript_conflict');
        if (path.some(item => item.id === entry.id)) return;
        if (entry.parentId !== lane.leafId) throw new Error('runtime_transcript_conflict');
        lane = { ...lane, leafId: entry.id };
        await store.saveLane(lane);
        path = [...path, entry];
      };
      const assistantId = state.phase === 'tools' ? state.assistantEntryId
        : state.phase === 'model_pending' ? state.responseEntryId : undefined;
      const assistant = assistantId ? await store.getEntry(assistantId) : null;
      if (state.phase === 'tools' && !assistant) throw new Error('runtime_transcript_conflict');
      if (assistant) {
        if (assistant.type !== 'message' || assistant.message.role !== 'assistant') throw new Error('runtime_transcript_conflict');
        await connect(assistant);
        const calls = assistant.message.content.flatMap(block => block.type === 'tool_call' ? [block.call] : []);
        if (state.phase === 'tools' && (calls.length !== state.calls.length || state.calls.some(call => !calls.some(item => item.id === call.callId && item.name === call.toolName)))) {
          throw new Error('runtime_transcript_conflict');
        }
        for (const call of calls) {
          const execution = state.phase === 'tools' ? state.calls.find(item => item.callId === call.id) : undefined;
          const id = execution?.resultEntryId ?? `${meta.id}:recovery:${assistant.id}:${call.id}`;
          let entry = await store.getEntry(id);
          if (entry) {
            if (entry.type !== 'message' || entry.message.role !== 'tool' || entry.message.content.length !== 1
              || !entry.message.content.some(block => block.type === 'tool_result' && block.result.callId === call.id)) {
              throw new Error('runtime_transcript_conflict');
            }
          } else {
            if (execution?.status === 'completed') throw new Error('runtime_transcript_conflict');
            const uncertain = execution?.status === 'effect_pending';
            entry = await store.appendEntry({
              id, sessionId: meta.sessionId, parentId: lane.leafId, type: 'message',
              message: createToolMessage({ callId: call.id, ok: false,
                code: uncertain ? 'interrupted_uncertain_effect' : 'interrupted_before_execution',
                content: uncertain ? 'Execution was interrupted; external effects and outcome are unknown.'
                  : 'Execution was interrupted before durable evidence of tool execution.'
              }, id)
            });
          }
          if (entry.type === 'message' && entry.message.content.some(block => block.type === 'tool_result' && block.result.code === 'interrupted_uncertain_effect')) {
            outcome.uncertainToolCallIds.push(call.id);
          }
          await connect(entry);
        }
      }
    }
    await store.saveOperationState(isTerminalState(state) ? state : {
      phase: 'failed', operationId: meta.id, lane: meta.lane,
      error: { code: 'runtime_interrupted', message: `Runtime execution interrupted: ${reason}.`,
        detail: { reason, originalPhase: state.phase, leafId: lane.leafId, uncertainToolCallIds: outcome.uncertainToolCallIds } }
    }, { expectedState: state, expectedLaneOperationId: meta.id });
    return { ...outcome, status: isTerminalState(state) ? 'already_terminal' : 'interrupted' };
  } catch (error) {
    if (error instanceof Error && error.message === 'runtime_operation_conflict') {
      const current = await store.loadOperation(meta.id);
      const currentLane = await store.getLane(meta.sessionId, meta.lane);
      if (current && isTerminalState(current.state) && currentLane?.currentOperationId !== meta.id) {
        return { ...outcome, status: 'already_terminal' };
      }
    }
    if (error instanceof Error && ['runtime_transcript_conflict', 'runtime_operation_conflict'].includes(error.message)) return conflict(error.message);
    throw error;
  }
}

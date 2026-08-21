import type { ApprovalRequest, ToolCall, ToolResult } from '@desktop-agent/contracts';
import { OperationInvariantError, assertOperationState } from './invariants.js';
import {
  emptyProgressState,
  isTerminalState,
  type CheckpointState,
  type FinalResponseReason,
  type FinalResponseState,
  type ModelPendingState,
  type OperationState,
  type ProgressState,
  type ReadyState,
  type ReplayPolicy,
  type ToolsState
} from './state.js';

function assertMutable(state: OperationState): void {
  if (isTerminalState(state)) {
    throw new OperationInvariantError(`Terminal operation ${state.operationId} cannot transition.`);
  }
}

export function createReadyState(operationId: string, lane = 'main'): ReadyState {
  return {
    phase: 'ready', operationId, lane, iteration: 0, outputContinuations: 0,
    progress: emptyProgressState()
  };
}

export function beginModelRequest(
  state: ReadyState | CheckpointState | FinalResponseState | ModelPendingState,
  input: {
    responseEntryId: string;
    usageId: string;
    providerId: string;
    model: string;
    toolNames: string[];
    maxOutputTokens: number;
    finalResponseOnly: boolean;
  }
): ModelPendingState {
  assertMutable(state);
  const next: ModelPendingState = {
    phase: 'model_pending', operationId: state.operationId, lane: state.lane,
    iteration: state.iteration, outputContinuations: state.outputContinuations,
    progress: state.progress, responseEntryId: input.responseEntryId, usageId: input.usageId,
    request: {
      providerId: input.providerId,
      model: input.model,
      toolNames: [...input.toolNames],
      maxOutputTokens: input.maxOutputTokens,
      finalResponseOnly: input.finalResponseOnly
    },
    attempt: state.phase === 'model_pending' ? state.attempt + 1 : 1
  };
  assertOperationState(next);
  return next;
}

export function planToolCalls(
  state: ModelPendingState,
  assistantEntryId: string,
  calls: ToolCall[],
  replayFor: (toolName: string) => ReplayPolicy,
  nextId: () => string
): ToolsState {
  const next: ToolsState = {
    phase: 'tools', operationId: state.operationId, lane: state.lane,
    iteration: state.iteration, outputContinuations: state.outputContinuations,
    progress: state.progress, assistantEntryId, currentIndex: 0,
    noProgressDetected: false, finalResponseOnly: state.request.finalResponseOnly,
    calls: calls.map((call, toolIndex) => ({
      toolIndex, callId: call.id, toolName: call.name, input: call.input,
      resultEntryId: nextId(), replay: replayFor(call.name),
      permission: 'pending', status: 'planned'
    }))
  };
  assertOperationState(next);
  return next;
}

function replaceCurrentCall(
  state: ToolsState,
  update: (call: ToolsState['calls'][number]) => ToolsState['calls'][number]
): ToolsState {
  assertMutable(state);
  const current = state.calls[state.currentIndex];
  if (!current) throw new OperationInvariantError('There is no current tool call to update.');
  const calls = [...state.calls];
  calls[state.currentIndex] = update(current);
  const next = { ...state, calls };
  assertOperationState(next);
  return next;
}

export function prepareToolEffect(state: ToolsState, callId: string): ToolsState {
  return replaceCurrentCall(state, (call) => {
    if (call.callId !== callId) throw new OperationInvariantError(`Unexpected tool call: ${callId}`);
    if (call.status !== 'planned') throw new OperationInvariantError(`Tool ${callId} is not planned.`);
    if (call.permission !== 'approved' && call.permission !== 'hook_approved' && call.permission !== 'not_required') {
      throw new OperationInvariantError(`Tool ${callId} does not have permission.`);
    }
    return { ...call, status: 'effect_pending' };
  });
}

export function resolveToolPermission(
  state: ToolsState,
  callId: string,
  permission: 'not_required' | 'pending' | 'approved' | 'hook_approved',
  approvalRequest?: ApprovalRequest
): ToolsState {
  return replaceCurrentCall(state, (call) => {
    if (call.callId !== callId) throw new OperationInvariantError(`Unexpected tool call: ${callId}`);
    if (call.status !== 'planned') throw new OperationInvariantError(`Tool ${callId} is not awaiting permission.`);
    return {
      ...call,
      permission,
      ...(approvalRequest ? { approvalRequest } : {})
    };
  });
}

export function settleToolWithoutEffect(
  state: ToolsState,
  callId: string,
  result: ToolResult,
  permission: 'denied' = 'denied'
): ToolsState {
  return replaceCurrentCall(state, (call) => {
    if (call.callId !== callId) throw new OperationInvariantError(`Unexpected tool call: ${callId}`);
    if (call.status !== 'planned') throw new OperationInvariantError(`Tool ${callId} is not planned.`);
    return { ...call, permission, status: 'completed', result };
  });
}

export function settleToolEffect(state: ToolsState, callId: string, result: ToolResult): ToolsState {
  return replaceCurrentCall(state, (call) => {
    if (call.callId !== callId) throw new OperationInvariantError(`Unexpected tool call: ${callId}`);
    if (call.status !== 'effect_pending' && call.status !== 'interrupted') {
      throw new OperationInvariantError(`Tool ${callId} has no pending effect.`);
    }
    return { ...call, status: 'completed', result };
  });
}

export function markToolInterrupted(state: ToolsState, callId: string): ToolsState {
  return replaceCurrentCall(state, (call) => {
    if (call.callId !== callId) throw new OperationInvariantError(`Unexpected tool call: ${callId}`);
    if (call.status !== 'effect_pending') throw new OperationInvariantError(`Tool ${callId} has no pending effect.`);
    return { ...call, status: 'interrupted' };
  });
}

function nextProgress(state: ToolsState): ProgressState {
  const progress = { ...state.progress };
  if (state.noProgressDetected && progress.recoveryStepsRemaining === null) {
    progress.recoveryStepsRemaining = 2;
  } else if (progress.recoveryStepsRemaining !== null) {
    progress.recoveryStepsRemaining -= 1;
  }
  return progress;
}

export function advanceTool(state: ToolsState): ToolsState | CheckpointState {
  assertMutable(state);
  const current = state.calls[state.currentIndex];
  if (current && current.status !== 'completed') {
    throw new OperationInvariantError(`Tool ${current.callId} must settle before advancing.`);
  }
  if (state.currentIndex + 1 < state.calls.length) {
    const next = { ...state, currentIndex: state.currentIndex + 1 };
    assertOperationState(next);
    return next;
  }
  const next: CheckpointState = {
    phase: 'checkpoint', operationId: state.operationId, lane: state.lane,
    iteration: state.iteration + 1, outputContinuations: 0, progress: nextProgress(state)
  };
  assertOperationState(next);
  return next;
}

export function continueOutput(
  state: ModelPendingState,
  finalResponseOnly: boolean
): ReadyState | FinalResponseState {
  const shared = {
    operationId: state.operationId,
    lane: state.lane,
    iteration: state.iteration + 1,
    outputContinuations: state.outputContinuations + 1,
    progress: state.progress
  };
  return finalResponseOnly
    ? { phase: 'final_response', ...shared, reason: 'no_progress' }
    : { phase: 'ready', ...shared };
}

export function enterFinalResponse(
  state: CheckpointState,
  reason: FinalResponseReason
): FinalResponseState {
  return { ...state, phase: 'final_response', reason };
}

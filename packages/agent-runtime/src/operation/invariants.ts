import { isTerminalState, type OperationState, type ToolsState } from './state.js';

export class OperationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationInvariantError';
  }
}

function assertToolsState(state: ToolsState): void {
  if (!Number.isInteger(state.currentIndex) || state.currentIndex < 0 || state.currentIndex > state.calls.length) {
    throw new OperationInvariantError('Tool cursor is outside the planned call range.');
  }
  const callIds = new Set<string>();
  for (const [index, call] of state.calls.entries()) {
    if (call.toolIndex !== index) throw new OperationInvariantError('Tool indexes must be contiguous and ordered.');
    if (callIds.has(call.callId)) throw new OperationInvariantError(`Duplicate tool call id: ${call.callId}`);
    callIds.add(call.callId);
    if (!call.resultEntryId) throw new OperationInvariantError(`Tool ${call.callId} has no reserved result entry id.`);
    if (call.status === 'completed' && !call.result) {
      throw new OperationInvariantError(`Completed tool ${call.callId} has no result.`);
    }
    if (call.status !== 'completed' && call.result) {
      throw new OperationInvariantError(`Unsettled tool ${call.callId} already has a result.`);
    }
    if (call.status === 'effect_pending' && call.permission !== 'approved' && call.permission !== 'hook_approved' && call.permission !== 'not_required') {
      throw new OperationInvariantError(`Tool ${call.callId} has an effect pending without permission.`);
    }
    if (call.permission === 'denied' && call.status !== 'completed') {
      throw new OperationInvariantError(`Denied tool ${call.callId} is not settled.`);
    }
    if (call.approvalRequest && call.permission !== 'pending' && call.permission !== 'approved' && call.permission !== 'hook_approved' && call.permission !== 'denied') {
      throw new OperationInvariantError(`Tool ${call.callId} has an approval request in an invalid permission state.`);
    }
  }
}

export function assertOperationState(state: OperationState): void {
  if (!state.operationId) throw new OperationInvariantError('Operation id is required.');
  if (!state.lane) throw new OperationInvariantError('Lane name is required.');
  if ('iteration' in state && (!Number.isInteger(state.iteration) || state.iteration < 0)) {
    throw new OperationInvariantError('Iteration must be a non-negative integer.');
  }
  if (state.phase === 'tools') assertToolsState(state);
  if (isTerminalState(state) && state.phase === 'completed' && state.finalEntryId === undefined) {
    throw new OperationInvariantError('Completed operations must define their final entry id.');
  }
}

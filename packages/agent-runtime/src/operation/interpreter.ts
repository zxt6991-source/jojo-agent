import type { AgentAction } from './actions.js';
import { isTerminalState, type OperationState } from './state.js';

export type InterpreterContext = {
  maxIterations: number;
  recovering?: boolean;
};

export interface AgentInterpreter {
  peekAction(state: OperationState, context: InterpreterContext): AgentAction | undefined;
}

function toolAction(state: Extract<OperationState, { phase: 'tools' }>, recovering: boolean): AgentAction {
  const call = state.calls[state.currentIndex];
  if (!call) return { type: 'advance_tool' };

  if (call.status === 'completed') return { type: 'advance_tool' };
  if (call.status === 'interrupted') {
    return { type: 'synthesize_interrupted_tool_result', callId: call.callId };
  }
  if (call.permission === 'pending') return { type: 'request_approval', callId: call.callId };
  if (call.status === 'planned') return { type: 'prepare_tool_effect', callId: call.callId };
  if (recovering && call.replay === 'never') {
    return { type: 'synthesize_interrupted_tool_result', callId: call.callId };
  }
  return { type: 'execute_tool', callId: call.callId };
}

export const defaultAgentInterpreter: AgentInterpreter = {
  peekAction(state, context) {
    if (isTerminalState(state) || state.phase === 'suspended') return undefined;

    switch (state.phase) {
      case 'ready':
        return state.iteration >= context.maxIterations ? { type: 'finish' } : { type: 'request_model' };
      case 'model_pending':
        return state.request.finalResponseOnly
          ? { type: 'request_model_without_tools' }
          : { type: 'request_model' };
      case 'tools':
        return toolAction(state, context.recovering ?? false);
      case 'checkpoint':
        if (state.progress.recoveryStepsRemaining === 0) return { type: 'request_model_without_tools' };
        return state.iteration >= context.maxIterations ? { type: 'finish' } : { type: 'request_model' };
      case 'final_response':
        return state.iteration > context.maxIterations
          ? { type: 'finish' }
          : { type: 'request_model_without_tools' };
    }
  }
};

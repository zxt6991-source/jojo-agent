import type { ApprovalRequest, ToolResult } from '@desktop-agent/contracts';

export type ReplayPolicy = 'safe' | 'never';

export type ProgressState = {
  toolCallCounts: Record<string, number>;
  observationFingerprints: string[];
  recoveryStepsRemaining: number | null;
};

type OperationCursor = {
  operationId: string;
  lane: string;
  iteration: number;
};

type RunningState = OperationCursor & {
  outputContinuations: number;
  progress: ProgressState;
};

export type ReadyState = RunningState & {
  phase: 'ready';
};

export type ModelPendingState = RunningState & {
  phase: 'model_pending';
  responseEntryId: string;
  usageId: string;
  request: {
    providerId: string;
    model: string;
    toolNames: string[];
    maxOutputTokens: number;
    finalResponseOnly: boolean;
  };
  attempt: number;
};

export type ToolPermissionState = 'not_required' | 'pending' | 'approved' | 'denied';
export type ToolEffectStatus = 'planned' | 'effect_pending' | 'completed' | 'interrupted';

export type ToolCallExecutionState = {
  toolIndex: number;
  callId: string;
  toolName: string;
  input: unknown;
  resultEntryId: string;
  replay: ReplayPolicy;
  permission: ToolPermissionState;
  approvalRequest?: ApprovalRequest;
  status: ToolEffectStatus;
  result?: ToolResult;
};

export type ToolsState = RunningState & {
  phase: 'tools';
  assistantEntryId: string;
  calls: ToolCallExecutionState[];
  currentIndex: number;
  noProgressDetected: boolean;
  finalResponseOnly: boolean;
};

export type CheckpointState = RunningState & {
  phase: 'checkpoint';
};

export type FinalResponseReason = 'no_progress' | 'max_iterations' | 'tool_disabled';

export type FinalResponseState = RunningState & {
  phase: 'final_response';
  reason: FinalResponseReason;
};

export type CompletedState = {
  phase: 'completed';
  operationId: string;
  lane: string;
  stopReason: string;
  finalEntryId: string | null;
};

export type RuntimeErrorCode =
  | 'provider_unavailable'
  | 'tool_unavailable'
  | 'permission_denied'
  | 'provider_error'
  | 'tool_error'
  | 'interrupted_uncertain_effect'
  | 'context_overflow'
  | 'max_iterations'
  | 'operation_corrupted'
  | 'session_corrupted';

export type RuntimeError = {
  code: RuntimeErrorCode | string;
  message: string;
  detail?: unknown;
};

export type FailedState = {
  phase: 'failed';
  operationId: string;
  lane: string;
  error: RuntimeError;
};

export type AbortedState = {
  phase: 'aborted';
  operationId: string;
  lane: string;
  reason: string;
};

export type SuspendedReason =
  | 'provider_unavailable'
  | 'tool_unavailable'
  | 'credential_required'
  | 'external_dependency_unavailable'
  | 'manual_recovery_required';

export type SuspendedState = {
  phase: 'suspended';
  operationId: string;
  lane: string;
  reason: SuspendedReason;
  detail?: unknown;
};

export type OperationState =
  | ReadyState
  | ModelPendingState
  | ToolsState
  | CheckpointState
  | FinalResponseState
  | CompletedState
  | FailedState
  | AbortedState
  | SuspendedState;

export type TerminalOperationState = CompletedState | FailedState | AbortedState;

export function emptyProgressState(): ProgressState {
  return {
    toolCallCounts: {},
    observationFingerprints: [],
    recoveryStepsRemaining: null
  };
}

export function isTerminalState(state: OperationState): state is TerminalOperationState {
  return state.phase === 'completed' || state.phase === 'failed' || state.phase === 'aborted';
}

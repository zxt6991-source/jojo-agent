export { resumeAgentTurn, runAgentTurn } from './harness/runner.js';
export type {
  ResumeAgentRunOptions,
  RuntimeAgentRunOptions,
  RuntimeAgentRunOptions as AgentRunOptions
} from './harness/runner.js';
export type { AgentRunResult } from '@desktop-agent/agent';
export { MemoryAgentRuntimeStore } from './memory-store.js';
export { DefaultContextBuilder } from './context/builder.js';
export type { BuildContextInput, ContextBuilder, ModelContext } from './context/builder.js';
export { NoopMemoryRuntime } from './memory/runtime.js';
export type {
  MemoryCompactInput,
  MemoryCompactResult,
  MemoryRuntime,
  MemoryTurnSettledInput
} from './memory/runtime.js';
export { projectEntriesToMessages } from './context/projection.js';
export type { AgentRuntimeStore, Clock, IdGenerator } from './store.js';
export type { OperationKind, OperationMeta, StoredOperation } from './operation/meta.js';
export type {
  ActiveToolsChangeEntry,
  AppendEntryInput,
  BranchSummaryEntry,
  CompactionEntry,
  CustomEntry,
  EntryBase,
  JsonPrimitive,
  JsonValue,
  HookContextEntry,
  LaneState,
  MessageEntry,
  ModelChangeEntry,
  MemoryRecallEntry,
  MemorySnapshotEntry,
  Session,
  SessionEntry
} from './session/types.js';
export type { UsageCause, UsageRecord } from './usage/types.js';
export { defaultAgentInterpreter } from './operation/interpreter.js';
export type { AgentInterpreter, InterpreterContext } from './operation/interpreter.js';
export type { AgentAction } from './operation/actions.js';
export {
  advanceTool,
  beginModelRequest,
  continueOutput,
  createReadyState,
  enterFinalResponse,
  markToolInterrupted,
  planToolCalls,
  prepareToolEffect,
  resolveToolPermission,
  setIterationLimit,
  settleToolWithoutEffect,
  settleToolEffect
} from './operation/reducer.js';
export { assertOperationState, OperationInvariantError } from './operation/invariants.js';
export { emptyProgressState, isTerminalState } from './operation/state.js';
export type {
  AbortedState,
  CheckpointState,
  CompletedState,
  FailedState,
  FinalResponseReason,
  FinalResponseState,
  ModelPendingState,
  OperationState,
  ProgressState,
  ReadyState,
  ReplayPolicy,
  RuntimeError,
  RuntimeErrorCode,
  SuspendedReason,
  SuspendedState,
  TerminalOperationState,
  ToolCallExecutionState,
  ToolEffectStatus,
  ToolPermissionState,
  ToolsState
} from './operation/state.js';

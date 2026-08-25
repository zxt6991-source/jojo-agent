import type {
  AgentEvent,
  IsolationSnapshot,
  UsageTotals,
  WorkflowStep,
  WorkflowStepErrorCode,
  WorkflowStepSnapshot
} from '@desktop-agent/contracts';
import type { WorkflowExecutionRequest } from '../types.js';

export type WorkflowStepExecutionContext = {
  request: WorkflowExecutionRequest;
  step: WorkflowStep;
  attempt: number;
  signal: AbortSignal;
  dependencies: WorkflowStepSnapshot[];
  resolvedInputs?: Record<string, unknown>;
  onUsage: (event: AgentEvent) => void;
  log: (level: 'info' | 'warning' | 'error', message: string) => void;
};

export type WorkflowStepExecutionResult = {
  output: string;
  stopReason: string;
  model?: string;
  usage: UsageTotals;
  incomplete: boolean;
  isolation?: IsolationSnapshot;
  structuredResult?: unknown;
  schemaValid?: boolean;
  error?: string;
  errorCode?: WorkflowStepErrorCode;
};

export interface WorkflowStepExecutor {
  readonly type: WorkflowStep['type'];
  readonly usesAgentScheduler: boolean;
  execute(context: WorkflowStepExecutionContext): Promise<WorkflowStepExecutionResult>;
}

export type WorkflowToolInvocation = {
  name: string;
  input: Record<string, unknown>;
  sessionId: string;
  workingDirectory: string;
  signal: AbortSignal;
};

export type WorkflowToolInvocationResult = {
  ok: boolean;
  content: string;
  code?: string;
};

export interface WorkflowToolRuntime {
  has(name: string): boolean;
  execute(invocation: WorkflowToolInvocation): Promise<WorkflowToolInvocationResult>;
}

export type WorkflowRecordingInvocation = {
  recordingId: string;
  params: Record<string, string | number | boolean>;
  runId: string;
  resume: boolean;
  maxRetries: number;
  retryDelayMs: number;
  sessionId: string;
  workingDirectory: string;
  signal: AbortSignal;
  onProgress: (text: string) => void;
};

export type WorkflowRecordingInvocationResult = {
  ok: boolean;
  content: string;
  code?: string;
  structuredResult?: unknown;
};

export interface WorkflowRecordingRuntime {
  execute(invocation: WorkflowRecordingInvocation): Promise<WorkflowRecordingInvocationResult>;
}

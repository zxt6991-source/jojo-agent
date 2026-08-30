import type {
  OrchestrationEvent,
  WorkflowArgs,
  WorkflowDefinition,
  WorkflowMemoryBinding,
  WorkflowRunSnapshot
} from '@desktop-agent/contracts';

export type WorkflowExecutionRequest = {
  id: string;
  sessionId: string;
  workingDirectory: string;
  providerId: string;
  model: string;
  args: WorkflowArgs;
  browserApproved?: boolean;
  definition: WorkflowDefinition;
  createdAt: string;
  depth?: number;
  memory?: WorkflowMemoryBinding;
};

export type WorkflowStartRequest = Omit<WorkflowExecutionRequest, 'id' | 'createdAt' | 'definition' | 'args'> & {
  id?: string;
  definition?: unknown;
  name?: string;
  args?: unknown;
};

export type WorkflowEngineCallbacks = {
  onChanged(snapshot: WorkflowRunSnapshot): void;
  onLog(event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): void;
};

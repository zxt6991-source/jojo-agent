import type {
  OrchestrationEvent,
  WorkflowArgs,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from '@desktop-agent/contracts';

export type WorkflowExecutionRequest = {
  id: string;
  sessionId: string;
  workingDirectory: string;
  providerId: string;
  model: string;
  args: WorkflowArgs;
  definition: WorkflowDefinition;
  createdAt: string;
  depth?: number;
};

export type WorkflowStartRequest = Omit<WorkflowExecutionRequest, 'id' | 'createdAt' | 'definition' | 'args'> & {
  definition?: unknown;
  name?: string;
  args?: unknown;
};

export type WorkflowEngineCallbacks = {
  onChanged(snapshot: WorkflowRunSnapshot): void;
  onLog(event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): void;
};

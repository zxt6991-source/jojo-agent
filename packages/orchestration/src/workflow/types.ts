import type {
  OrchestrationEvent,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from '@desktop-agent/contracts';

export type WorkflowExecutionRequest = {
  id: string;
  sessionId: string;
  workingDirectory: string;
  providerId: string;
  model: string;
  definition: WorkflowDefinition;
  createdAt: string;
};

export type WorkflowStartRequest = Omit<WorkflowExecutionRequest, 'id' | 'createdAt' | 'definition'> & {
  definition: unknown;
};

export type WorkflowEngineCallbacks = {
  onChanged(snapshot: WorkflowRunSnapshot): void;
  onLog(event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): void;
};

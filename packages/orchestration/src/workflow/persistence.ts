import type {
  OrchestrationEvent,
  StoredWorkflowRequest,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import type { WorkflowExecutionRequest } from './types.js';

export type PersistedWorkflowRun = {
  request: StoredWorkflowRequest;
  snapshot: WorkflowRunSnapshot;
  warnings: string[];
  definitionHashMatches: boolean;
};

export interface WorkflowPersistence {
  definitionHash(definition: WorkflowDefinition): string;
  create(request: WorkflowExecutionRequest, snapshot: WorkflowRunSnapshot): Promise<void>;
  appendTransition(previous: WorkflowRunSnapshot, next: WorkflowRunSnapshot): Promise<void>;
  appendLog(event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): Promise<void>;
  load(runId: string): Promise<PersistedWorkflowRun | null>;
  list(): Promise<PersistedWorkflowRun[]>;
}

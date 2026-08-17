import type { WorkflowDefinition } from '@desktop-agent/contracts';

export type SavedWorkflowSource = 'builtin' | 'user' | 'project';

export type SavedWorkflow = {
  name: string;
  description?: string;
  source: SavedWorkflowSource;
  sourcePath?: string;
  definition: WorkflowDefinition;
};

export type SavedWorkflowSummary = {
  name: string;
  description?: string;
  source: SavedWorkflowSource;
  inputs?: WorkflowDefinition['inputs'];
};

export type SavedWorkflowLoadWarning = {
  filePath: string;
  message: string;
};

export type SavedWorkflowLoadResult = {
  workflows: SavedWorkflow[];
  warnings: SavedWorkflowLoadWarning[];
};

export const SAVED_WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
export const MAX_SAVED_WORKFLOW_FILES = 64;
export const MAX_SAVED_WORKFLOW_BYTES = 120_000;

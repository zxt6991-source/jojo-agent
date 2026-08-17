import type { WorkflowDefinition } from '@desktop-agent/contracts';
import { OrchestrationError } from '../../errors.js';
import { SAVED_WORKFLOW_NAME_PATTERN, type SavedWorkflow, type SavedWorkflowSource, type SavedWorkflowSummary } from './types.js';

function copyWorkflow(workflow: SavedWorkflow): SavedWorkflow {
  return {
    name: workflow.name,
    source: workflow.source,
    definition: structuredClone(workflow.definition),
    ...(workflow.description ? { description: workflow.description } : {}),
    ...(workflow.sourcePath ? { sourcePath: workflow.sourcePath } : {})
  };
}

function workflowMap(workflows: SavedWorkflow[], source: SavedWorkflowSource): Map<string, SavedWorkflow> {
  const result = new Map<string, SavedWorkflow>();
  for (const workflow of workflows) {
    if (!SAVED_WORKFLOW_NAME_PATTERN.test(workflow.name)) {
      throw new OrchestrationError('workflow_invalid_definition', `Invalid saved workflow name: ${workflow.name}`);
    }
    result.set(workflow.name, copyWorkflow({ ...workflow, source }));
  }
  return result;
}

export class SavedWorkflowRegistry {
  private readonly builtinWorkflows = new Map<string, SavedWorkflow>();
  private userWorkflows = new Map<string, SavedWorkflow>();
  private readonly projectWorkflows = new Map<string, Map<string, SavedWorkflow>>();

  constructor(workflows: SavedWorkflow[] = []) {
    for (const workflow of workflows) {
      this.builtinWorkflows.set(workflow.name, copyWorkflow({ ...workflow, source: 'builtin' }));
    }
  }

  replaceUserWorkflows(workflows: SavedWorkflow[]): void {
    this.userWorkflows = workflowMap(workflows, 'user');
  }

  replaceProjectWorkflows(workingDirectory: string, workflows: SavedWorkflow[]): void {
    this.projectWorkflows.set(workingDirectory, workflowMap(workflows, 'project'));
  }

  get(name: string, workingDirectory?: string): SavedWorkflow {
    const workflow = (workingDirectory ? this.projectWorkflows.get(workingDirectory)?.get(name) : undefined)
      ?? this.userWorkflows.get(name)
      ?? this.builtinWorkflows.get(name);
    if (!workflow) throw new OrchestrationError('saved_workflow_not_found', `Unknown saved workflow: ${name}`);
    return copyWorkflow(workflow);
  }

  list(workingDirectory?: string): SavedWorkflow[] {
    const merged = new Map(this.builtinWorkflows);
    for (const [name, workflow] of this.userWorkflows) merged.set(name, workflow);
    if (workingDirectory) {
      for (const [name, workflow] of this.projectWorkflows.get(workingDirectory) ?? []) merged.set(name, workflow);
    }
    return [...merged.values()].map(copyWorkflow).sort((left, right) => left.name.localeCompare(right.name));
  }

  summarize(workingDirectory?: string): SavedWorkflowSummary[] {
    return this.list(workingDirectory).map((workflow) => ({
      name: workflow.name,
      source: workflow.source,
      ...(workflow.description ? { description: workflow.description } : {}),
      ...(workflow.definition.inputs ? { inputs: structuredClone(workflow.definition.inputs) } : {})
    }));
  }
}

export function savedWorkflowFromDefinition(
  definition: WorkflowDefinition,
  source: SavedWorkflowSource,
  sourcePath?: string
): SavedWorkflow {
  return {
    name: definition.name,
    source,
    definition: structuredClone(definition),
    ...(definition.description ? { description: definition.description } : {}),
    ...(sourcePath ? { sourcePath } : {})
  };
}

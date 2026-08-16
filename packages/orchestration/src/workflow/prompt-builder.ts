import type { WorkflowAgentStep, WorkflowStepSnapshot } from '@desktop-agent/contracts';

export const MAX_STEP_OUTPUT_CHARACTERS = 16 * 1024;
export const MAX_DEPENDENCY_OUTPUT_CHARACTERS = 12 * 1024;
export const MAX_TOTAL_DEPENDENCY_CHARACTERS = 48 * 1024;
const TRUNCATION_MARKER = '\n[Dependency output truncated]';

export function truncateWorkflowOutput(output: string): { output: string; truncated: boolean } {
  if (output.length <= MAX_STEP_OUTPUT_CHARACTERS) return { output, truncated: false };
  const marker = '\n[Step output truncated]';
  return { output: `${output.slice(0, MAX_STEP_OUTPUT_CHARACTERS - marker.length)}${marker}`, truncated: true };
}

function dependencyContent(dependency: WorkflowStepSnapshot): string {
  if (dependency.output) return dependency.output;
  if (dependency.error) return `[${dependency.state}] ${dependency.error}`;
  return `[${dependency.state}] No output was produced.`;
}

export function buildStepPrompt(step: WorkflowAgentStep, dependencies: WorkflowStepSnapshot[]): string {
  if (dependencies.length === 0) return `Task:\n${step.task}`;
  let remaining = MAX_TOTAL_DEPENDENCY_CHARACTERS;
  const sections: string[] = [];
  for (const dependency of dependencies) {
    const header = `=== ${dependency.id} (${dependency.state}${dependency.incomplete ? ', incomplete' : ''}) ===\n`;
    const source = dependencyContent(dependency);
    const perDependencyLimit = Math.min(MAX_DEPENDENCY_OUTPUT_CHARACTERS, remaining);
    if (perDependencyLimit <= 0) {
      sections.push(`${header}[Dependency output omitted: total limit reached]`);
      continue;
    }
    const content = source.length <= perDependencyLimit
      ? source
      : `${source.slice(0, Math.max(0, perDependencyLimit - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
    remaining -= content.length;
    sections.push(`${header}${content}`);
  }
  return [`Task:\n${step.task}`, '', 'Dependency Results:', '', ...sections].join('\n');
}

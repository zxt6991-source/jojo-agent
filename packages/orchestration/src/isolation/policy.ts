import type { IsolationType } from '@desktop-agent/contracts';
import { OrchestrationError } from '../errors.js';
import type { AgentProfileDefinition } from '../subagent/profile-registry.js';

export function resolveIsolationType(input: {
  profile: AgentProfileDefinition;
  requestReadOnly?: boolean;
  requestedType?: IsolationType;
}): IsolationType {
  const readOnly = input.profile.readOnly || input.requestReadOnly === true;
  if (input.requestedType === 'none' && !readOnly) {
    throw new OrchestrationError(
      'isolation_required',
      'Writable agents must use worktree isolation. Set isolation.type to "worktree".'
    );
  }
  if (input.requestedType) return input.requestedType;
  return readOnly ? 'none' : 'worktree';
}

export function isolationTaskPrefix(input: {
  workingDirectory: string;
  branch: string;
}): string {
  return [
    'Isolated execution:',
    `- Working directory: ${input.workingDirectory}`,
    `- Git branch: ${input.branch}`,
    '- Reviewable changes stay on this branch. Do not merge into the default branch.',
    '- Stay inside this working directory.'
  ].join('\n');
}

export function withIsolationTask(
  task: string,
  isolation?: { workingDirectory: string; branch: string } | undefined
): string {
  return isolation ? `${isolationTaskPrefix(isolation)}\n\n${task}` : task;
}

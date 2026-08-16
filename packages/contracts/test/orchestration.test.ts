import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from '../src/index.js';

function workflow(steps: Array<{ id: string; dependsOn?: string[] }>, outputStepId?: string) {
  return {
    schemaVersion: 1 as const,
    name: 'test',
    steps: steps.map((step) => ({ type: 'agent' as const, task: `Analyze ${step.id}`, ...step })),
    ...(outputStepId ? { outputStepId } : {})
  };
}

describe('WorkflowDefinitionSchema', () => {
  it('parses a valid DAG and applies execution defaults', () => {
    const parsed = WorkflowDefinitionSchema.parse(workflow([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] }
    ], 'b'));
    expect(parsed.maxConcurrency).toBe(3);
    expect(parsed.steps[0]).toMatchObject({ profile: 'explore', dependsOn: [], continueOnError: false });
  });

  it.each([
    ['duplicate ids', workflow([{ id: 'a' }, { id: 'a' }])],
    ['unknown dependencies', workflow([{ id: 'a', dependsOn: ['missing'] }])],
    ['self dependencies', workflow([{ id: 'a', dependsOn: ['a'] }])],
    ['cycles', workflow([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }])],
    ['unknown output step', workflow([{ id: 'a' }], 'missing')]
  ])('rejects %s', (_name, definition) => {
    expect(WorkflowDefinitionSchema.safeParse(definition).success).toBe(false);
  });
});

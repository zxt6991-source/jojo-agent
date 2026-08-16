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

  it('accepts bounded per-agent execution options without changing schemaVersion 1', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'options',
      steps: [{
        id: 'review', type: 'agent', task: 'Review', profile: 'code-review',
        model: 'review-model', maxIterations: 6, readOnly: true,
        tools: { allow: ['read_file', 'grep'], deny: ['terminal'] }
      }]
    });
    expect(parsed.steps[0]).toMatchObject({
      profile: 'code-review', model: 'review-model', maxIterations: 6, readOnly: true,
      tools: { allow: ['read_file', 'grep'], deny: ['terminal'] }
    });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'bad options', steps: [{
        id: 'bad', type: 'agent', task: 'Bad', maxIterations: 21
      }]
    }).success).toBe(false);
  });

  it('accepts a bounded retry policy and rejects non-retryable error codes', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'retry',
      steps: [{
        id: 'inspect', type: 'agent', task: 'Inspect',
        retry: { maxAttempts: 3, retryOn: ['provider_timeout'] }
      }]
    });
    expect(parsed.steps[0]?.retry).toEqual({
      maxAttempts: 3,
      backoffMs: 1_000,
      retryOn: ['provider_timeout']
    });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1,
      name: 'unsafe retry',
      steps: [{
        id: 'inspect', type: 'agent', task: 'Inspect',
        retry: { maxAttempts: 2, retryOn: ['invalid_profile'] }
      }]
    }).success).toBe(false);
  });

  it('validates typed input references against direct dependencies', () => {
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'inputs', steps: [
        { id: 'source', type: 'agent', task: 'Source' },
        {
          id: 'summary', type: 'agent', task: 'Summary', dependsOn: ['source'],
          inputs: { findings: { valueFrom: '$steps.source.structuredResult.findings' } }
        }
      ]
    }).success).toBe(true);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'not a dependency', steps: [
        { id: 'source', type: 'agent', task: 'Source' },
        {
          id: 'summary', type: 'agent', task: 'Summary',
          inputs: { findings: { valueFrom: '$steps.source.output' } }
        }
      ]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'invalid syntax', steps: [{
        id: 'summary', type: 'agent', task: 'Summary',
        inputs: { value: { valueFrom: '$steps[source].output' } }
      }]
    }).success).toBe(false);
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

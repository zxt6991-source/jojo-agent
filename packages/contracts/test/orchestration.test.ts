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
    expect(parsed.steps[0]).toMatchObject({
      retry: {
        maxAttempts: 3,
        backoffMs: 1_000,
        retryOn: ['provider_timeout']
      }
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

  it('accepts worktree isolation on agent steps without changing schemaVersion 1', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'isolated',
      steps: [{
        id: 'edit', type: 'agent', profile: 'general', task: 'Edit',
        isolation: { type: 'worktree' }
      }]
    });
    expect(parsed.steps[0]).toMatchObject({ isolation: { type: 'worktree' } });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'bad isolation',
      steps: [{ id: 'edit', type: 'agent', task: 'Edit', isolation: { type: 'container' } }]
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

  it('accepts allowlisted tool steps and rejects shell or write tools', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'tools',
      steps: [{
        id: 'files', type: 'tool', tool: 'list_files', input: { path: '.' },
        inputs: { query: { valueFrom: '$workflow.args.query' } }
      }]
    });
    expect(parsed.steps[0]).toMatchObject({ type: 'tool', tool: 'list_files', input: { path: '.' } });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'shell',
      steps: [{ id: 'sh', type: 'tool', tool: 'terminal', input: { command: 'ls' } }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'write',
      steps: [{ id: 'write', type: 'tool', tool: 'write_file', input: { path: 'a.ts' } }]
    }).success).toBe(false);
  });

  it('accepts declared workflow inputs and rejects placeholder or default mismatches', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'parameterized',
      inputs: {
        target: { type: 'string', required: true, description: 'Path to inspect' },
        deep: { type: 'boolean', default: false }
      },
      steps: [{ id: 'inspect', type: 'agent', task: 'Inspect {{inputs.target}}' }]
    });
    expect(parsed.inputs).toMatchObject({
      target: { type: 'string', required: true },
      deep: { type: 'boolean', required: false, default: false }
    });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'bad default',
      inputs: { count: { type: 'number', default: 'nope' } },
      steps: [{ id: 'a', type: 'agent', task: 'A' }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'unknown placeholder',
      inputs: { target: { type: 'string', required: true } },
      steps: [{ id: 'a', type: 'agent', task: 'Inspect {{inputs.missing}}' }]
    }).success).toBe(false);
  });

  it('accepts foreach steps and rejects items that are not a direct dependency', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'foreach',
      steps: [
        { id: 'scan', type: 'agent', task: 'Scan', outputSchema: { type: 'object', properties: { files: { type: 'array' } } } },
        {
          id: 'review', type: 'foreach', dependsOn: ['scan'],
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          itemLimit: 8,
          concurrency: 2,
          template: { type: 'agent', profile: 'code-review', task: 'Review {{item}}' }
        }
      ]
    });
    expect(parsed.steps[1]).toMatchObject({
      type: 'foreach', itemLimit: 8, concurrency: 2,
      items: { valueFrom: '$steps.scan.structuredResult.files' }
    });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'not a dependency',
      steps: [
        { id: 'scan', type: 'agent', task: 'Scan' },
        {
          id: 'review', type: 'foreach',
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          template: { type: 'agent', task: 'Review {{item}}' }
        }
      ]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'args items',
      steps: [{
        id: 'review', type: 'foreach',
        items: { valueFrom: '$workflow.args.files' },
        template: { type: 'agent', task: 'Review {{item}}' }
      }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'over limit',
      steps: [
        { id: 'scan', type: 'agent', task: 'Scan' },
        {
          id: 'review', type: 'foreach', dependsOn: ['scan'],
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          itemLimit: 21,
          template: { type: 'agent', task: 'Review {{item}}' }
        }
      ]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'nested foreach',
      steps: [
        { id: 'scan', type: 'agent', task: 'Scan' },
        {
          id: 'review', type: 'foreach', dependsOn: ['scan'],
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          template: {
            type: 'foreach',
            items: { valueFrom: '$steps.scan.structuredResult.files' },
            template: { type: 'agent', task: 'Nested' }
          }
        }
      ]
    }).success).toBe(false);
  });

  it('accepts condition steps and rejects eval-like or invalid branches', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'condition',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect' },
        {
          id: 'check', type: 'condition', dependsOn: ['inspect'],
          when: { op: 'equals', left: { valueFrom: '$steps.inspect.structuredResult.type' }, right: 'kernel' },
          then: ['kernel'],
          else: ['app']
        },
        { id: 'kernel', type: 'agent', dependsOn: ['check'], task: 'Kernel' },
        { id: 'app', type: 'agent', dependsOn: ['check'], task: 'App' }
      ]
    });
    expect(parsed.steps[1]).toMatchObject({
      type: 'condition',
      when: { op: 'equals', right: 'kernel' },
      then: ['kernel'],
      else: ['app']
    });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'eval',
      steps: [{
        id: 'check', type: 'condition',
        when: { op: 'equals', left: { valueFrom: '$workflow.args.x' }, right: 'a', eval: 'true' },
        then: []
      }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'missing branch dep',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect' },
        {
          id: 'check', type: 'condition', dependsOn: ['inspect'],
          when: { op: 'exists', left: { valueFrom: '$steps.inspect.structuredResult.type' } },
          then: ['kernel']
        },
        { id: 'kernel', type: 'agent', task: 'Kernel' }
      ]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'overlap',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect' },
        {
          id: 'check', type: 'condition', dependsOn: ['inspect'],
          when: { op: 'notEquals', left: { valueFrom: '$steps.inspect.output' }, right: 'x' },
          then: ['kernel'], else: ['kernel']
        },
        { id: 'kernel', type: 'agent', dependsOn: ['check'], task: 'Kernel' }
      ]
    }).success).toBe(false);
  });

  it('accepts nested saved-workflow steps and rejects arg sources that are not dependencies', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'outer',
      steps: [{
        id: 'security', type: 'workflow', name: 'security-review',
        args: { target: { valueFrom: '$workflow.args.target' } }
      }]
    });
    expect(parsed.steps[0]).toMatchObject({ type: 'workflow', name: 'security-review' });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'bad arg',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect' },
        {
          id: 'security', type: 'workflow', name: 'security-review',
          args: { target: { valueFrom: '$steps.inspect.output' } }
        }
      ]
    }).success).toBe(false);
  });

  it('accepts resource groups and rejects mismatched maxConcurrency for the same group', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'groups',
      steps: [
        { id: 'a', type: 'agent', task: 'A', resources: { group: 'main-worktree-writer' } },
        { id: 'b', type: 'agent', task: 'B', resources: { group: 'main-worktree-writer', maxConcurrency: 1 } }
      ]
    });
    expect(parsed.steps[0]).toMatchObject({ resources: { group: 'main-worktree-writer', maxConcurrency: 1 } });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'mismatch',
      steps: [
        { id: 'a', type: 'agent', task: 'A', resources: { group: 'writers', maxConcurrency: 1 } },
        { id: 'b', type: 'agent', task: 'B', resources: { group: 'writers', maxConcurrency: 2 } }
      ]
    }).success).toBe(false);
  });

  it('accepts workflow and step budgets and rejects empty or unpriced cost budgets', () => {
    const parsed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'budgeted',
      budget: {
        maxInputTokens: 200_000,
        maxOutputTokens: 50_000,
        maxCostUsd: 2,
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15
      },
      steps: [{
        id: 'review', type: 'agent', task: 'Review',
        budget: { maxOutputTokens: 8_000 }
      }]
    });
    expect(parsed.budget).toMatchObject({ maxInputTokens: 200_000, maxCostUsd: 2 });
    expect(parsed.steps[0]).toMatchObject({ budget: { maxOutputTokens: 8_000 } });
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'empty',
      budget: {},
      steps: [{ id: 'a', type: 'agent', task: 'A' }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'cost without rates',
      budget: { maxCostUsd: 1 },
      steps: [{ id: 'a', type: 'agent', task: 'A' }]
    }).success).toBe(false);
    expect(WorkflowDefinitionSchema.safeParse({
      schemaVersion: 1, name: 'step extra cost',
      steps: [{ id: 'a', type: 'agent', task: 'A', budget: { maxCostUsd: 1 } }]
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

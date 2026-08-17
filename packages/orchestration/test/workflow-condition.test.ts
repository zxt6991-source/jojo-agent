import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  evaluateWorkflowCondition,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  WorkflowEngine
} from '../src/index.js';

function result(output: string, tokens = 1): LeafAgentRunResult {
  return {
    result: output,
    stopReason: 'stop',
    usage: { inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  };
}

function branched(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'branch',
    outputStepId: 'summary',
    steps: [
      {
        id: 'inspect', type: 'agent', task: 'Inspect',
        outputSchema: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] }
      },
      {
        id: 'check', type: 'condition', dependsOn: ['inspect'],
        when: { op: 'equals', left: { valueFrom: '$steps.inspect.structuredResult.type' }, right: 'kernel' },
        then: ['kernel'],
        else: ['app']
      },
      { id: 'kernel', type: 'agent', dependsOn: ['check'], task: 'Kernel work' },
      { id: 'kernel-tests', type: 'agent', dependsOn: ['kernel'], task: 'Kernel tests' },
      { id: 'app', type: 'agent', dependsOn: ['check'], task: 'App work' },
      { id: 'summary', type: 'agent', dependsOn: ['kernel-tests', 'app'], task: 'Summary' }
    ]
  });
}

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_condition', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args: {}, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

function runnerFor(kind: string): LeafAgentRunner {
  return {
    run: async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      if (stepId === 'inspect') return result(JSON.stringify({ type: kind }));
      return result(`out-${stepId}`);
    }
  };
}

describe('evaluateWorkflowCondition', () => {
  it('supports equals, notEquals, and exists without eval', () => {
    const deps = [{
      id: 'inspect', state: 'completed' as const, attempt: 1, createdAt: new Date().toISOString(),
      incomplete: false, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      structuredResult: { type: 'kernel' }
    }];
    expect(evaluateWorkflowCondition({
      op: 'equals', left: { valueFrom: '$steps.inspect.structuredResult.type' }, right: 'kernel'
    }, deps, {})).toBe(true);
    expect(evaluateWorkflowCondition({
      op: 'notEquals', left: { valueFrom: '$steps.inspect.structuredResult.type' }, right: 'app'
    }, deps, {})).toBe(true);
    expect(evaluateWorkflowCondition({
      op: 'exists', left: { valueFrom: '$steps.inspect.structuredResult.missing' }
    }, deps, {})).toBe(false);
  });
});

describe('WorkflowEngine condition', () => {
  it('runs the then branch, skips the else chain, and still joins', async () => {
    const final = await new WorkflowEngine(runnerFor('kernel'), new AgentExecutionScheduler(4))
      .run(request(branched()), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(final.steps.find((step) => step.id === 'check')).toMatchObject({
      type: 'condition', structuredResult: { matched: true }
    });
    expect(final.steps.find((step) => step.id === 'kernel')?.state).toBe('completed');
    expect(final.steps.find((step) => step.id === 'kernel-tests')?.state).toBe('completed');
    expect(final.steps.find((step) => step.id === 'app')?.state).toBe('skipped');
    expect(final.steps.find((step) => step.id === 'summary')?.state).toBe('completed');
    expect(final.incomplete).toBe(false);
  });

  it('runs the else branch and cascade-skips the unused then chain', async () => {
    const final = await new WorkflowEngine(runnerFor('app'), new AgentExecutionScheduler(4))
      .run(request(branched()), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'check')?.structuredResult).toEqual({ matched: false });
    expect(final.steps.find((step) => step.id === 'kernel')?.state).toBe('skipped');
    expect(final.steps.find((step) => step.id === 'kernel-tests')?.state).toBe('skipped');
    expect(final.steps.find((step) => step.id === 'app')?.state).toBe('completed');
    expect(final.steps.find((step) => step.id === 'summary')?.state).toBe('completed');
    expect(final.state).toBe('completed');
  });

  it('treats missing fields as exists=false rather than crashing', async () => {
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'exists',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect', outputSchema: { type: 'object' } },
        {
          id: 'check', type: 'condition', dependsOn: ['inspect'],
          when: { op: 'exists', left: { valueFrom: '$steps.inspect.structuredResult.flag' } },
          then: ['yes'], else: ['no']
        },
        { id: 'yes', type: 'agent', dependsOn: ['check'], task: 'Yes' },
        { id: 'no', type: 'agent', dependsOn: ['check'], task: 'No' }
      ]
    });
    const runner: LeafAgentRunner = { run: async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      if (stepId === 'inspect') return result(JSON.stringify({ ok: true }));
      return result(stepId);
    } };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'yes')?.state).toBe('skipped');
    expect(final.steps.find((step) => step.id === 'no')?.state).toBe('completed');
  });

  it('fails equals when the referenced field is missing', async () => {
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'missing',
      steps: [
        { id: 'inspect', type: 'agent', task: 'Inspect', outputSchema: { type: 'object' } },
        {
          id: 'check', type: 'condition', dependsOn: ['inspect'],
          when: { op: 'equals', left: { valueFrom: '$steps.inspect.structuredResult.type' }, right: 'kernel' }
        }
      ]
    });
    const runner: LeafAgentRunner = { run: async () => result(JSON.stringify({ ok: true })) };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'check')).toMatchObject({
      state: 'failed', errorCode: 'workflow_reference_not_found'
    });
  });

  it('keeps skipped steps skipped on resume', async () => {
    const workflow = branched();
    const runRequest = request(workflow);
    const previous = {
      ...runRequest, name: workflow.name, state: 'interrupted' as const, revision: 1,
      steps: [
        {
          id: 'inspect', type: 'agent' as const, state: 'completed' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false,
          output: '{"type":"kernel"}', structuredResult: { type: 'kernel' },
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'check', type: 'condition' as const, state: 'completed' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false, structuredResult: { matched: true },
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'kernel', type: 'agent' as const, state: 'completed' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false, output: 'out-kernel',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'kernel-tests', type: 'agent' as const, state: 'pending' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'app', type: 'agent' as const, state: 'skipped' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false, stopReason: 'skipped',
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        },
        {
          id: 'summary', type: 'agent' as const, state: 'pending' as const, attempt: 1,
          createdAt: runRequest.createdAt, incomplete: false,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
        }
      ],
      usage: { inputTokens: 2, outputTokens: 2, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      failedStepIds: [], blockedStepIds: [], incomplete: true
    };
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        calls.push(stepId);
        return result(`resumed-${stepId}`);
      }
    };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(runRequest, new AbortController().signal, callbacks(), previous);
    expect(calls.sort()).toEqual(['kernel-tests', 'summary']);
    expect(final.steps.find((step) => step.id === 'app')?.state).toBe('skipped');
    expect(final.steps.find((step) => step.id === 'inspect')?.state).toBe('completed');
    expect(final.state).toBe('completed');
  });
});

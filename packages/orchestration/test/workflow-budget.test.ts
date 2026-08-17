import { describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionSchema,
  type AgentEvent,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  OrchestrationError,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  type WorkflowToolRuntime,
  WorkflowEngine,
  emptyUsage,
  estimatedWorkflowCostUsd,
  workflowBudgetExceeded
} from '../src/index.js';

function result(output = 'done', tokens = 1): LeafAgentRunResult {
  return {
    result: output,
    stopReason: 'stop',
    usage: { inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  };
}

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_budget', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args: {}, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('workflow budget helpers', () => {
  it('treats remaining budget as exhausted at the cap, including estimated USD', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    expect(workflowBudgetExceeded({ maxOutputTokens: 1000 }, usage)).toMatch(/output tokens 1000 >= 1000/);
    expect(workflowBudgetExceeded({ maxOutputTokens: 1001 }, usage)).toBeUndefined();
    const priced = {
      maxCostUsd: 0.0015,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1
    };
    expect(estimatedWorkflowCostUsd(usage, priced)).toBeCloseTo(0.002);
    expect(workflowBudgetExceeded(priced, usage)).toMatch(/estimated cost/);
    expect(workflowBudgetExceeded(priced, emptyUsage())).toBeUndefined();
  });
});

describe('WorkflowEngine budget', () => {
  it('starts the first agent and blocks the next consuming step before launch', async () => {
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return result('ok', 10);
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'serial-budget',
      budget: { maxOutputTokens: 5 },
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(calls).toEqual(['a']);
    expect(final.state).toBe('failed');
    expect(final.budget).toMatchObject({ maxOutputTokens: 5 });
    expect(final.steps[0]).toMatchObject({ state: 'completed', usage: { outputTokens: 10 } });
    expect(final.steps[1]).toMatchObject({
      state: 'blocked',
      errorCode: 'workflow_budget_exceeded'
    });
    expect(final.blockedStepIds).toEqual(['b']);
  });

  it('blocks a downstream agent after a tool step when the workflow budget is already exhausted', async () => {
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return result('ok', 10);
      }
    };
    const toolRuntime: WorkflowToolRuntime = {
      has: (name) => name === 'list_files',
      execute: async () => ({ ok: true, content: 'listed' })
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'tool-after-budget',
      budget: { maxOutputTokens: 5 },
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'files', type: 'tool', tool: 'list_files', dependsOn: ['a'], input: { path: '.' } },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['files'] }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(calls).toEqual(['a']);
    expect(final.steps.map((step) => [step.id, step.state, step.errorCode])).toEqual([
      ['a', 'completed', undefined],
      ['files', 'completed', undefined],
      ['b', 'blocked', 'workflow_budget_exceeded']
    ]);
  });

  it('skips a retry once the failed attempt has already exhausted remaining budget', async () => {
    let attempts = 0;
    const runner: LeafAgentRunner = {
      run: async (_runRequest, _signal, onEvent) => {
        attempts += 1;
        onEvent({ type: 'usage', inputTokens: 0, outputTokens: 10 } satisfies AgentEvent);
        throw new OrchestrationError('provider_error', 'provider failed');
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'retry-budget',
      budget: { maxOutputTokens: 5 },
      steps: [{
        id: 'a', type: 'agent', task: 'A',
        retry: { maxAttempts: 3, backoffMs: 0, retryOn: ['provider_error'] }
      }]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(attempts).toBe(1);
    expect(final.steps[0]).toMatchObject({ state: 'failed', errorCode: 'provider_error' });
  });

  it('enforces a step-level output budget on retry without blocking the first attempt', async () => {
    let attempts = 0;
    const runner: LeafAgentRunner = {
      run: async (_runRequest, _signal, onEvent) => {
        attempts += 1;
        onEvent({ type: 'usage', inputTokens: 1, outputTokens: 8 } satisfies AgentEvent);
        throw new OrchestrationError('provider_error', 'provider failed');
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'step-budget',
      steps: [{
        id: 'a', type: 'agent', task: 'A',
        budget: { maxOutputTokens: 5 },
        retry: { maxAttempts: 3, backoffMs: 0, retryOn: ['provider_error'] }
      }]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(attempts).toBe(1);
    expect(final.steps[0]).toMatchObject({ state: 'failed', errorCode: 'provider_error' });
  });

  it('blocks later foreach agent instances once the workflow budget is exhausted', async () => {
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        calls.push(stepId);
        if (stepId === 'scan') {
          return {
            ...result(JSON.stringify({ files: ['a.ts', 'b.ts', 'c.ts'] }), 1),
            result: JSON.stringify({ files: ['a.ts', 'b.ts', 'c.ts'] })
          };
        }
        return result(`reviewed-${stepId}`, 10);
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'foreach-budget',
      budget: { maxOutputTokens: 8 },
      steps: [
        {
          id: 'scan', type: 'agent', task: 'Scan',
          outputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }
        },
        {
          id: 'review', type: 'foreach', dependsOn: ['scan'], concurrency: 1,
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          template: { type: 'agent', profile: 'code-review', task: 'Review {{item}}' }
        }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(calls).toEqual(['scan', 'review__0']);
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'failed',
      errorCode: 'workflow_budget_exceeded'
    });
    expect(final.steps.find((step) => step.id === 'review')?.instances?.map((instance) => instance.state)).toEqual([
      'completed',
      'blocked',
      'cancelled'
    ]);
  });

  it('resumes without rerunning a completed step and still blocks when remaining budget is gone', async () => {
    const firstRunner: LeafAgentRunner = {
      run: async (runRequest) => {
        if (runRequest.id.endsWith(':a')) return result('a', 10);
        return result('should-not-run');
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'resume-budget',
      budget: { maxOutputTokens: 10 },
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] }
      ]
    });
    const interrupted = await new WorkflowEngine(firstRunner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(interrupted.steps[0]?.state).toBe('completed');
    expect(interrupted.steps[1]?.state).toBe('blocked');

    const calls: string[] = [];
    const resumeRunner: LeafAgentRunner = {
      run: async (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return result('resumed');
      }
    };
    const resumed = await new WorkflowEngine(resumeRunner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks(), interrupted);
    expect(calls).toEqual([]);
    expect(resumed.steps[0]).toMatchObject({ state: 'completed', output: 'a' });
    expect(resumed.steps[1]).toMatchObject({ state: 'blocked', errorCode: 'workflow_budget_exceeded' });
  });

  it('blocks the next step when estimated USD cost reaches the cap', async () => {
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return result('ok', 1000);
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'cost-budget',
      budget: {
        maxCostUsd: 0.0015,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1
      },
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(calls).toEqual(['a']);
    expect(final.steps[1]).toMatchObject({ state: 'blocked', errorCode: 'workflow_budget_exceeded' });
    expect(final.steps[1]?.error).toMatch(/estimated cost/);
  });
});

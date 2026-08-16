import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowDefinitionSchema,
  type AgentEvent,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  buildStepPrompt,
  emptyUsage,
  MAX_DEPENDENCY_OUTPUT_CHARACTERS,
  MAX_STEP_OUTPUT_CHARACTERS,
  OrchestrationError,
  type LeafAgentRunRequest,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  SubAgentManager,
  WorkflowEngine
} from '../src/index.js';

type Deferred = { resolve: (result: LeafAgentRunResult) => void; promise: Promise<LeafAgentRunResult> };
function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  const promise = new Promise<LeafAgentRunResult>((done) => { resolve = done; });
  return { resolve, promise };
}

function result(output: string, tokens = 1): LeafAgentRunResult {
  return {
    result: output,
    stopReason: 'stop',
    usage: { inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  };
}

function definition(
  steps: Array<{
    id: string;
    dependsOn?: string[];
    profile?: 'explore' | 'synthesize';
    continueOnError?: boolean;
    task?: string;
  }>,
  options: { maxConcurrency?: number; outputStepId?: string; timeoutMs?: number } = {}
): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'test workflow',
    ...options,
    steps: steps.map((step) => ({ type: 'agent', task: step.task ?? `Task ${step.id}`, ...step }))
  });
}

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_test', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('WorkflowEngine', () => {
  it('executes A -> B -> C serially and returns the output step', async () => {
    const starts: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        starts.push(stepId);
        return result(`output-${stepId}`);
      }
    };
    const workflow = definition([
      { id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] }
    ], { outputStepId: 'c' });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(starts).toEqual(['a', 'b', 'c']);
    expect(final).toMatchObject({ state: 'completed', result: 'output-c', incomplete: false });
    expect(final.usage).toMatchObject({ inputTokens: 3, outputTokens: 3 });
  });

  it('starts A/B/C in parallel before synthesis D', async () => {
    const pending = new Map<string, Deferred>();
    const starts: LeafAgentRunRequest[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        starts.push(runRequest);
        const task = deferred();
        pending.set(runRequest.id.split(':').at(-1)!, task);
        return task.promise;
      }
    };
    const workflow = definition([
      { id: 'a' }, { id: 'b' }, { id: 'c' },
      { id: 'd', profile: 'synthesize', dependsOn: ['a', 'b', 'c'] }
    ], { maxConcurrency: 3, outputStepId: 'd' });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(workflow), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts.map((item) => item.id.split(':').at(-1)).sort()).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) pending.get(id)!.resolve(result(`output-${id}`));
    await vi.waitFor(() => expect(starts).toHaveLength(4));
    const synthesis = starts[3]!;
    expect(synthesis.profile).toBe('synthesize');
    expect(synthesis.task).toContain('=== a (completed) ===');
    expect(synthesis.task).toContain('output-c');
    pending.get('d')!.resolve(result('summary'));
    await expect(running).resolves.toMatchObject({ state: 'completed', result: 'summary' });
  });

  it('blocks dependants of a failed step while independent branches complete', async () => {
    const starts: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        starts.push(stepId);
        if (stepId === 'a') throw new Error('provider failed');
        return result(`output-${stepId}`);
      }
    };
    const workflow = definition([{ id: 'a' }, { id: 'b', dependsOn: ['a'] }, { id: 'c' }]);
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(3))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(starts.sort()).toEqual(['a', 'c']);
    expect(final.steps.find((step) => step.id === 'b')?.state).toBe('blocked');
    expect(final.steps.find((step) => step.id === 'c')?.state).toBe('completed');
    expect(final).toMatchObject({ state: 'failed', failedStepIds: ['a'], blockedStepIds: ['b'], incomplete: true });
  });

  it('continues through a failed dependency when continueOnError is set', async () => {
    let downstreamPrompt = '';
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'a') throw new Error('expected failure');
        downstreamPrompt = runRequest.task;
        return result('recovered');
      }
    };
    const workflow = definition([{ id: 'a', continueOnError: true }, { id: 'b', dependsOn: ['a'] }], { outputStepId: 'b' });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(downstreamPrompt).toContain('=== a (failed, incomplete) ===');
    expect(downstreamPrompt).toContain('expected failure');
    expect(final).toMatchObject({ state: 'completed', result: 'recovered', incomplete: true });
  });

  it('enforces workflow maxConcurrency in addition to the shared scheduler', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const runner: LeafAgentRunner = {
      run: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return result('done');
      }
    };
    const workflow = definition([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], { maxConcurrency: 2 });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(workflow), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases.splice(0)) release();
    await running;
    expect(maximum).toBe(2);
  });

  it('propagates cancellation to a running step', async () => {
    const controller = new AbortController();
    let childAborted = false;
    let childStarted = false;
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        childStarted = true;
        signal.addEventListener('abort', () => {
          childAborted = true;
          resolve({ ...result('partial'), stopReason: 'cancelled', incomplete: true });
        }, { once: true });
      })
    };
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(definition([{ id: 'a' }])), controller.signal, callbacks());
    await vi.waitFor(() => expect(childStarted).toBe(true));
    controller.abort();
    const final = await running;
    expect(childAborted).toBe(true);
    expect(final).toMatchObject({ state: 'cancelled', errorCode: 'workflow_cancelled' });
    expect(final.steps[0]).toMatchObject({ state: 'cancelled', errorCode: 'workflow_cancelled' });
  });

  it('marks a step timeout distinctly', async () => {
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ...result('partial'), stopReason: 'cancelled', incomplete: true }), { once: true });
      })
    };
    const workflow = definition([{ id: 'a' }]);
    workflow.steps[0]!.timeoutMs = 10;
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.state).toBe('failed');
    expect(final.steps[0]).toMatchObject({ state: 'timed_out', stopReason: 'step_timeout', errorCode: 'step_timeout', incomplete: true });
  });

  it('marks an overall workflow timeout distinctly', async () => {
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ...result('partial'), stopReason: 'cancelled', incomplete: true }), { once: true });
      })
    };
    const workflow = definition([{ id: 'a' }]);
    workflow.timeoutMs = 10;
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final).toMatchObject({ state: 'timed_out', errorCode: 'workflow_timeout' });
    expect(final.steps[0]).toMatchObject({ state: 'cancelled', stopReason: 'workflow_timeout', errorCode: 'workflow_timeout', incomplete: true });
  });

  it('maps provider errors and max-iteration partial results to stable step error codes', async () => {
    const providerFailure = await new WorkflowEngine({
      run: async () => { throw new OrchestrationError('provider_timeout', 'Provider request timed out.'); }
    }, new AgentExecutionScheduler(1)).run(
      request(definition([{ id: 'a' }])), new AbortController().signal, callbacks()
    );
    expect(providerFailure.steps[0]).toMatchObject({ state: 'failed', errorCode: 'provider_timeout' });

    const partial = await new WorkflowEngine({
      run: async () => ({ result: 'partial', stopReason: 'max_iterations', usage: emptyUsage(), incomplete: true })
    }, new AgentExecutionScheduler(1)).run(
      request(definition([{ id: 'a' }])), new AbortController().signal, callbacks()
    );
    expect(partial.steps[0]).toMatchObject({ state: 'completed', errorCode: 'max_iterations', incomplete: true });
  });

  it('fails safely with workflow_deadlock if a prevalidated graph becomes unrunnable', async () => {
    const workflow = definition([{ id: 'a' }, { id: 'b' }]);
    workflow.steps[0]!.dependsOn = ['b'];
    workflow.steps[1]!.dependsOn = ['a'];
    const runner: LeafAgentRunner = { run: vi.fn() };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(runner.run).not.toHaveBeenCalled();
    expect(final).toMatchObject({
      state: 'failed', errorCode: 'workflow_deadlock',
      steps: [{ state: 'blocked', errorCode: 'workflow_deadlock' }, { state: 'blocked', errorCode: 'workflow_deadlock' }]
    });
  });

  it('gives workflow timeout deterministic precedence when workflow and step timers coincide', async () => {
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ...result('partial'), stopReason: 'cancelled', incomplete: true }), { once: true });
      })
    };
    const workflow = definition([{ id: 'a' }]);
    workflow.timeoutMs = 10;
    workflow.steps[0]!.timeoutMs = 10;
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final).toMatchObject({ state: 'timed_out', errorCode: 'workflow_timeout' });
    expect(final.steps[0]).toMatchObject({ stopReason: 'workflow_timeout', errorCode: 'workflow_timeout' });
  });

  it('shares the global scheduler with manually started sub-agents', async () => {
    const manual = deferred();
    const starts: string[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        starts.push(runRequest.id);
        return runRequest.id.startsWith('sa_') ? manual.promise : Promise.resolve(result('workflow done'));
      }
    };
    const scheduler = new AgentExecutionScheduler(1);
    const manager = new SubAgentManager(runner, scheduler, () => undefined);
    const subAgent = manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'manual', profile: 'explore',
      providerId: 'provider', model: 'model', timeoutMs: 10_000
    });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const workflowRun = new WorkflowEngine(runner, scheduler)
      .run(request(definition([{ id: 'a' }])), new AbortController().signal, callbacks());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toHaveLength(1);
    manual.resolve(result('manual done'));
    await manager.wait([subAgent.id], new AbortController().signal, 1_000);
    await workflowRun;
    expect(starts).toHaveLength(2);
  });

  it('keeps live usage isolated per step and aggregates final usage', async () => {
    const runner: LeafAgentRunner = {
      run: async (runRequest, _signal, onEvent) => {
        onEvent({ type: 'usage', inputTokens: 2, outputTokens: 1 } satisfies AgentEvent);
        return result(runRequest.id, 2);
      }
    };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2))
      .run(request(definition([{ id: 'a' }, { id: 'b' }])), new AbortController().signal, callbacks());
    expect(final.steps.map((step) => step.usage.inputTokens)).toEqual([2, 2]);
    expect(final.usage).toMatchObject({ inputTokens: 4, outputTokens: 4 });
  });
});

describe('workflow prompt limits', () => {
  it('limits dependency injection and final step output', () => {
    const dependency = {
      id: 'source', state: 'completed' as const, attempt: 1, createdAt: new Date().toISOString(),
      output: 'x'.repeat(MAX_DEPENDENCY_OUTPUT_CHARACTERS + 100), incomplete: false, usage: emptyUsage()
    };
    const prompt = buildStepPrompt(
      WorkflowDefinitionSchema.parse({ schemaVersion: 1, name: 'prompt', steps: [
        { id: 'summary', type: 'agent', task: 'Summarize', dependsOn: [] }
      ] }).steps[0]!,
      [dependency]
    );
    expect(prompt).toContain('[Dependency output truncated]');
    expect(prompt.length).toBeLessThan(MAX_DEPENDENCY_OUTPUT_CHARACTERS + 200);

    const runner: LeafAgentRunner = { run: async () => result('x'.repeat(MAX_STEP_OUTPUT_CHARACTERS + 100)) };
    return new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(definition([{ id: 'a' }])), new AbortController().signal, callbacks())
      .then((final) => {
        expect(final.steps[0]?.output).toHaveLength(MAX_STEP_OUTPUT_CHARACTERS);
        expect(final.steps[0]?.incomplete).toBe(true);
      });
  });
});

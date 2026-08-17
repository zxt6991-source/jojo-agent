import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  ProviderSemaphore,
  SubAgentManager,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  WorkflowEngine
} from '../src/index.js';

type Deferred = { resolve: (result: LeafAgentRunResult) => void; promise: Promise<LeafAgentRunResult> };
function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  const promise = new Promise<LeafAgentRunResult>((done) => { resolve = done; });
  return { resolve, promise };
}

function result(output = 'done'): LeafAgentRunResult {
  return {
    result: output,
    stopReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  };
}

function request(workflow: WorkflowDefinition, providerId = 'openai') {
  return {
    id: `wf_${providerId}`, sessionId: 'session', workingDirectory: process.cwd(),
    providerId, model: 'model', args: {}, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('ProviderSemaphore', () => {
  it('serializes agents that share a provider while other providers may overlap', async () => {
    let active = 0;
    let maximum = 0;
    const gates = new Map<string, Deferred>();
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        active += 1;
        maximum = Math.max(maximum, active);
        const task = deferred();
        gates.set(stepId, task);
        return task.promise.finally(() => { active -= 1; });
      }
    };
    const providers = new ProviderSemaphore({ openai: 1 });
    const same = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'same-provider', maxConcurrency: 3,
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B' }
      ]
    });
    const sameRun = new WorkflowEngine(runner, new AgentExecutionScheduler(3), { providers })
      .run(request(same), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(gates.size).toBe(1));
    expect(gates.has('a')).toBe(true);
    expect(maximum).toBe(1);
    gates.get('a')!.resolve(result('a'));
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get('b')!.resolve(result('b'));
    expect((await sameRun).state).toBe('completed');
    expect(maximum).toBe(1);

    active = 0;
    maximum = 0;
    gates.clear();
    const mixedProviders = new ProviderSemaphore({ openai: 1, anthropic: 1 });
    const openaiRun = new WorkflowEngine(runner, new AgentExecutionScheduler(2), { providers: mixedProviders })
      .run(request(WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'openai', maxConcurrency: 1,
        steps: [{ id: 'left', type: 'agent', task: 'L' }]
      }), 'openai'), new AbortController().signal, callbacks());
    const anthropicRun = new WorkflowEngine(runner, new AgentExecutionScheduler(2), { providers: mixedProviders })
      .run(request(WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'anthropic', maxConcurrency: 1,
        steps: [{ id: 'right', type: 'agent', task: 'R' }]
      }), 'anthropic'), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(maximum).toBe(2);
    gates.get('left')!.resolve(result('left'));
    gates.get('right')!.resolve(result('right'));
    expect((await openaiRun).state).toBe('completed');
    expect((await anthropicRun).state).toBe('completed');
  });

  it('shares a provider semaphore between sub-agents and workflow steps', async () => {
    let active = 0;
    let maximum = 0;
    const gates: Deferred[] = [];
    const runner: LeafAgentRunner = {
      run: () => {
        active += 1;
        maximum = Math.max(maximum, active);
        const task = deferred();
        gates.push(task);
        return task.promise.finally(() => { active -= 1; });
      }
    };
    const providers = new ProviderSemaphore({ openai: 1 });
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(3), () => undefined, { providers });
    const engine = new WorkflowEngine(runner, new AgentExecutionScheduler(3), { providers });
    manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'sub',
      profile: 'explore', providerId: 'openai', model: 'model'
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const workflow = engine.run(request(WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'outer', maxConcurrency: 2,
      steps: [{ id: 'edit', type: 'agent', task: 'Edit' }]
    })), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(providers.queuedCount('openai')).toBe(1));
    expect(gates).toHaveLength(1);
    expect(maximum).toBe(1);
    gates[0]!.resolve(result('sub'));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve(result('edit'));
    expect((await workflow).state).toBe('completed');
    expect(maximum).toBe(1);
  });

  it('cancels a step waiting for a provider slot without starting the runner', async () => {
    const first = deferred();
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return first.promise;
      }
    };
    const controller = new AbortController();
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'cancel-provider', maxConcurrency: 2,
      steps: [
        { id: 'hold', type: 'agent', task: 'Hold' },
        { id: 'wait', type: 'agent', task: 'Wait' }
      ]
    });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(2), {
      providers: new ProviderSemaphore({ openai: 1 })
    }).run(request(workflow), controller.signal, callbacks());
    await vi.waitFor(() => expect(calls).toEqual(['hold']));
    controller.abort();
    first.resolve(result('hold'));
    const final = await running;
    expect(calls).toEqual(['hold']);
    expect(final.steps.find((step) => step.id === 'wait')?.state).toBe('cancelled');
  });
});

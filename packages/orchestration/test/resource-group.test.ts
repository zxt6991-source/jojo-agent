import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  ResourceGroupLimiter,
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

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_groups', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args: {}, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('ResourceGroupLimiter', () => {
  it('serializes agents in the same group and allows different groups to overlap', async () => {
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
    const sameGroup = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'same', maxConcurrency: 3,
      steps: [
        { id: 'a', type: 'agent', task: 'A', resources: { group: 'writers', maxConcurrency: 1 } },
        { id: 'b', type: 'agent', task: 'B', resources: { group: 'writers', maxConcurrency: 1 } },
        { id: 'c', type: 'agent', task: 'C', resources: { group: 'writers' } }
      ]
    });
    const sameRun = new WorkflowEngine(runner, new AgentExecutionScheduler(3))
      .run(request(sameGroup), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(gates.size).toBe(1));
    expect(gates.has('a')).toBe(true);
    gates.get('a')!.resolve(result('a'));
    await vi.waitFor(() => expect(gates.size).toBe(2));
    gates.get('b')!.resolve(result('b'));
    await vi.waitFor(() => expect(gates.size).toBe(3));
    gates.get('c')!.resolve(result('c'));
    const sameFinal = await sameRun;
    expect(sameFinal.state).toBe('completed');
    expect(maximum).toBe(1);
    expect(sameFinal.steps.map((step) => step.resourceGroup)).toEqual(['writers', 'writers', 'writers']);

    active = 0;
    maximum = 0;
    gates.clear();
    const mixed = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'mixed', maxConcurrency: 3,
      steps: [
        { id: 'left', type: 'agent', task: 'L', resources: { group: 'alpha', maxConcurrency: 1 } },
        { id: 'right', type: 'agent', task: 'R', resources: { group: 'beta', maxConcurrency: 1 } }
      ]
    });
    const mixedRun = new WorkflowEngine(runner, new AgentExecutionScheduler(3))
      .run(request(mixed), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(gates.size).toBe(2));
    expect(maximum).toBe(2);
    gates.get('left')!.resolve(result('left'));
    gates.get('right')!.resolve(result('right'));
    expect((await mixedRun).state).toBe('completed');
  });

  it('shares a limiter between sub-agents and workflow steps', async () => {
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
    const groups = new ResourceGroupLimiter();
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(3), () => undefined, { resourceGroups: groups });
    const engine = new WorkflowEngine(runner, new AgentExecutionScheduler(3), { resourceGroups: groups });
    manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'sub',
      profile: 'explore', providerId: 'provider', model: 'model',
      resources: { group: 'shared-writer', maxConcurrency: 1 }
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    const workflow = engine.run(request(WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'outer', maxConcurrency: 2,
      steps: [{ id: 'edit', type: 'agent', task: 'Edit', resources: { group: 'shared-writer', maxConcurrency: 1 } }]
    })), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(groups.queuedCount('shared-writer')).toBe(1));
    expect(gates).toHaveLength(1);
    expect(groups.activeCount('shared-writer')).toBe(1);
    gates[0]!.resolve(result('sub'));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve(result('edit'));
    expect((await workflow).state).toBe('completed');
    expect(maximum).toBe(1);
  });

  it('rejects a second sub-agent that disagrees on group maxConcurrency', () => {
    const runner: LeafAgentRunner = { run: async () => result() };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(2), () => undefined);
    manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'one',
      profile: 'explore', providerId: 'provider', model: 'model',
      resources: { group: 'writers', maxConcurrency: 1 }
    });
    expect(() => manager.start({
      sessionId: 'session', workingDirectory: process.cwd(), task: 'two',
      profile: 'explore', providerId: 'provider', model: 'model',
      resources: { group: 'writers', maxConcurrency: 2 }
    })).toThrow(/already limited to 1/);
  });

  it('cancels a step waiting for a resource group without starting the runner', async () => {
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
      schemaVersion: 1, name: 'cancel-group', maxConcurrency: 2,
      steps: [
        { id: 'hold', type: 'agent', task: 'Hold', resources: { group: 'writers' } },
        { id: 'wait', type: 'agent', task: 'Wait', resources: { group: 'writers' } }
      ]
    });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(2))
      .run(request(workflow), controller.signal, callbacks());
    await vi.waitFor(() => expect(calls).toEqual(['hold']));
    controller.abort();
    first.resolve(result('hold'));
    const final = await running;
    expect(calls).toEqual(['hold']);
    expect(final.steps.find((step) => step.id === 'wait')?.state).toBe('cancelled');
  });

  it('serializes foreach agent instances that share a resource group', async () => {
    let active = 0;
    let maximum = 0;
    const gates: Deferred[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'scan') return Promise.resolve(result(JSON.stringify({ files: ['a.ts', 'b.ts', 'c.ts'] })));
        active += 1;
        maximum = Math.max(maximum, active);
        const task = deferred();
        gates.push(task);
        return task.promise.finally(() => { active -= 1; });
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'foreach-group', maxConcurrency: 3,
      steps: [
        {
          id: 'scan', type: 'agent', task: 'Scan',
          outputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] }
        },
        {
          id: 'review', type: 'foreach', dependsOn: ['scan'], concurrency: 3,
          items: { valueFrom: '$steps.scan.structuredResult.files' },
          template: {
            type: 'agent', profile: 'code-review', task: 'Review {{item}}',
            resources: { group: 'review-writer', maxConcurrency: 1 }
          }
        }
      ]
    });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(3))
      .run(request(workflow), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve(result('a'));
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    gates[1]!.resolve(result('b'));
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2]!.resolve(result('c'));
    const final = await running;
    expect(final.state).toBe('completed');
    expect(maximum).toBe(1);
    expect(final.steps.find((step) => step.id === 'review')?.resourceGroup).toBe('review-writer');
    expect(final.steps.find((step) => step.id === 'review')?.instances?.every((instance) => instance.resourceGroup === 'review-writer')).toBe(true);
  });
});

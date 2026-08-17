import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  asWorkflowChildSnapshot,
  SavedWorkflowRegistry,
  savedWorkflowFromDefinition,
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

function result(output: string, tokens = 1): LeafAgentRunResult {
  return {
    result: output,
    stopReason: 'stop',
    usage: { inputTokens: tokens, outputTokens: tokens, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    incomplete: false
  };
}

function innerWorkflow(): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'inner-review',
    outputStepId: 'work',
    inputs: { target: { type: 'string', required: true } },
    steps: [{ id: 'work', type: 'agent', profile: 'code-review', task: 'Review {{inputs.target}}' }]
  });
}

function request(workflow: WorkflowDefinition, args: Record<string, string | number | boolean> = {}) {
  return {
    id: 'wf_nested', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('WorkflowEngine nested workflow', () => {
  it('runs a saved workflow, interpolates args, and rolls up usage', async () => {
    const registry = new SavedWorkflowRegistry([savedWorkflowFromDefinition(innerWorkflow(), 'builtin')]);
    const tasks: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        tasks.push(runRequest.task);
        return result('inner-done', 3);
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'outer', outputStepId: 'security',
      steps: [{
        id: 'security', type: 'workflow', name: 'inner-review',
        args: { target: 'src/auth.ts' }
      }]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2), { savedWorkflows: registry })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(final.result).toBe('inner-done');
    expect(tasks[0]).toContain('Review src/auth.ts');
    expect(final.steps[0]).toMatchObject({
      type: 'workflow', workflow: 'inner-review', state: 'completed', usage: { inputTokens: 3, outputTokens: 3 }
    });
    expect(asWorkflowChildSnapshot(final.steps[0]?.child)?.steps[0]).toMatchObject({ id: 'work', state: 'completed' });
  });

  it('resolves nested args from a parent step reference', async () => {
    const registry = new SavedWorkflowRegistry([savedWorkflowFromDefinition(innerWorkflow(), 'builtin')]);
    let nestedTask = '';
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'inspect') return result(JSON.stringify({ path: 'pkg/core' }));
        nestedTask = runRequest.task;
        return result('ok');
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'outer',
      steps: [
        {
          id: 'inspect', type: 'agent', task: 'Inspect',
          outputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        },
        {
          id: 'security', type: 'workflow', name: 'inner-review', dependsOn: ['inspect'],
          args: { target: { valueFrom: '$steps.inspect.structuredResult.path' } }
        }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(2), { savedWorkflows: registry })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(nestedTask).toContain('Review pkg/core');
  });

  it('fails unknown saved workflows and over-deep nesting with stable codes', async () => {
    const runner: LeafAgentRunner = { run: async () => result('unused') };
    const missing = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'outer',
        steps: [{ id: 'security', type: 'workflow', name: 'missing-review' }]
      })), new AbortController().signal, callbacks());
    expect(missing.steps[0]).toMatchObject({ state: 'failed', errorCode: 'saved_workflow_not_found' });

    const leaf = savedWorkflowFromDefinition(innerWorkflow(), 'builtin');
    const d3 = savedWorkflowFromDefinition(WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'depth-three',
      steps: [{ id: 'call', type: 'workflow', name: 'inner-review' }]
    }), 'builtin');
    const d2 = savedWorkflowFromDefinition(WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'depth-two',
      steps: [{ id: 'call', type: 'workflow', name: 'depth-three' }]
    }), 'builtin');
    const registry = new SavedWorkflowRegistry([leaf, d3, d2]);
    const tooDeep = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { savedWorkflows: registry })
      .run(request(WorkflowDefinitionSchema.parse({
        schemaVersion: 1, name: 'depth-one',
        steps: [{ id: 'call', type: 'workflow', name: 'depth-two' }]
      })), new AbortController().signal, callbacks());
    expect(tooDeep.state).toBe('failed');
    expect(JSON.stringify(tooDeep)).toContain('workflow_depth_exceeded');
  });

  it('resumes a nested workflow without rerunning completed child steps', async () => {
    const twoStep = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'two-step', outputStepId: 'b',
      steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', dependsOn: ['a'], task: 'B' }
      ]
    });
    const registry = new SavedWorkflowRegistry([savedWorkflowFromDefinition(twoStep, 'builtin')]);
    const pending = new Map<string, Deferred>();
    const firstRunner: LeafAgentRunner = {
      run: (runRequest, signal) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'a') return Promise.resolve(result('done-a', 2));
        const task = deferred();
        pending.set(stepId, task);
        const onAbort = () => task.resolve({ ...result('cancelled'), stopReason: 'cancelled', incomplete: true });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        return task.promise;
      }
    };
    const snapshots: WorkflowRunSnapshot[] = [];
    const controller = new AbortController();
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'outer',
      steps: [{ id: 'security', type: 'workflow', name: 'two-step' }]
    });
    const running = new WorkflowEngine(firstRunner, new AgentExecutionScheduler(1), { savedWorkflows: registry })
      .run(request(workflow), controller.signal, callbacks(snapshots));
    await vi.waitFor(() => expect(pending.has('b')).toBe(true));
    controller.abort();
    const interrupted = await running;
    expect(asWorkflowChildSnapshot(interrupted.steps[0]?.child)?.steps.find((step) => step.id === 'a')?.state).toBe('completed');

    const calls: string[] = [];
    const resumeRunner: LeafAgentRunner = {
      run: async (runRequest) => {
        calls.push(runRequest.id.split(':').at(-1)!);
        return result('resumed');
      }
    };
    const resumed = await new WorkflowEngine(resumeRunner, new AgentExecutionScheduler(1), { savedWorkflows: registry })
      .run(request(workflow), new AbortController().signal, callbacks(), interrupted);
    expect(calls).toEqual(['b']);
    expect(resumed.steps[0]).toMatchObject({ state: 'completed', output: 'resumed' });
    expect(asWorkflowChildSnapshot(resumed.steps[0]?.child)?.steps.find((step) => step.id === 'a')).toMatchObject({
      state: 'completed', output: 'done-a'
    });
  });
});

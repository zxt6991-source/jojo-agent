import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type OrchestrationEvent, type StoredWorkflowRequest, type ToolContext, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  createWorkflowTools,
  emptyUsage,
  type LeafAgentRunner,
  type PersistedWorkflowRun,
  type WorkflowExecutionRequest,
  type WorkflowPersistence,
  WorkflowEngine,
  WorkflowManager
} from '../src/index.js';

class MemoryWorkflowPersistence implements WorkflowPersistence {
  runs: PersistedWorkflowRun[] = [];
  definitionHash(_definition: WorkflowDefinition): string { return 'a'.repeat(64); }
  async create(request: WorkflowExecutionRequest, snapshot: WorkflowRunSnapshot): Promise<void> {
    this.runs.push({
      request: { ...request, definitionHash: this.definitionHash(request.definition) },
      snapshot, warnings: [], definitionHashMatches: true
    });
  }
  async appendTransition(_previous: WorkflowRunSnapshot, next: WorkflowRunSnapshot): Promise<void> {
    const run = this.runs.find((item) => item.snapshot.id === next.id);
    if (run) run.snapshot = next;
  }
  async appendLog(_event: Extract<OrchestrationEvent, { type: 'workflow.log' }>): Promise<void> {}
  async load(runId: string): Promise<PersistedWorkflowRun | null> {
    return this.runs.find((item) => item.snapshot.id === runId) ?? null;
  }
  async list(): Promise<PersistedWorkflowRun[]> { return this.runs; }
}

const validDefinition = {
  schemaVersion: 1 as const,
  name: 'manager workflow',
  outputStepId: 'summary',
  steps: [
    { id: 'inspect', type: 'agent' as const, profile: 'explore' as const, task: 'Inspect' },
    { id: 'summary', type: 'agent' as const, profile: 'synthesize' as const, task: 'Summarize', dependsOn: ['inspect'] }
  ]
};

function startInput(definition: unknown = validDefinition) {
  return {
    sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model', definition
  };
}

describe('WorkflowManager', () => {
  it('starts immediately, runs in the background, and emits monotonic revisions', async () => {
    const events: OrchestrationEvent[] = [];
    const runner: LeafAgentRunner = {
      run: async (request) => ({
        result: request.profile === 'synthesize' ? 'final summary' : 'evidence',
        stopReason: 'stop', usage: emptyUsage(), incomplete: false
      })
    };
    const manager = new WorkflowManager(
      new WorkflowEngine(runner, new AgentExecutionScheduler(2)),
      (event) => events.push(event)
    );
    const started = manager.start(startInput());
    expect(started.state).toBe('running');
    const final = await manager.wait(started.id, new AbortController().signal, 1_000);
    expect(final).toMatchObject({ state: 'completed', result: 'final summary' });
    const revisions = events
      .filter((event): event is Extract<OrchestrationEvent, { type: 'workflow.changed' }> => event.type === 'workflow.changed')
      .map((event) => event.workflow.revision);
    expect(revisions.length).toBeGreaterThan(2);
    expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)).toBe(true);
  });

  it('rejects invalid definitions before registering a run', () => {
    const runner: LeafAgentRunner = { run: vi.fn() };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(1)), () => undefined);
    try {
      manager.start(startInput({ schemaVersion: 1, name: 'bad', steps: [
        { id: 'a', type: 'agent', task: 'A', dependsOn: ['missing'] }
      ] }));
      throw new Error('Expected invalid workflow to be rejected.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'workflow_invalid_definition' });
    }
    expect(manager.list('session')).toEqual([]);
  });

  it('propagates manager cancellation and waits for the child to quiesce', async () => {
    let started = false;
    let aborted = false;
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        started = true;
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({ result: '', stopReason: 'cancelled', usage: emptyUsage(), incomplete: true });
        }, { once: true });
      })
    };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(1)), () => undefined);
    const workflow = manager.start(startInput({
      schemaVersion: 1, name: 'cancel', steps: [{ id: 'a', type: 'agent', task: 'Wait' }]
    }));
    await vi.waitFor(() => expect(started).toBe(true));
    expect(manager.cancel(workflow.id)?.state).toBe('cancelled');
    const final = await manager.wait(workflow.id, new AbortController().signal, 1_000);
    expect(aborted).toBe(true);
    expect(final.state).toBe('cancelled');
  });

  it('returns a structured not-found error and safely handles concurrent start/get/cancel', async () => {
    const starts: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (request, signal) => new Promise((resolve) => {
        starts.push(request.id);
        signal.addEventListener('abort', () => resolve({
          result: '', stopReason: 'cancelled', usage: emptyUsage(), incomplete: true
        }), { once: true });
      })
    };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(3)), () => undefined);
    expect(() => manager.cancel('wf_missing')).toThrowError(expect.objectContaining({ code: 'workflow_not_found' }));
    const runs = Array.from({ length: 3 }, (_, index) => manager.start(startInput({
      schemaVersion: 1, name: `concurrent ${index}`, steps: [{ id: 'run', type: 'agent', task: 'Wait' }]
    })));
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(runs.map((run) => manager.get(run.id)?.id)).toEqual(runs.map((run) => run.id));
    for (const run of runs) expect(manager.cancel(run.id).state).toBe('cancelled');
    const settled = await Promise.all(runs.map((run) => manager.wait(run.id, new AbortController().signal, 1_000)));
    expect(settled.every((run) => run.state === 'cancelled')).toBe(true);
  });

  it('quiesces all workflows in a session and flushes persistence writes', async () => {
    let persistenceFinished = false;
    const persistence = new MemoryWorkflowPersistence();
    persistence.appendTransition = async (_previous, next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const run = persistence.runs.find((item) => item.snapshot.id === next.id);
      if (run) run.snapshot = next;
      persistenceFinished = true;
    };
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({
        result: '', stopReason: 'cancelled', usage: emptyUsage(), incomplete: true
      }), { once: true }))
    };
    const manager = new WorkflowManager(
      new WorkflowEngine(runner, new AgentExecutionScheduler(2)), () => undefined, { persistence }
    );
    const first = manager.start(startInput({
      schemaVersion: 1, name: 'first', steps: [{ id: 'run', type: 'agent', task: 'Wait' }]
    }));
    const second = manager.start(startInput({
      schemaVersion: 1, name: 'second', steps: [{ id: 'run', type: 'agent', task: 'Wait' }]
    }));
    await vi.waitFor(() => {
      expect(manager.get(first.id)?.steps[0]?.state).toBe('running');
      expect(manager.get(second.id)?.steps[0]?.state).toBe('running');
    });

    await manager.quiesceSession('session');

    expect(manager.get(first.id)?.state).toBe('cancelled');
    expect(manager.get(second.id)?.state).toBe('cancelled');
    expect(persistenceFinished).toBe(true);
  });

  it('restores interrupted work, reuses completed steps, and accrues rerun usage', async () => {
    const persistence = new MemoryWorkflowPersistence();
    const createdAt = new Date().toISOString();
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'resume workflow', outputStepId: 'c', steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] },
        { id: 'c', type: 'agent', task: 'C', dependsOn: ['b'] }
      ]
    });
    const request: StoredWorkflowRequest = {
      id: 'wf_resume', sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model',
      args: {}, definition, definitionHash: persistence.definitionHash(definition), createdAt
    };
    const usage = (inputTokens: number) => ({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
    persistence.runs.push({ request, warnings: [], definitionHashMatches: true, snapshot: {
      id: request.id, sessionId: request.sessionId, name: definition.name, state: 'running', revision: 4,
      createdAt, startedAt: createdAt, failedStepIds: [], blockedStepIds: [], incomplete: false,
      usage: usage(3), steps: [
        { id: 'a', state: 'completed', attempt: 1, createdAt, startedAt: createdAt, finishedAt: createdAt, output: 'A done', incomplete: false, usage: usage(1) },
        { id: 'b', state: 'running', attempt: 1, createdAt, startedAt: createdAt, incomplete: false, usage: usage(2) },
        { id: 'c', state: 'pending', attempt: 1, createdAt, incomplete: false, usage: usage(0) }
      ]
    } });
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        calls.push(stepId);
        return { result: `${stepId} done`, stopReason: 'stop', usage: usage(stepId === 'b' ? 3 : 4), incomplete: false };
      }
    };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(2)), () => undefined, { persistence });
    const [restored] = await manager.restore();
    expect(restored).toMatchObject({ state: 'interrupted', steps: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'interrupted' }, { id: 'c', state: 'pending' }] });
    manager.resume(request.id);
    const final = await manager.wait(request.id, new AbortController().signal, 1_000);
    expect(calls).toEqual(['b', 'c']);
    expect(final).toMatchObject({
      state: 'completed', result: 'c done', usage: usage(10),
      steps: [{ id: 'a', attempt: 1 }, { id: 'b', attempt: 2 }, { id: 'c', attempt: 1 }]
    });
  });

  it('rejects resume when the persisted definition hash is invalid', async () => {
    const persistence = new MemoryWorkflowPersistence();
    const createdAt = new Date().toISOString();
    const definition = WorkflowDefinitionSchema.parse(validDefinition);
    persistence.runs.push({
      request: { id: 'wf_mismatch', sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model', args: {}, definition, definitionHash: 'b'.repeat(64), createdAt },
      warnings: ['mismatch'], definitionHashMatches: false,
      snapshot: {
        id: 'wf_mismatch', sessionId: 'session', name: definition.name, state: 'interrupted', revision: 1, createdAt,
        steps: definition.steps.map((step) => ({ id: step.id, state: 'pending', attempt: 1, createdAt, incomplete: false, usage: emptyUsage() })),
        usage: emptyUsage(), failedStepIds: [], blockedStepIds: [], incomplete: true
      }
    });
    const manager = new WorkflowManager(new WorkflowEngine({ run: vi.fn() }, new AgentExecutionScheduler(1)), () => undefined, { persistence });
    await manager.restore();
    expect(() => manager.resume('wf_mismatch')).toThrowError(expect.objectContaining({ code: 'workflow_resume_mismatch' }));
  });
});

describe('workflow tools', () => {
  it('exposes start/wait/status/cancel and returns structured results', async () => {
    const tasks: string[] = [];
    const runner: LeafAgentRunner = {
      run: async (request) => {
        tasks.push(request.task);
        return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    };
    const manager = new WorkflowManager(new WorkflowEngine(runner, new AgentExecutionScheduler(2)), () => undefined);
    const tools = createWorkflowTools(manager, { providerId: 'provider', model: 'model' });
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'workflow_start', 'workflow_wait', 'workflow_status', 'workflow_cancel', 'workflow_resume'
    ]);
    const context: ToolContext = {
      sessionId: 'session', workingDirectory: process.cwd(), signal: new AbortController().signal,
      approved: true, onProgress: () => undefined
    };
    const start = await tools[0]!.execute({ definition: {
      schemaVersion: 1, name: 'tool workflow', steps: [{ id: 'a', type: 'agent', task: 'A' }]
    } }, context);
    expect(start.ok).toBe(true);
    const id = (JSON.parse(start.content) as { id: string }).id;
    const waited = await tools[1]!.execute({ id, timeoutMs: 1_000 }, context);
    expect(waited.ok).toBe(true);
    expect(JSON.parse(waited.content)).toMatchObject({ id, state: 'completed' });

    const invalid = await tools[0]!.execute({ definition: {
      schemaVersion: 1, name: 'invalid', steps: [{ id: 'a', type: 'agent', task: 'A', dependsOn: ['missing'] }]
    } }, context);
    expect(invalid).toMatchObject({ ok: false, code: 'workflow_invalid_definition' });

    const yaml = await tools[0]!.execute({ definition: `
schemaVersion: 1
name: yaml workflow
steps:
  - id: yaml_step
    type: agent
    task: Parse YAML
` }, context);
    expect(yaml.ok).toBe(true);
    const yamlId = (JSON.parse(yaml.content) as { id: string }).id;
    await expect(manager.wait(yamlId, context.signal, 1_000)).resolves.toMatchObject({ state: 'completed' });

    const missingCancel = await tools[3]!.execute({ id: 'wf_missing' }, context);
    expect(missingCancel).toMatchObject({ ok: false, code: 'workflow_not_found' });

    const withArgs = await tools[0]!.execute({
      args: { target: 'packages/orchestration' },
      definition: {
        schemaVersion: 1, name: 'args workflow', steps: [{
          id: 'inspect', type: 'agent', task: 'Inspect',
          inputs: { target: { valueFrom: '$workflow.args.target' } }
        }]
      }
    }, context);
    expect(withArgs.ok).toBe(true);
    const argsId = (JSON.parse(withArgs.content) as { id: string }).id;
    await manager.wait(argsId, context.signal, 1_000);
    expect(tasks.at(-1)).toContain('"target": "packages/orchestration"');
  });
});

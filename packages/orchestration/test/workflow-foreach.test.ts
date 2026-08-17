import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowRunSnapshot } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  OrchestrationError,
  resolveForeachItems,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  type WorkflowToolRuntime,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function foreachDefinition(options: {
  itemLimit?: number;
  concurrency?: number;
  continueOnError?: boolean;
  maxConcurrency?: number;
  template?: Record<string, unknown>;
  extraSteps?: unknown[];
  outputStepId?: string;
  scanSchema?: Record<string, unknown>;
  scanTask?: string;
} = {}): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: 1,
    name: 'foreach workflow',
    maxConcurrency: options.maxConcurrency ?? 3,
    outputStepId: options.outputStepId ?? 'review',
    steps: [
      {
        id: 'scan',
        type: 'agent',
        task: options.scanTask ?? 'Scan',
        outputSchema: options.scanSchema ?? {
          type: 'object',
          properties: { files: { type: 'array' } },
          required: ['files']
        }
      },
      {
        id: 'review',
        type: 'foreach',
        dependsOn: ['scan'],
        items: { valueFrom: '$steps.scan.structuredResult.files' },
        ...(options.itemLimit !== undefined ? { itemLimit: options.itemLimit } : {}),
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
        ...(options.continueOnError !== undefined ? { continueOnError: options.continueOnError } : {}),
        template: options.template ?? {
          type: 'agent',
          profile: 'code-review',
          task: 'Review {{item}} at {{index}}'
        }
      },
      ...(options.extraSteps ?? [])
    ]
  });
}

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_foreach', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args: {}, definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

function scanThen(files: unknown, then: LeafAgentRunner['run']): LeafAgentRunner {
  return {
    run: async (runRequest, signal, onEvent) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      if (stepId === 'scan') return result(JSON.stringify({ files }));
      return then(runRequest, signal, onEvent);
    }
  };
}

describe('resolveForeachItems', () => {
  it('rejects non-arrays and oversize lists without truncating', () => {
    expect(() => resolveForeachItems({ files: [] }, 8)).toThrowError(expect.objectContaining({ code: 'foreach_items_invalid' }));
    expect(() => resolveForeachItems(['a', 'b', 'c'], 2)).toThrowError(expect.objectContaining({ code: 'foreach_item_limit' }));
    expect(resolveForeachItems(['a'], 8)).toEqual(['a']);
  });
});

describe('WorkflowEngine foreach', () => {
  it('completes with an empty structured result when there are 0 items', async () => {
    const runner = scanThen([], async () => result('should not run'));
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition()), new AbortController().signal, callbacks());
    expect(final).toMatchObject({ state: 'completed', result: '[]' });
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      type: 'foreach',
      state: 'completed',
      structuredResult: [],
      instances: []
    });
  });

  it('runs a single item and interpolates {{item}} and {{index}}', async () => {
    const tasks: string[] = [];
    const runner = scanThen(['src/a.ts'], async (runRequest) => {
      tasks.push(runRequest.task);
      return result('reviewed-a');
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition()), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(tasks[0]).toContain('Review src/a.ts at 0');
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'completed',
      structuredResult: ['reviewed-a'],
      instances: [{ id: 'review__0', state: 'completed', item: 'src/a.ts', index: 0 }]
    });
  });

  it('runs 8 items at the default limit', async () => {
    const files = Array.from({ length: 8 }, (_, index) => `f${index}.ts`);
    const starts: string[] = [];
    const runner = scanThen(files, async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      starts.push(stepId);
      return result(`out-${stepId}`);
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition()), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(starts).toHaveLength(8);
    expect(final.steps.find((step) => step.id === 'review')?.structuredResult).toEqual(
      files.map((_, index) => `out-review__${index}`)
    );
  });

  it('fails with foreach_item_limit when 9 items exceed itemLimit 8', async () => {
    const files = Array.from({ length: 9 }, (_, index) => `f${index}.ts`);
    const runner = scanThen(files, async () => result('should not run'));
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ itemLimit: 8 })), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'failed',
      errorCode: 'foreach_item_limit'
    });
    expect(final.steps.find((step) => step.id === 'review')?.instances).toBeUndefined();
    expect(final.state).toBe('failed');
  });

  it('fails with foreach_items_invalid when the source is not an array', async () => {
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1,
      name: 'invalid items',
      steps: [
        {
          id: 'scan',
          type: 'agent',
          task: 'Scan',
          outputSchema: { type: 'object' }
        },
        {
          id: 'review',
          type: 'foreach',
          dependsOn: ['scan'],
          items: { valueFrom: '$steps.scan.structuredResult' },
          template: { type: 'agent', task: 'Review {{item}}' }
        }
      ]
    });
    const runner: LeafAgentRunner = { run: async () => result(JSON.stringify({ ok: true })) };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'failed',
      errorCode: 'foreach_items_invalid'
    });
  });

  it('keeps structuredResult in index order when later items finish first', async () => {
    const runner = scanThen(['slow', 'fast'], async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      if (stepId === 'review__0') {
        await delay(40);
        return result('first');
      }
      return result('second');
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ concurrency: 2 })), new AbortController().signal, callbacks());
    expect(final.steps.find((step) => step.id === 'review')?.structuredResult).toEqual(['first', 'second']);
  });

  it('stops starting new items when continueOnError is false', async () => {
    const starts: string[] = [];
    const runner = scanThen(['a', 'b', 'c'], async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      starts.push(stepId);
      if (stepId === 'review__0') throw new OrchestrationError('provider_error', 'boom');
      return result(`ok-${stepId}`);
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ concurrency: 1, continueOnError: false })), new AbortController().signal, callbacks());
    expect(starts).toEqual(['review__0']);
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'failed',
      errorCode: 'provider_error'
    });
    expect(final.steps.find((step) => step.id === 'review')?.instances?.map((instance) => instance.state)).toEqual([
      'failed', 'cancelled', 'cancelled'
    ]);
  });

  it('collects every item and completes when continueOnError is true', async () => {
    const starts: string[] = [];
    const runner = scanThen(['a', 'b', 'c'], async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      starts.push(stepId);
      if (stepId === 'review__0') throw new OrchestrationError('provider_error', 'boom');
      return result(`ok-${stepId}`);
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ concurrency: 1, continueOnError: true })), new AbortController().signal, callbacks());
    expect(starts.sort()).toEqual(['review__0', 'review__1', 'review__2']);
    const review = final.steps.find((step) => step.id === 'review');
    expect(review).toMatchObject({ state: 'completed', incomplete: true });
    expect(review?.instances?.map((instance) => instance.state)).toEqual(['failed', 'completed', 'completed']);
    expect(final.state).toBe('completed');
  });

  it('serializes agent instances through the global scheduler while foreach concurrency is 2', async () => {
    let current = 0;
    let max = 0;
    const runner = scanThen(['a', 'b'], async () => {
      current += 1;
      max = Math.max(max, current);
      await delay(20);
      current -= 1;
      return result('ok');
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(foreachDefinition({ concurrency: 2 })), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(max).toBe(1);
  });

  it('lets tool instances overlap without taking agent scheduler slots', async () => {
    let current = 0;
    let max = 0;
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        if (runRequest.id.endsWith(':scan')) return result(JSON.stringify({ files: ['a', 'b'] }));
        throw new Error('leaf agent should not run foreach tool instances');
      }
    };
    const toolRuntime: WorkflowToolRuntime = {
      has: () => true,
      execute: async (invocation) => {
        current += 1;
        max = Math.max(max, current);
        await delay(30);
        current -= 1;
        return { ok: true, content: String(invocation.input.path) };
      }
    };
    const workflow = foreachDefinition({
      concurrency: 2,
      template: { type: 'tool', tool: 'read_file', input: { path: '{{item}}' } }
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(max).toBe(2);
    expect(final.steps.find((step) => step.id === 'review')?.structuredResult).toEqual(['a', 'b']);
  });

  it('skips completed instances on resume and keeps stored items', async () => {
    const pending = new Map<string, Deferred>();
    const firstRunner: LeafAgentRunner = {
      run: (runRequest, signal) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'scan') return Promise.resolve(result(JSON.stringify({ files: ['a.ts', 'b.ts'] })));
        if (stepId === 'review__0') return Promise.resolve(result('ok-a', 2));
        const task = deferred();
        pending.set(stepId, task);
        const onAbort = () => task.resolve({
          ...result('cancelled'),
          stopReason: 'cancelled',
          incomplete: true
        });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        return task.promise;
      }
    };
    const snapshots: WorkflowRunSnapshot[] = [];
    const controller = new AbortController();
    const running = new WorkflowEngine(firstRunner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ concurrency: 1 })), controller.signal, callbacks(snapshots));
    await vi.waitFor(() => {
      expect(pending.has('review__1')).toBe(true);
      const review = snapshots.at(-1)?.steps.find((step) => step.id === 'review');
      expect(review?.instances?.[0]?.state).toBe('completed');
      expect(review?.instances?.[1]?.state).toBe('running');
    });
    controller.abort();
    const interrupted = await running;
    expect(interrupted.steps.find((step) => step.id === 'review')?.instances?.[0]).toMatchObject({
      state: 'completed', output: 'ok-a', item: 'a.ts'
    });

    const calls: string[] = [];
    const resumeRunner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        calls.push(stepId);
        return result(`resumed-${stepId}`);
      }
    };
    const resumed = await new WorkflowEngine(resumeRunner, new AgentExecutionScheduler(4))
      .run(request(foreachDefinition({ concurrency: 1 })), new AbortController().signal, callbacks(), interrupted);
    expect(calls).toEqual(['review__1']);
    expect(resumed.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'completed',
      structuredResult: ['ok-a', 'resumed-review__1']
    });
    expect(resumed.steps.find((step) => step.id === 'review')?.instances?.[0]).toMatchObject({
      state: 'completed', output: 'ok-a', item: 'a.ts'
    });
  });

  it('exposes foreach structuredResult to a downstream typed input', async () => {
    let summaryTask = '';
    const workflow = foreachDefinition({
      extraSteps: [{
        id: 'summary',
        type: 'agent',
        task: 'Summarize',
        dependsOn: ['review'],
        inputs: { first: { valueFrom: '$steps.review.structuredResult.0' } }
      }],
      outputStepId: 'summary'
    });
    const runner: LeafAgentRunner = {
      run: async (runRequest) => {
        const stepId = runRequest.id.split(':').at(-1)!;
        if (stepId === 'scan') return result(JSON.stringify({ files: ['a.ts'] }));
        if (stepId === 'summary') {
          summaryTask = runRequest.task;
          return result('done');
        }
        return result(`reviewed-${stepId}`);
      }
    };
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(4))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.state).toBe('completed');
    expect(final.result).toBe('done');
    expect(summaryTask).toContain('"first": "reviewed-review__0"');
  });

  it('retries a failed foreach template instance without rerunning the parent expansion', async () => {
    const calls: string[] = [];
    const runner = scanThen(['only.ts'], async (runRequest) => {
      const stepId = runRequest.id.split(':').at(-1)!;
      calls.push(stepId);
      if (calls.filter((id) => id === stepId).length === 1) {
        throw new OrchestrationError('provider_error', 'transient');
      }
      return result('recovered');
    });
    const workflow = foreachDefinition({
      template: {
        type: 'agent',
        profile: 'code-review',
        task: 'Review {{item}}',
        retry: { maxAttempts: 2, backoffMs: 0, retryOn: ['provider_error'] }
      }
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(calls).toEqual(['review__0', 'review__0']);
    expect(final.steps.find((step) => step.id === 'review')).toMatchObject({
      state: 'completed',
      structuredResult: ['recovered']
    });
    expect(final.steps.find((step) => step.id === 'review')?.instances?.[0]?.attempt).toBe(2);
  });
});

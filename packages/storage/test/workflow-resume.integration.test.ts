import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionSchema } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  type LeafAgentRunner,
  WorkflowEngine,
  WorkflowManager
} from '../../orchestration/src/index.js';
import { JsonlWorkflowStore } from '../src/index.js';

function stepId(runId: string): string {
  return runId.split(':').at(-1)!;
}

describe('workflow persistence and resume integration', () => {
  it('restores a started run, ignores duplicate Journal state, and does not rerun completed steps', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-resume-'));
    const persistence = new JsonlWorkflowStore(directory);
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'crash recovery', outputStepId: 'c', steps: [
        { id: 'a', type: 'agent', task: 'A' },
        { id: 'b', type: 'agent', task: 'B', dependsOn: ['a'] },
        { id: 'c', type: 'agent', task: 'C', dependsOn: ['b'] }
      ]
    });
    const firstRunner: LeafAgentRunner = {
      run: async (request, signal) => {
        if (stepId(request.id) === 'a') return { result: 'A complete', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({
          result: '', stopReason: 'cancelled', usage: emptyUsage(), incomplete: true
        }), { once: true }));
      }
    };
    const firstManager = new WorkflowManager(
      new WorkflowEngine(firstRunner, new AgentExecutionScheduler(1)), () => undefined, { persistence }
    );
    const started = firstManager.start({
      sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model', definition
    });
    await vi.waitFor(async () => {
      const saved = await persistence.load(started.id);
      expect(saved?.snapshot.steps).toMatchObject([{ id: 'a', state: 'completed' }, { id: 'b', state: 'running' }, { id: 'c', state: 'pending' }]);
    });
    const duplicate = (await persistence.load(started.id))!.snapshot;
    await persistence.appendTransition(duplicate, duplicate);

    const resumedCalls: string[] = [];
    const resumedRunner: LeafAgentRunner = {
      run: async (request) => {
        const id = stepId(request.id);
        resumedCalls.push(id);
        return { result: `${id.toUpperCase()} complete`, stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    };
    const restoredManager = new WorkflowManager(
      new WorkflowEngine(resumedRunner, new AgentExecutionScheduler(1)), () => undefined, { persistence }
    );
    const [restored] = await restoredManager.restore();
    expect(restored).toMatchObject({
      state: 'interrupted',
      steps: [{ id: 'a', state: 'completed' }, { id: 'b', state: 'interrupted' }, { id: 'c', state: 'pending' }]
    });
    restoredManager.resume(started.id);
    await expect(restoredManager.wait(started.id, new AbortController().signal, 1_000)).resolves.toMatchObject({
      state: 'completed', result: 'C complete'
    });
    expect(resumedCalls).toEqual(['b', 'c']);

    firstManager.cancel(started.id);
    await firstManager.wait(started.id, new AbortController().signal, 1_000);
  });

  it('recomputes blocked dependencies after resume', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workflow-blocked-resume-'));
    const persistence = new JsonlWorkflowStore(directory);
    const definition = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'blocked recovery', steps: [
        { id: 'source', type: 'agent', task: 'Fail' },
        { id: 'dependent', type: 'agent', task: 'Blocked', dependsOn: ['source'] }
      ]
    });
    const failingRunner: LeafAgentRunner = { run: async () => { throw new Error('provider failed'); } };
    const firstManager = new WorkflowManager(
      new WorkflowEngine(failingRunner, new AgentExecutionScheduler(1)), () => undefined, { persistence }
    );
    const started = firstManager.start({
      sessionId: 'session', workingDirectory: process.cwd(), providerId: 'provider', model: 'model', definition
    });
    await expect(firstManager.wait(started.id, new AbortController().signal, 1_000)).resolves.toMatchObject({
      state: 'failed', steps: [{ id: 'source', state: 'failed' }, { id: 'dependent', state: 'blocked' }]
    });

    const calls: string[] = [];
    const resumedManager = new WorkflowManager(new WorkflowEngine({
      run: async (request) => { calls.push(stepId(request.id)); throw new Error('provider still failed'); }
    }, new AgentExecutionScheduler(1)), () => undefined, { persistence });
    await resumedManager.restore();
    resumedManager.resume(started.id);
    const final = await resumedManager.wait(started.id, new AbortController().signal, 1_000);
    expect(calls).toEqual(['source']);
    expect(final).toMatchObject({
      state: 'failed',
      steps: [{ id: 'source', state: 'failed', attempt: 2 }, { id: 'dependent', state: 'blocked', attempt: 2 }]
    });
  });
});

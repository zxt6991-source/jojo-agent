import { describe, expect, it } from 'vitest';
import type { OrchestrationEvent } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  WorkflowEngine,
  WorkflowManager
} from '@desktop-agent/orchestration';
import type { Schedule, ScheduleRun, WorkflowScheduleTarget } from '@desktop-agent/scheduler';
import { WorkflowScheduleDispatcher } from './workflow-schedule-dispatcher';

describe('WorkflowScheduleDispatcher', () => {
  it('uses the deterministic scheduler id and mirrors workflow completion', async () => {
    const listeners = new Set<(event: OrchestrationEvent) => void>();
    const manager = new WorkflowManager(
      new WorkflowEngine({
        run: async () => ({ result: 'workflow result', stopReason: 'stop', usage: emptyUsage(), incomplete: false })
      }, new AgentExecutionScheduler(2)),
      (event) => { for (const listener of listeners) listener(event); }
    );
    const dispatcher = new WorkflowScheduleDispatcher(manager, (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const target: WorkflowScheduleTarget = {
      kind: 'workflow', sessionId: 'session', workingDirectory: process.cwd(),
      providerId: 'provider', model: 'model',
      workflow: {
        kind: 'inline',
        definition: {
          schemaVersion: 1,
          name: 'scheduled-workflow',
          outputStepId: 'run',
          steps: [{ id: 'run', type: 'agent', profile: 'explore', task: 'Run' }]
        }
      }
    };
    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: 'sch_workflow', name: 'Workflow', enabled: true,
      spec: { kind: 'once', runAt: '2026-09-01T00:00:00.000Z' }, target,
      misfire: { kind: 'skip' }, concurrency: 'skip', revision: 1, createdBy: 'user',
      createdAt: now, updatedAt: now
    };
    const run: ScheduleRun = {
      id: 'sr_workflow', scheduleId: schedule.id, occurrenceKey: 'manual:1', scheduledFor: now,
      trigger: 'manual', status: 'dispatching', targetKind: 'workflow', targetSnapshot: target,
      createdAt: now, version: 1
    };
    const completed = new Promise<string>((resolve) => dispatcher.subscribe((event) => {
      if (event.snapshot.state === 'completed') resolve(event.snapshot.resultPreview ?? '');
    }));
    const initial = await dispatcher.dispatch({ schedule, run, target, executionId: 'schedrun:sr_workflow' });
    expect(initial).toMatchObject({ id: 'schedrun:sr_workflow', kind: 'workflow', state: 'running' });
    await expect(completed).resolves.toBe('workflow result');
    expect(manager.get('schedrun:sr_workflow')?.state).toBe('completed');
    dispatcher.close();
  });
});

import { ScriptedProvider } from '@desktop-agent/agent';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { describe, expect, it } from 'vitest';
import { AgentScheduleDispatcher, type AgentScheduleTarget, type Schedule, type ScheduleRun } from '../src/index.js';

describe('AgentScheduleDispatcher', () => {
  it('uses a stable runtime run id, a dedicated persistent lane, and scheduler trigger', async () => {
    const contexts: Array<import('@desktop-agent/agent-runtime').RuntimeResolutionContext> = [];
    const runtime = createAgentRuntime({
      environment: {
        host: { kind: 'test' },
        providers: { resolve: (context) => {
          contexts.push(context);
          return new ScriptedProvider([[
            { type: 'text_delta', text: 'scheduled answer' },
            { type: 'response_completed', stopReason: 'stop' }
          ]]);
        } },
        tools: { resolve: () => ({ snapshot: () => [] }) },
        permissions: { check: async () => ({ decision: 'allow' }) }
      }
    });
    await runtime.openSession({ id: 'session-1', executionScope: { kind: 'none' } });
    const preparedLanes: string[] = [];
    let disposed = 0;
    const dispatcher = new AgentScheduleDispatcher(runtime, {
      prepare: async (_input, laneId) => {
        preparedLanes.push(laneId);
        return { dispose: () => { disposed += 1; } };
      }
    });
    const target = {
      kind: 'agent', sessionId: 'session-1', input: { content: [{ type: 'text', text: 'review' }] },
      providerId: 'provider', model: 'model'
    } satisfies AgentScheduleTarget;
    const schedule: Schedule = {
      id: 'sch_1', name: 'Review', enabled: true,
      spec: { kind: 'once', runAt: '2026-08-31T00:00:00.000Z' },
      target,
      misfire: { kind: 'skip' }, concurrency: 'skip', nextRunAt: '2026-08-31T00:00:00.000Z',
      revision: 1, createdBy: 'user-1', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z'
    };
    const run: ScheduleRun = {
      id: 'sr_1', scheduleId: schedule.id, occurrenceKey: 'timer:1', scheduledFor: schedule.nextRunAt!,
      trigger: 'timer', status: 'dispatching', targetKind: 'agent', createdAt: schedule.createdAt,
      targetSnapshot: target, version: 1
    };
    const completed = new Promise<TargetEvent>((resolve) => {
      dispatcher.subscribe((event) => { if (event.snapshot.state === 'completed') resolve(event); });
    });
    const initial = await dispatcher.dispatch({
      schedule, run, target, executionId: 'schedrun:sr_1'
    });
    expect(initial).toEqual({ kind: 'agent', id: 'schedrun:sr_1', state: 'running' });
    await expect(completed).resolves.toMatchObject({
      snapshot: { id: 'schedrun:sr_1', state: 'completed', resultPreview: 'scheduled answer' }
    });
    await Promise.resolve();
    expect(preparedLanes).toEqual(['schedule:sch_1']);
    expect(disposed).toBe(1);
    expect(contexts[0]).toMatchObject({ trigger: { kind: 'scheduler', id: 'sr_1' }, actor: { kind: 'main' } });
    expect((await runtime.getSession('session-1'))?.listLanes()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'schedule:sch_1' })
    ]));
    dispatcher.close();
    await runtime.close();
  });
});

type TargetEvent = { snapshot: { state: string; [key: string]: unknown } };

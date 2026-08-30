import { describe, expect, it } from 'vitest';
import type { OrchestrationEvent, TeamDefinition } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  MemoryTeamStore,
  TeamManager
} from '@desktop-agent/orchestration';
import type { Schedule, ScheduleRun, TeamMemberScheduleTarget } from '@desktop-agent/scheduler';
import { TeamMemberScheduleDispatcher } from './team-schedule-dispatcher';

describe('TeamMemberScheduleDispatcher', () => {
  it('uses the deterministic scheduler execution id and mirrors completion', async () => {
    const listeners = new Set<(event: OrchestrationEvent) => void>();
    const manager = new TeamManager(
      new MemoryTeamStore(),
      {
        run: async (request) => ({
          result: `done:${request.task}`,
          stopReason: 'stop',
          runId: 'runtime-run',
          usage: emptyUsage(),
          incomplete: false
        })
      },
      new AgentExecutionScheduler(2),
      (event) => { for (const listener of listeners) listener(event); }
    );
    const now = new Date().toISOString();
    await manager.create({
      id: 'reviewers', name: 'Reviewers', workspace: process.cwd(), maxConcurrency: 1,
      members: [{ id: 'reviewer', name: 'Reviewer', profile: 'explore' }],
      createdAt: now, updatedAt: now
    } satisfies TeamDefinition);
    const dispatcher = new TeamMemberScheduleDispatcher(manager, (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const target: TeamMemberScheduleTarget = {
      kind: 'team_member', teamId: 'reviewers', memberId: 'reviewer', task: 'review',
      parentSessionId: 'session', providerId: 'provider', model: 'model'
    };
    const schedule: Schedule = {
      id: 'sch_team', name: 'Team review', enabled: true,
      spec: { kind: 'once', runAt: '2026-09-01T00:00:00.000Z' }, target,
      misfire: { kind: 'skip' }, concurrency: 'skip', revision: 1, createdBy: 'user',
      createdAt: now, updatedAt: now
    };
    const run: ScheduleRun = {
      id: 'sr_team', scheduleId: schedule.id, occurrenceKey: 'manual:1', scheduledFor: now,
      trigger: 'manual', status: 'dispatching', targetKind: 'team_member', targetSnapshot: target,
      createdAt: now, version: 1
    };
    const completed = new Promise<string>((resolve) => dispatcher.subscribe((event) => {
      if (event.snapshot.state === 'completed') resolve(event.snapshot.resultPreview ?? '');
    }));
    const initial = await dispatcher.dispatch({ schedule, run, target, executionId: 'schedrun:sr_team' });
    expect(initial).toMatchObject({ id: 'schedrun:sr_team', kind: 'team_member' });
    await expect(completed).resolves.toContain('done:');
    expect((await manager.getTask('schedrun:sr_team'))?.state).toBe('completed');
    dispatcher.close();
  });
});

import { describe, expect, it } from 'vitest';
import type { TeamDefinition } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  emptyUsage,
  MemoryTeamStore,
  TeamManager,
  type OrchestratedAgentRunner
} from '../src/index.js';

function definition(): TeamDefinition {
  const now = new Date().toISOString();
  return {
    id: 'engineering',
    name: 'Engineering',
    workspace: process.cwd(),
    maxConcurrency: 2,
    members: [
      { id: 'architect', name: 'Architect', profile: 'explore' },
      { id: 'developer', name: 'Developer', profile: 'explore' }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function delayedRunner(input: {
  delay?: number;
  lanes?: string[];
  onConcurrency?: (active: number, laneActive: number) => void;
} = {}): OrchestratedAgentRunner {
  let active = 0;
  const perLane = new Map<string, number>();
  return {
    async run(request) {
      input.lanes?.push(request.laneId);
      active += 1;
      const laneActive = (perLane.get(request.laneId) ?? 0) + 1;
      perLane.set(request.laneId, laneActive);
      input.onConcurrency?.(active, laneActive);
      await new Promise((resolve) => setTimeout(resolve, input.delay ?? 20));
      active -= 1;
      perLane.set(request.laneId, laneActive - 1);
      return {
        result: `done:${request.task}`,
        stopReason: 'stop',
        runId: `run:${request.id}:${crypto.randomUUID()}`,
        usage: emptyUsage(),
        incomplete: false
      };
    }
  };
}

describe('TeamManager', () => {
  it('keeps a stable lane and serializes tasks for one member', async () => {
    const store = new MemoryTeamStore();
    const lanes: string[] = [];
    let maxLaneActive = 0;
    const manager = new TeamManager(store, delayedRunner({
      lanes,
      onConcurrency: (_active, laneActive) => { maxLaneActive = Math.max(maxLaneActive, laneActive); }
    }), new AgentExecutionScheduler(4), () => undefined);
    await manager.create(definition());
    const first = await manager.delegate({
      teamId: 'engineering', memberId: 'architect', task: 'first',
      parent: { sessionId: 'session' }, providerId: 'provider', model: 'model'
    });
    const second = await manager.delegate({
      teamId: 'engineering', memberId: 'architect', task: 'second',
      parent: { sessionId: 'session' }, providerId: 'provider', model: 'model'
    });
    const settled = await manager.wait([first.id, second.id], new AbortController().signal, 2_000);
    expect(settled.map((task) => task.state)).toEqual(['completed', 'completed']);
    expect(lanes).toEqual(['member:architect', 'member:architect']);
    expect(maxLaneActive).toBe(1);
  });

  it('runs different members in parallel within the team limit', async () => {
    const store = new MemoryTeamStore();
    let maxActive = 0;
    const manager = new TeamManager(store, delayedRunner({
      delay: 40,
      onConcurrency: (active) => { maxActive = Math.max(maxActive, active); }
    }), new AgentExecutionScheduler(4), () => undefined);
    await manager.create(definition());
    const first = await manager.delegate({
      teamId: 'engineering', memberId: 'architect', task: 'first',
      parent: { sessionId: 'session' }, providerId: 'provider', model: 'model'
    });
    const second = await manager.delegate({
      teamId: 'engineering', memberId: 'developer', task: 'second',
      parent: { sessionId: 'session' }, providerId: 'provider', model: 'model'
    });
    await manager.wait([first.id, second.id], new AbortController().signal, 2_000);
    expect(maxActive).toBe(2);
  });

  it('uses an injected task id idempotently and rejects conflicting input', async () => {
    const store = new MemoryTeamStore();
    const manager = new TeamManager(store, delayedRunner(), new AgentExecutionScheduler(2), () => undefined);
    await manager.create(definition());
    const request = {
      taskId: 'tt_sched_run_1',
      teamId: 'engineering', memberId: 'architect', task: 'scheduled review',
      parent: { sessionId: 'session' }, providerId: 'provider', model: 'model'
    };
    const first = await manager.delegate(request);
    const duplicate = await manager.delegate(request);
    expect(duplicate.id).toBe(first.id);
    await expect(manager.delegate({ ...request, task: 'different task' }))
      .rejects.toMatchObject({ code: 'team_task_conflict' });
  });

  it('persists inbox messages without waking the recipient', async () => {
    const store = new MemoryTeamStore();
    let runs = 0;
    const manager = new TeamManager(store, {
      run: async () => {
        runs += 1;
        return { result: 'done', stopReason: 'stop', usage: emptyUsage(), incomplete: false };
      }
    }, new AgentExecutionScheduler(2), () => undefined);
    await manager.create(definition());
    await manager.sendMessage({
      teamId: 'engineering', memberId: 'developer', message: 'Please review this.', kind: 'question'
    });
    const inbox = await manager.listInbox({ teamId: 'engineering', memberId: 'developer' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.status).toBe('unread');
    expect(runs).toBe(0);
  });

  it('marks previously running tasks interrupted during recovery', async () => {
    const store = new MemoryTeamStore();
    const manager = new TeamManager(store, delayedRunner(), new AgentExecutionScheduler(1), () => undefined);
    await manager.create(definition());
    const team = await store.getTeam('engineering');
    expect(team).toBeDefined();
    const now = new Date().toISOString();
    await store.createTask({
      id: 'tt_crashed', teamId: 'engineering', memberId: 'architect',
      input: 'unsafe task', state: 'running', providerId: 'provider', model: 'model',
      usage: emptyUsage(), incomplete: false, createdAt: now, startedAt: now
    });
    const recovered = new TeamManager(store, delayedRunner(), new AgentExecutionScheduler(1), () => undefined);
    await recovered.initialize();
    expect((await store.getTask('tt_crashed'))?.state).toBe('interrupted');
  });
});

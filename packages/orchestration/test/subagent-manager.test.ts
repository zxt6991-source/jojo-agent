import { describe, expect, it, vi } from 'vitest';
import type { LeafAgentRunRequest, LeafAgentRunResult, LeafAgentRunner } from '../src/index.js';
import { AgentExecutionScheduler, emptyUsage, SubAgentManager } from '../src/index.js';

type Deferred = { resolve: (result: LeafAgentRunResult) => void; promise: Promise<LeafAgentRunResult> };
function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined;
  const promise = new Promise<LeafAgentRunResult>((done) => { resolve = done; });
  return { resolve, promise };
}

function completed(result = 'done', incomplete = false): LeafAgentRunResult {
  return { result, stopReason: incomplete ? 'max_iterations' : 'stop', usage: emptyUsage(), incomplete };
}

function request(task: string) {
  return {
    sessionId: 'session-1', workingDirectory: process.cwd(), task, label: task,
    profile: 'explore' as const, providerId: 'provider', model: 'model', timeoutMs: 10_000
  };
}

describe('SubAgentManager', () => {
  it('starts three leaf agents before any of them completes', async () => {
    const pending = new Map<string, Deferred>();
    const started: LeafAgentRunRequest[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        started.push(runRequest);
        const task = deferred();
        pending.set(runRequest.id, task);
        return task.promise;
      }
    };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(3), () => undefined);
    const agents = ['a', 'b', 'c'].map((task) => manager.start(request(task)));

    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started.every((item) => item.task.length === 1)).toBe(true);
    for (const agent of agents) pending.get(agent.id)!.resolve(completed(agent.label));
    const results = await manager.wait(agents.map((agent) => agent.id), new AbortController().signal, 1_000);
    expect(results.map((agent) => agent.state)).toEqual(['completed', 'completed', 'completed']);
  });

  it('never exceeds scheduler concurrency', async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const runner: LeafAgentRunner = {
      run: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return completed();
      }
    };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(2), () => undefined);
    const agents = ['a', 'b', 'c', 'd'].map((task) => manager.start(request(task)));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.shift()!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    for (const release of releases.splice(0)) release();
    await manager.wait(agents.map((agent) => agent.id), new AbortController().signal, 1_000);
    expect(maximum).toBe(2);
  });

  it('cancels a queued agent without invoking the runner', async () => {
    const first = deferred();
    const calls: string[] = [];
    const runner: LeafAgentRunner = {
      run: (runRequest) => {
        calls.push(runRequest.task);
        return first.promise;
      }
    };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const running = manager.start(request('running'));
    const queued = manager.start(request('queued'));
    await vi.waitFor(() => expect(calls).toEqual(['running']));
    expect(manager.cancel(queued.id)?.state).toBe('cancelled');
    first.resolve(completed());
    await manager.wait([running.id, queued.id], new AbortController().signal, 1_000);
    expect(calls).toEqual(['running']);
  });

  it('preserves partial output and usage as incomplete', async () => {
    const usage = { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 };
    const runner: LeafAgentRunner = { run: async () => ({ ...completed('partial', true), usage }) };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const agent = manager.start(request('partial'));
    const [snapshot] = await manager.wait([agent.id], new AbortController().signal, 1_000);
    expect(snapshot).toMatchObject({ state: 'completed', result: 'partial', incomplete: true, usage });
  });

  it('marks an over-time running agent as timed out', async () => {
    const runner: LeafAgentRunner = {
      run: async (_request, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(completed('', true)), { once: true });
      })
    };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const agent = manager.start({ ...request('timeout'), timeoutMs: 10 });
    const [snapshot] = await manager.wait([agent.id], new AbortController().signal, 1_000);
    expect(snapshot).toMatchObject({ state: 'timed_out', stopReason: 'timeout', incomplete: true });
  });

  it('lets wait time out without cancelling the background agent', async () => {
    const pending = deferred();
    const runner: LeafAgentRunner = { run: async () => pending.promise };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const agent = manager.start(request('background'));
    const snapshot = (await manager.wait([agent.id], new AbortController().signal, 10))[0]!;
    expect(snapshot.state).toBe('running');
    pending.resolve(completed());
    const finished = (await manager.wait([agent.id], new AbortController().signal, 1_000))[0]!;
    expect(finished.state).toBe('completed');
  });

  it('structurally rejects nested agents', () => {
    const runner: LeafAgentRunner = { run: vi.fn(async () => completed()) };
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    expect(() => manager.start({ ...request('nested'), depth: 1 })).toThrow('nested_subagent_forbidden');
  });
});

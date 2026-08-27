import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import { runAgentTurn } from '@desktop-agent/agent-runtime/compat';
import { MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/store';
import { WorkflowDefinitionSchema, type PermissionGate, type ProviderConfig } from '@desktop-agent/contracts';
import { AgentExecutionScheduler, SubAgentManager, WorkflowEngine } from '@desktop-agent/orchestration';
import { createDesktopLeafAgentRunner } from './orchestration-runtime.js';

const providerConfig: ProviderConfig = {
  id: 'test-provider',
  name: 'Test Provider',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  models: ['test-model'],
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  hasApiKey: true
};

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

async function seedMainLane(runtimeStore: MemoryAgentRuntimeStore, sessionId = 'session-1'): Promise<void> {
  await runAgentTurn({
    sessionId,
    workingDirectory: process.cwd(),
    model: 'test-model',
    providerId: 'test-provider',
    history: [],
    userText: 'main task',
    provider: new ScriptedProvider([[
      { type: 'text_delta', text: 'main answer' },
      { type: 'response_completed', stopReason: 'stop' }
    ]]),
    tools: [],
    permissionGate: allow,
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => true,
    runtimeStore
  });
}

describe('desktop leaf agent runtime', () => {
  it('shares the parent runtime tree and continues on one child lane', async () => {
    const runtimeStore = new MemoryAgentRuntimeStore();
    await seedMainLane(runtimeStore);

    let round = 0;
    const runner = createDesktopLeafAgentRunner({
      trashDirectory: process.cwd(),
      runtimeStore,
      resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
      createModelProvider: () => {
        round += 1;
        return new ScriptedProvider([[
          { type: 'text_delta', text: `child answer ${round}` },
          { type: 'response_completed', stopReason: 'stop' }
        ]]);
      }
    });
    const manager = new SubAgentManager(runner, new AgentExecutionScheduler(1), () => undefined);
    const started = manager.start({
      sessionId: 'session-1',
      workingDirectory: process.cwd(),
      task: 'child task',
      profile: 'explore',
      providerId: 'test-provider',
      model: 'test-model'
    });
    const first = (await manager.wait([started.id], new AbortController().signal, 1_000))[0]!;
    expect(first).toMatchObject({ state: 'idle', result: 'child answer 1' });

    manager.send(started.id, 'follow up');
    const second = (await manager.wait([started.id], new AbortController().signal, 1_000))[0]!;
    expect(second).toMatchObject({ state: 'idle', result: 'child answer 2' });

    const childLane = await runtimeStore.getLane('session-1', `agent:${started.id}`);
    const path = await runtimeStore.readPath(childLane?.leafId ?? null);
    const text = path.flatMap((entry) => entry.type === 'message'
      ? entry.message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
      : []);
    expect(text).toEqual([
      'main task',
      'main answer',
      'child task',
      'child answer 1',
      'follow up',
      'child answer 2'
    ]);
    expect((await runtimeStore.listLanes('session-1')).map((lane) => lane.name)).toEqual([
      `agent:${started.id}`,
      'main'
    ]);
  });

  it('adapts workflow agent steps to workflow lanes rooted at the main leaf', async () => {
    const runtimeStore = new MemoryAgentRuntimeStore();
    await seedMainLane(runtimeStore, 'workflow-session');
    const mainLane = await runtimeStore.getLane('workflow-session', 'main');
    const mainPath = await runtimeStore.readPath(mainLane?.leafId ?? null);
    const runner = createDesktopLeafAgentRunner({
      trashDirectory: process.cwd(),
      runtimeStore,
      resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
      createModelProvider: ({ request }) => new ScriptedProvider([[
        { type: 'text_delta', text: `output ${request.id}` },
        { type: 'response_completed', stopReason: 'stop' }
      ]])
    });
    const engine = new WorkflowEngine(runner, new AgentExecutionScheduler(2));
    const result = await engine.run({
      id: 'wf_runtime',
      sessionId: 'workflow-session',
      workingDirectory: process.cwd(),
      providerId: 'test-provider',
      model: 'test-model',
      args: {},
      definition: WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'runtime lanes',
        maxConcurrency: 2,
        steps: [
          { id: 'a', type: 'agent', profile: 'explore', task: 'Task A' },
          { id: 'b', type: 'agent', profile: 'explore', task: 'Task B' }
        ]
      }),
      createdAt: new Date().toISOString()
    }, new AbortController().signal, { onChanged: () => undefined, onLog: () => undefined });

    expect(result.state).toBe('completed');
    const lanes = await runtimeStore.listLanes('workflow-session');
    expect(lanes.map((lane) => lane.name)).toEqual([
      'main',
      'workflow:wf_runtime:a',
      'workflow:wf_runtime:b'
    ]);
    for (const lane of lanes.filter((item) => item.name.startsWith('workflow:'))) {
      const path = await runtimeStore.readPath(lane.leafId);
      expect(path.slice(0, mainPath.length).map((entry) => entry.id))
        .toEqual(mainPath.map((entry) => entry.id));
    }
  });
});

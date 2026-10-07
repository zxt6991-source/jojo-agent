import { createProductRuntime, RuntimeEnvironmentRegistry } from '@desktop-agent/runtime-composition';
import { MemoryServerStateStore } from '@desktop-agent/app-service';
import { describeTestProvider } from '@desktop-agent/agent-runtime/testing';
import { legacyModelConfig } from '@desktop-agent/contracts';
import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/spi';
import { WorkflowDefinitionSchema, type PermissionGate, type ProviderConfig } from '@desktop-agent/contracts';
import { AgentExecutionScheduler, SubAgentManager, WorkflowEngine } from '@desktop-agent/orchestration';
import {
  MemoryPermissionAuditSink,
  PermissionGovernanceEngine
} from '@desktop-agent/permission-governance';
import { createDesktopOrchestratedAgentRunner, createDesktopLeafAgentRunner, createDesktopWorkflowToolRuntime } from './orchestration-runtime.js';

const providerConfig: ProviderConfig = {
  id: 'test-provider',
  name: 'Test Provider',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.test/v1',
  model: 'test-model',
  models: [legacyModelConfig('test-model', 128_000, 4_096)],
  hasApiKey: true
};

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

async function seedMainLane(runtimeStore: MemoryAgentRuntimeStore, sessionId = 'session-1'): Promise<void> {
  const runtime = createAgentRuntime({
    store: runtimeStore,
    environment: {
      host: { kind: 'test' },
      providers: { describe: describeTestProvider, resolve: () => new ScriptedProvider([[
      { type: 'text_delta', text: 'main answer' },
      { type: 'response_completed', stopReason: 'stop' }
      ]]) },
      tools: { resolve: () => ({ snapshot: () => [] }) },
      permissions: allow
    }
  });
  const session = await runtime.openSession({
    id: sessionId,
    executionScope: { kind: 'workspace', workingDirectory: process.cwd() }
  });
  await (await (await session.getLane()).run({
    input: 'main task',
    model: 'test-model',
    providerId: 'test-provider'
  })).result;
  await runtime.close();
}

describe('desktop leaf agent runtime', () => {
  it('audits direct workflow tool steps with run and step identity', async () => {
    const audit = new MemoryPermissionAuditSink();
    const runtime = createDesktopWorkflowToolRuntime({
      trashDirectory: process.cwd(),
      governance: { engine: new PermissionGovernanceEngine(), audit }
    });

    await expect(runtime.execute({
      name: 'list_files', input: { path: '.' }, sessionId: 'workflow-session', workingDirectory: process.cwd(),
      workflowRunId: 'run-1', workflowId: 'workflow-1', workflowStepId: 'files',
      providerId: 'test-provider', model: 'test-model', signal: new AbortController().signal
    })).resolves.toMatchObject({ ok: true });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      request: {
        context: {
          sessionId: 'workflow-session', laneId: 'workflow:workflow-1:files', runId: 'run-1',
          actor: { kind: 'workflow', id: 'run-1', profile: 'tool-step' }
        },
        call: { name: 'list_files' }
      },
      decision: { effect: 'allow', source: 'baseline' }
    });
  });

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


it.each(['subagent', 'team_member', 'workflow'] as const)('indexes %s runs through App Service without losing execution context', async kind => {
  const environments = new RuntimeEnvironmentRegistry();
  const stateStore = new MemoryServerStateStore();
  const product = await createProductRuntime({ recovery: 'preserve', application: { stateStore }, runtime: {
    host: { kind: 'desktop' }, providers: environments.providers, tools: environments.tools,
    permissions: environments.permissions, telemetry: environments.telemetry, runContext: environments.runContext
  } });
  const actor = kind === 'team_member'
    ? { kind, id: 'actor', profile: 'explore', teamId: 'team', memberId: 'member', taskId: 'task' } as const
    : kind === 'workflow'
      ? { kind, id: 'actor', profile: 'explore', workflowId: 'workflow', stepId: 'step' } as const
      : { kind, id: 'actor', profile: 'explore' } as const;
  const runner = createDesktopOrchestratedAgentRunner({
    trashDirectory: process.cwd(), runtimeService: { runtime: product.runtime, environments }, application: product.application,
    resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
    createModelProvider: () => new ScriptedProvider([[
      { type: 'text_delta', text: 'indexed result' }, { type: 'response_completed', stopReason: 'stop' }
    ]])
  });
  try {
    const result = await runner.run({ id: 'execution', sessionId: 'orchestrated', laneId: 'child',
      workingDirectory: process.cwd(), task: 'test task', actor, profile: 'explore',
      providerId: providerConfig.id, model: providerConfig.model, maxIterations: 4, timeoutMs: 10_000
    }, new AbortController().signal, () => undefined);
    expect(result.result).toBe('indexed result');
    expect(await stateStore.sessions.get('orchestrated')).toBeDefined();
    const indexed = await stateStore.runs.get(result.runId!);
    expect(indexed).toMatchObject({ sessionId: 'orchestrated', laneId: 'child', status: 'completed', requestMeta: { origin: { kind } }, result: { finalText: 'indexed result' } });
    const execution = (await product.runtime.inspectRun(result.runId!))!.execution;
    expect(execution).toMatchObject({ actor: { kind, id: 'execution', profile: 'explore' }, trigger: { kind, id: 'execution' } });
    if (kind === 'team_member') expect(execution).toMatchObject({ team: { id: 'team', memberId: 'member', taskId: 'task' } });
    if (kind === 'workflow') expect(execution).toMatchObject({ workflow: { id: 'workflow', stepId: 'step' } });
    expect(environments.has('orchestrated', 'child')).toBe(false);
    await expect(stateStore.approvals.createPending({ id: 'approval', sessionId: 'orchestrated', laneId: 'child',
      runId: result.runId!, toolCallId: 'call', toolName: 'tool', reason: 'audit', requestHash: 'hash'
    })).resolves.toMatchObject({ runId: result.runId });
  } finally { await product.close(); }
});

it('records failed orchestrated runs and releases their environment binding', async () => {
  const environments = new RuntimeEnvironmentRegistry();
  const stateStore = new MemoryServerStateStore();
  const product = await createProductRuntime({ recovery: 'preserve', application: { stateStore }, runtime: {
    host: { kind: 'desktop' }, providers: environments.providers, tools: environments.tools,
    permissions: environments.permissions
  } });
  const runner = createDesktopOrchestratedAgentRunner({
    trashDirectory: process.cwd(), runtimeService: { runtime: product.runtime, environments }, application: product.application,
    resolveProvider: () => ({ config: providerConfig, apiKey: 'test-key' }),
    createModelProvider: () => ({ async *stream() { yield { type: 'text_delta', text: '' }; throw new Error('provider failed'); } })
  });
  try {
    await expect(runner.run({ id: 'failed-execution', sessionId: 'failed-session', laneId: 'child',
      workingDirectory: process.cwd(), task: 'test task', actor: { kind: 'workflow', id: 'actor', profile: 'explore', workflowId: 'w' },
      profile: 'explore', providerId: providerConfig.id, model: providerConfig.model, maxIterations: 4, timeoutMs: 10_000
    }, new AbortController().signal, () => undefined)).rejects.toThrow('provider failed');
    expect(await stateStore.runs.list('failed-session')).toEqual([
      expect.objectContaining({ status: 'failed', laneId: 'child', error: expect.objectContaining({ message: 'provider failed' }) })
    ]);
    expect(environments.has('failed-session', 'child')).toBe(false);
  } finally { await product.close(); }
});

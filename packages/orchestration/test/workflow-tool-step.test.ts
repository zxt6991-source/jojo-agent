import { describe, expect, it, vi } from 'vitest';
import type { PermissionGate, Tool, WorkflowDefinition } from '@desktop-agent/contracts';
import { WorkflowDefinitionSchema } from '@desktop-agent/contracts';
import {
  AgentExecutionScheduler,
  createWorkflowToolRuntime,
  mergeWorkflowToolInput,
  type LeafAgentRunResult,
  type LeafAgentRunner,
  type WorkflowToolRuntime,
  WorkflowEngine
} from '../src/index.js';
import type { WorkflowRunSnapshot } from '@desktop-agent/contracts';

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

function request(workflow: WorkflowDefinition) {
  return {
    id: 'wf_tool', sessionId: 'session', workingDirectory: process.cwd(),
    providerId: 'provider', model: 'model', args: { query: 'WorkflowEngine' },
    definition: workflow, createdAt: new Date().toISOString()
  };
}

function callbacks(snapshots: WorkflowRunSnapshot[] = []) {
  return { onChanged: (snapshot: WorkflowRunSnapshot) => snapshots.push(snapshot), onLog: () => undefined };
}

describe('WorkflowEngine tool steps', () => {
  it('executes an allowlisted tool step without calling the leaf agent', async () => {
    const runner: LeafAgentRunner = { run: vi.fn(async () => result('should not run')) };
    const toolRuntime: WorkflowToolRuntime = {
      has: (name) => name === 'list_files',
      execute: async (invocation) => ({ ok: true, content: `listed ${String(invocation.input.path)}` })
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'files', outputStepId: 'files',
      steps: [{ id: 'files', type: 'tool', tool: 'list_files', input: { path: 'src' } }]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(runner.run).not.toHaveBeenCalled();
    expect(final).toMatchObject({ state: 'completed', result: 'listed src' });
    expect(final.steps[0]).toMatchObject({ type: 'tool', tool: 'list_files', state: 'completed', output: 'listed src' });
  });

  it('fails when the workflow tool runtime is missing or the tool is unregistered', async () => {
    const runner: LeafAgentRunner = { run: async () => result('unused') };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'files',
      steps: [{ id: 'files', type: 'tool', tool: 'list_files', input: { path: '.' } }]
    });
    const missingRuntime = await new WorkflowEngine(runner, new AgentExecutionScheduler(1))
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(missingRuntime.steps[0]).toMatchObject({ state: 'failed', errorCode: 'tool_not_allowed' });

    const unregistered = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), {
      toolRuntime: { has: () => false, execute: async () => ({ ok: true, content: 'nope' }) }
    }).run(request(workflow), new AbortController().signal, callbacks());
    expect(unregistered.steps[0]).toMatchObject({ state: 'failed', errorCode: 'tool_not_allowed' });
  });

  it('maps permission denials to a stable step error code', async () => {
    const runner: LeafAgentRunner = { run: async () => result('unused') };
    const toolRuntime: WorkflowToolRuntime = {
      has: () => true,
      execute: async () => ({ ok: false, content: 'Searching outside the working directory is not allowed.', code: 'permission_denied' })
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'denied',
      steps: [{ id: 'search', type: 'tool', tool: 'grep', input: { query: 'secret', path: '..' } }]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(final.steps[0]).toMatchObject({
      state: 'failed', errorCode: 'permission_denied', incomplete: true
    });
    expect(final.state).toBe('failed');
  });

  it('overlays typed inputs onto static tool input', async () => {
    let received: Record<string, unknown> | undefined;
    const runner: LeafAgentRunner = {
      run: async () => result('{"query":"WorkflowEngine","extra":"keep-out"}')
    };
    const toolRuntime: WorkflowToolRuntime = {
      has: (name) => name === 'grep',
      execute: async (invocation) => {
        received = invocation.input;
        return { ok: true, content: 'engine.ts:1:class WorkflowEngine' };
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'typed tool', outputStepId: 'search',
      steps: [
        {
          id: 'source', type: 'agent', task: 'Find query',
          outputSchema: {
            type: 'object',
            properties: { query: { type: 'string' }, extra: { type: 'string' } },
            required: ['query', 'extra']
          }
        },
        {
          id: 'search', type: 'tool', tool: 'grep', dependsOn: ['source'],
          input: { path: 'packages/orchestration', maxResults: 5 },
          inputs: { query: { valueFrom: '$steps.source.structuredResult.query' } }
        }
      ]
    });
    const final = await new WorkflowEngine(runner, new AgentExecutionScheduler(1), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    expect(received).toEqual({ path: 'packages/orchestration', maxResults: 5, query: 'WorkflowEngine' });
    expect(final).toMatchObject({ state: 'completed', result: 'engine.ts:1:class WorkflowEngine' });
  });

  it('runs a tool step while an agent step holds the only scheduler slot', async () => {
    const hold = deferred();
    let agentStarted = false;
    let toolStarted = false;
    const runner: LeafAgentRunner = {
      run: async () => {
        agentStarted = true;
        await hold.promise;
        return result('agent done');
      }
    };
    const toolRuntime: WorkflowToolRuntime = {
      has: (name) => name === 'list_files',
      execute: async () => {
        toolStarted = true;
        return { ok: true, content: 'dir src' };
      }
    };
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: 1, name: 'parallel', maxConcurrency: 2,
      steps: [
        { id: 'hold', type: 'agent', profile: 'explore', task: 'Hold the LLM slot' },
        { id: 'files', type: 'tool', tool: 'list_files', input: { path: '.' } }
      ]
    });
    const running = new WorkflowEngine(runner, new AgentExecutionScheduler(1), { toolRuntime })
      .run(request(workflow), new AbortController().signal, callbacks());
    await vi.waitFor(() => expect(agentStarted).toBe(true));
    await vi.waitFor(() => expect(toolStarted).toBe(true));
    hold.resolve(result('agent done'));
    const final = await running;
    expect(final.state).toBe('completed');
    expect(final.steps.map((step) => [step.id, step.type, step.state])).toEqual([
      ['hold', 'agent', 'completed'],
      ['files', 'tool', 'completed']
    ]);
  });
});

describe('createWorkflowToolRuntime', () => {
  it('enforces the allowlist and permission gate before executing a tool', async () => {
    const executed: string[] = [];
    const listFiles: Tool = {
      definition: { name: 'list_files', description: 'List', inputSchema: { type: 'object' } },
      execute: async () => {
        executed.push('list_files');
        return { callId: '', ok: true, content: 'dir src' };
      }
    };
    const terminal: Tool = {
      definition: { name: 'terminal', description: 'Shell', inputSchema: { type: 'object' } },
      execute: async () => {
        executed.push('terminal');
        return { callId: '', ok: true, content: 'pwned' };
      }
    };
    const gate: PermissionGate = {
      check: async (call) => call.name === 'list_files' && (call.input as { path?: string }).path === '..'
        ? { decision: 'deny', reason: 'outside workspace', code: 'permission_denied' }
        : { decision: 'allow' }
    };
    const runtime = createWorkflowToolRuntime({ tools: [listFiles, terminal], permissionGate: gate });
    expect(runtime.has('list_files')).toBe(true);
    expect(runtime.has('terminal')).toBe(false);

    const denied = await runtime.execute({
      name: 'list_files', input: { path: '..' }, sessionId: 'session', workingDirectory: process.cwd(),
      workflowRunId: 'run', workflowId: 'workflow', workflowStepId: 'step', providerId: 'provider', model: 'model',
      signal: new AbortController().signal
    });
    expect(denied).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(executed).toEqual([]);

    const blocked = await runtime.execute({
      name: 'terminal', input: { command: 'ls' }, sessionId: 'session', workingDirectory: process.cwd(),
      workflowRunId: 'run', workflowId: 'workflow', workflowStepId: 'step', providerId: 'provider', model: 'model',
      signal: new AbortController().signal
    });
    expect(blocked).toMatchObject({ ok: false, code: 'tool_not_allowed' });
    expect(executed).toEqual([]);

    const ok = await runtime.execute({
      name: 'list_files', input: { path: '.' }, sessionId: 'session', workingDirectory: process.cwd(),
      workflowRunId: 'run', workflowId: 'workflow', workflowStepId: 'step', providerId: 'provider', model: 'model',
      signal: new AbortController().signal
    });
    expect(ok).toEqual({ ok: true, content: 'dir src' });
    expect(executed).toEqual(['list_files']);
  });

  it('passes complete workflow identity to a contextual permission gate', async () => {
    const listFiles: Tool = {
      definition: { name: 'list_files', description: 'List', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: '', ok: true, content: 'dir src' })
    };
    const contextualPermissionGate = {
      check: vi.fn(async () => ({ decision: 'allow' as const }))
    };
    const runtime = createWorkflowToolRuntime({
      tools: [listFiles],
      permissionGate: { check: async () => ({ decision: 'deny', reason: 'legacy gate should not run' }) },
      contextualPermissionGate
    });
    const invocation = {
      name: 'list_files', input: { path: '.' }, sessionId: 'session', workingDirectory: process.cwd(),
      workflowRunId: 'run-1', workflowId: 'workflow-1', workflowStepId: 'step-1',
      providerId: 'provider', model: 'model', signal: new AbortController().signal
    };

    await expect(runtime.execute(invocation)).resolves.toMatchObject({ ok: true });
    expect(contextualPermissionGate.check).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'list_files' }),
      invocation
    );
  });
});

describe('mergeWorkflowToolInput', () => {
  it('lets resolved typed inputs overlay static tool input', () => {
    expect(mergeWorkflowToolInput({ path: 'src', query: 'static' }, { query: 'resolved' })).toEqual({
      path: 'src',
      query: 'resolved'
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ScriptedProvider } from '@desktop-agent/agent';
import type {
  HookEventName,
  HookInjectionResult,
  HookPayloadMap,
  HookRuntime,
  InjectingHookEvent,
  Message,
  ModelProvider,
  ModelRequest,
  PermissionGate,
  PreToolUseHookResult,
  PreToolUsePayload,
  SessionStartPayload,
  SideEffectHookEvent,
  Tool
} from '@desktop-agent/contracts';
import { DefaultHookRuntime, HookRegistry, MemoryHookInvocationStore } from '@desktop-agent/hooks';
import {
  createReadyState,
  emptyProgressState,
  MemoryAgentRuntimeStore,
  resumeAgentTurn,
  runAgentTurn,
  type OperationMeta,
  type RuntimeAgentRunOptions,
  type ToolsState
} from '../src/index.js';

const tool: Tool = {
  definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
  replay: 'safe',
  execute: async () => ({ callId: '', ok: true, content: 'tool output' })
};
const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };

class ScriptedHooks implements HookRuntime {
  readonly events: HookEventName[] = [];
  readonly injections: Array<{ event: InjectingHookEvent; payload: HookPayloadMap[InjectingHookEvent] }> = [];
  constructor(
    private readonly configuredEvents: HookEventName[],
    private readonly injection: HookInjectionResult = { additionalContext: '' },
    private readonly preTool: PreToolUseHookResult = { decision: 'neutral' }
  ) {}
  configured(event: HookEventName): boolean { return this.configuredEvents.includes(event); }
  async inject<E extends InjectingHookEvent>(event: E, payload: HookPayloadMap[E]): Promise<HookInjectionResult> {
    this.events.push(event);
    this.injections.push({ event, payload });
    return this.injection;
  }
  async preToolUse(_payload: PreToolUsePayload): Promise<PreToolUseHookResult> {
    this.events.push('PreToolUse');
    return this.preTool;
  }
  async dispatch<E extends SideEffectHookEvent>(event: E, _payload: HookPayloadMap[E]): Promise<void> {
    this.events.push(event);
  }
}

function options(provider: ModelProvider, hooks: HookRuntime, overrides: Partial<RuntimeAgentRunOptions> = {}): RuntimeAgentRunOptions {
  return {
    sessionId: 'session-hooks',
    operationId: 'operation-hooks',
    workingDirectory: process.cwd(),
    model: 'model-1',
    providerId: 'provider-1',
    history: [],
    userText: 'question',
    provider,
    tools: [tool],
    permissionGate: allow,
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => true,
    hooks,
    ...overrides
  };
}

describe('agent runtime hook integration', () => {
  it('persists UserPromptSubmit context separately and projects it to the model', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    const store = new MemoryAgentRuntimeStore();
    const hooks = new ScriptedHooks(['UserPromptSubmit'], {
      additionalContext: 'remember this', hookIds: ['builtin.memory']
    });
    const result = await runAgentTurn(options(provider, hooks, { runtimeStore: store }));

    expect(result.messages).toHaveLength(2);
    expect(requests[0]?.messages).toHaveLength(2);
    expect(requests[0]?.messages[1]).toMatchObject({ metadata: { internal: true } });
    expect((requests[0]?.messages[1]?.content[0] as { text: string }).text).toContain('remember this');
    const lane = await store.getLane('session-hooks', 'main');
    expect((await store.readPath(lane?.leafId ?? null)).some((entry) => entry.type === 'hook_context')).toBe(true);
  });

  it('turns a PreToolUse block into a durable tool result without executing the tool', async () => {
    const execute = vi.fn(tool.execute);
    const hooks = new ScriptedHooks(['PreToolUse'], { additionalContext: '' }, {
      decision: 'block', reason: 'blocked by policy'
    });
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'blocked acknowledged' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);
    const result = await runAgentTurn(options(provider, hooks, { tools: [{ ...tool, execute }] }));

    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({
      type: 'tool_result', result: expect.objectContaining({ code: 'hook_blocked', content: 'blocked by policy' })
    }));
  });

  it('never lets hook approval override a permission deny', async () => {
    const execute = vi.fn(tool.execute);
    const hooks = new ScriptedHooks(['PreToolUse'], { additionalContext: '' }, {
      decision: 'approve', canSkipApproval: true
    });
    const deny: PermissionGate = { check: async () => ({ decision: 'deny', reason: 'hard boundary' }) };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]
    ]);
    const result = await runAgentTurn(options(provider, hooks, { permissionGate: deny, tools: [{ ...tool, execute }] }));

    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({
      type: 'tool_result', result: expect.objectContaining({ code: 'permission_denied' })
    }));
  });

  it('allows a capable trusted hook to satisfy ask without calling the UI', async () => {
    const execute = vi.fn(tool.execute);
    const approve = vi.fn(async () => false);
    const ask: PermissionGate = {
      check: async (call, context) => ({
        decision: 'ask',
        request: { requestId: 'request-1', sessionId: context.sessionId, call, reason: 'confirm' }
      })
    };
    const hooks = new ScriptedHooks(['PreToolUse'], { additionalContext: '' }, {
      decision: 'approve', canSkipApproval: true
    });
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]
    ]);
    await runAgentTurn(options(provider, hooks, { permissionGate: ask, approve, tools: [{ ...tool, execute }] }));
    expect(execute).toHaveBeenCalledOnce();
    expect(approve).not.toHaveBeenCalled();
  });

  it('injects PostToolUse context into the following model request and dispatches Stop once', async () => {
    const requests: Message[][] = [];
    let step = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request.messages);
        if (step++ === 0) {
          yield { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };
    const hooks = new ScriptedHooks(['PostToolUse', 'Stop'], {
      additionalContext: 'audit annotation', hookIds: ['builtin.audit']
    });
    await runAgentTurn(options(provider, hooks));
    expect(requests[1]?.some((message) => message.metadata?.internal &&
      message.content.some((block) => block.type === 'text' && block.text.includes('audit annotation')))).toBe(true);
    expect(hooks.events.filter((event) => event === 'Stop')).toHaveLength(1);
  });

  it('resumes an unfinished UserPromptSubmit hook using the durable user message', async () => {
    const store = new MemoryAgentRuntimeStore();
    const user: Message = {
      id: 'resume-user', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text: 'durable prompt' }]
    };
    await store.createSession({ id: 'session-hooks', createdAt: Date.now() });
    await store.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: null, currentOperationId: null });
    await store.startOperation({
      id: 'operation-hooks', sessionId: 'session-hooks', lane: 'main', kind: 'run', createdAt: Date.now(),
      providerId: 'provider-1', model: 'model-1', maxIterations: 12
    }, createReadyState('operation-hooks'));
    await store.appendEntry({ id: user.id, sessionId: 'session-hooks', parentId: null, type: 'message', message: user });
    await store.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: user.id, currentOperationId: 'operation-hooks' });
    let submitted = '';
    const hooks: HookRuntime = {
      configured: (event) => event === 'UserPromptSubmit',
      inject: async (_event, payload) => {
        submitted = (payload as HookPayloadMap['UserPromptSubmit']).userInput;
        return { additionalContext: 'resumed context' };
      },
      preToolUse: async () => ({ decision: 'neutral' }),
      dispatch: async () => undefined
    };
    await resumeAgentTurn({
      ...options(new ScriptedProvider([[
        { type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }
      ]]), hooks, { history: [user] }),
      runtimeStore: store,
      operationId: 'operation-hooks'
    });
    expect(submitted).toBe('durable prompt');
  });

  it('fires SessionStart once per session in a process, with startup/resume sources after restart', async () => {
    const store = new MemoryAgentRuntimeStore();
    const hooks = new ScriptedHooks(['SessionStart']);
    const answer = () => new ScriptedProvider([[
      { type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }
    ]]);

    await runAgentTurn(options(answer(), hooks, { runtimeStore: store, operationId: 'operation-1', tools: [] }));
    await runAgentTurn(options(answer(), hooks, { runtimeStore: store, operationId: 'operation-2', tools: [] }));
    expect(hooks.events.filter((event) => event === 'SessionStart')).toHaveLength(1);
    expect((hooks.injections[0]?.payload as SessionStartPayload).source).toBe('new');

    const existing = new MemoryAgentRuntimeStore();
    await existing.createSession({ id: 'session-hooks', createdAt: Date.now() });
    await existing.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: null, currentOperationId: null });
    const startup = new ScriptedHooks(['SessionStart']);
    await runAgentTurn(options(answer(), startup, { runtimeStore: existing, operationId: 'operation-startup', tools: [] }));
    expect((startup.injections[0]?.payload as SessionStartPayload).source).toBe('startup');

    const resumed = new MemoryAgentRuntimeStore();
    const user: Message = {
      id: 'resume-user', role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text: 'durable prompt' }]
    };
    await resumed.createSession({ id: 'session-hooks', createdAt: Date.now() });
    await resumed.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: null, currentOperationId: null });
    await resumed.startOperation({
      id: 'operation-hooks', sessionId: 'session-hooks', lane: 'main', kind: 'run', createdAt: Date.now(),
      providerId: 'provider-1', model: 'model-1', maxIterations: 12
    }, createReadyState('operation-hooks'));
    await resumed.appendEntry({ id: user.id, sessionId: 'session-hooks', parentId: null, type: 'message', message: user });
    await resumed.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: user.id, currentOperationId: 'operation-hooks' });
    const resumeHooks = new ScriptedHooks(['SessionStart']);
    await resumeAgentTurn({
      ...options(answer(), resumeHooks, { history: [user], tools: [] }),
      runtimeStore: resumed,
      operationId: 'operation-hooks'
    });
    expect((resumeHooks.injections[0]?.payload as SessionStartPayload).source).toBe('resume');
  });

  it('does not rerun PreToolUse after permission is already resolved', async () => {
    const assistant: Message = {
      id: 'assistant-entry', role: 'assistant', createdAt: new Date().toISOString(),
      content: [{ type: 'tool_call', call: { id: 'call-1', name: 'echo', input: {} } }]
    };
    const store = await toolsOperationStore({
      permission: 'not_required', status: 'planned'
    }, [assistant]);
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'tool output' }));
    const hooks = new ScriptedHooks(['PreToolUse']);
    await resumeAgentTurn({
      ...options(new ScriptedProvider([[
        { type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }
      ]]), hooks, { history: [assistant], tools: [{ ...tool, execute }] }),
      runtimeStore: store,
      operationId: 'operation-hooks'
    });
    expect(hooks.events).not.toContain('PreToolUse');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('reuses a completed PreToolUse invocation instead of starting the hook again', async () => {
    const assistant: Message = {
      id: 'assistant-entry', role: 'assistant', createdAt: new Date().toISOString(),
      content: [{ type: 'tool_call', call: { id: 'call-1', name: 'echo', input: {} } }]
    };
    const store = await toolsOperationStore({
      permission: 'pending', status: 'planned'
    }, [assistant]);
    const registry = new HookRegistry();
    const handler = vi.fn(async () => ({ decision: 'block' as const, reason: 'once' }));
    registry.on('PreToolUse', handler, { id: 'builtin.once' });
    const invocations = new MemoryHookInvocationStore();
    await invocations.beginInvocation({
      id: 'operation-hooks:PreToolUse:call-1:builtin.once',
      eventId: 'event-1',
      hookId: 'builtin.once',
      event: 'PreToolUse',
      sessionId: 'session-hooks',
      operationId: 'operation-hooks',
      subjectId: 'call-1',
      state: 'pending'
    });
    await invocations.completeInvocation('operation-hooks:PreToolUse:call-1:builtin.once', {
      decision: 'block', reason: 'once'
    });
    const execute = vi.fn(tool.execute);
    const result = await resumeAgentTurn({
      ...options(new ScriptedProvider([[
        { type: 'text_delta', text: 'blocked acknowledged' }, { type: 'response_completed', stopReason: 'stop' }
      ]]), new DefaultHookRuntime(registry, { invocationStore: invocations }), {
        history: [assistant], tools: [{ ...tool, execute }]
      }),
      runtimeStore: store,
      operationId: 'operation-hooks'
    });
    expect(handler).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.flatMap((message) => message.content)).toContainEqual(expect.objectContaining({
      type: 'tool_result', result: expect.objectContaining({ code: 'hook_blocked', content: 'once' })
    }));
  });

  it('resumes PostToolUse without replaying a durable tool result', async () => {
    const assistant: Message = {
      id: 'assistant-entry', role: 'assistant', createdAt: new Date().toISOString(),
      content: [{ type: 'tool_call', call: { id: 'call-1', name: 'echo', input: {} } }]
    };
    const toolMessage: Message = {
      id: 'result-entry', role: 'tool', createdAt: new Date().toISOString(),
      content: [{ type: 'tool_result', result: { callId: 'call-1', ok: true, content: 'already done' } }]
    };
    const store = await toolsOperationStore({
      permission: 'not_required', status: 'effect_pending'
    }, [assistant, toolMessage]);
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'replayed' }));
    const hooks = new ScriptedHooks(['PostToolUse', 'Stop'], {
      additionalContext: 'audit annotation', hookIds: ['builtin.audit']
    });
    const requests: Message[][] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request.messages);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    await resumeAgentTurn({
      ...options(provider, hooks, { history: [assistant, toolMessage], tools: [{ ...tool, execute }] }),
      runtimeStore: store,
      operationId: 'operation-hooks'
    });
    expect(execute).not.toHaveBeenCalled();
    expect(hooks.events.filter((event) => event === 'PostToolUse')).toHaveLength(1);
    expect(requests[0]?.some((message) => message.metadata?.internal
      && message.content.some((block) => block.type === 'text' && block.text.includes('audit annotation')))).toBe(true);

    const resumedAgain = new ScriptedHooks(['PostToolUse', 'Stop'], {
      additionalContext: 'should not inject again', hookIds: ['builtin.audit']
    });
    await resumeAgentTurn({
      ...options(new ScriptedProvider([[
        { type: 'text_delta', text: 'already complete' }, { type: 'response_completed', stopReason: 'stop' }
      ]]), resumedAgain, { history: [assistant, toolMessage], tools: [{ ...tool, execute }] }),
      runtimeStore: store,
      operationId: 'operation-hooks'
    });
    expect(resumedAgain.events).not.toContain('PostToolUse');
    expect(resumedAgain.events).not.toContain('Stop');
  });

  it('dispatches Stop once for cancel and failure, and does not repeat it on resume', async () => {
    const cancelController = new AbortController();
    const cancelHooks = new ScriptedHooks(['Stop']);
    const cancelTool: Tool = {
      ...tool,
      replay: 'never',
      execute: async () => {
        cancelController.abort();
        throw new DOMException('cancelled', 'AbortError');
      }
    };
    const cancelled = await runAgentTurn(options(new ScriptedProvider([[
      { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } },
      { type: 'response_completed', stopReason: 'tool_calls' }
    ]]), cancelHooks, { tools: [cancelTool], signal: cancelController.signal }));
    expect(cancelled.stopReason).toBe('cancelled');
    expect(cancelHooks.events.filter((event) => event === 'Stop')).toHaveLength(1);

    const failHooks = new ScriptedHooks(['Stop']);
    const store = new MemoryAgentRuntimeStore();
    const failing: ModelProvider = {
      stream() { throw new Error('provider exploded'); }
    };
    await expect(runAgentTurn(options(failing, failHooks, {
      runtimeStore: store, tools: [], operationId: 'operation-fail'
    }))).rejects.toThrow('provider exploded');
    expect(failHooks.events.filter((event) => event === 'Stop')).toHaveLength(1);
    await expect(resumeAgentTurn({
      ...options(new ScriptedProvider([[
        { type: 'text_delta', text: 'unused' }, { type: 'response_completed', stopReason: 'stop' }
      ]]), failHooks, { tools: [] }),
      runtimeStore: store,
      operationId: 'operation-fail'
    })).rejects.toThrow();
    expect(failHooks.events.filter((event) => event === 'Stop')).toHaveLength(1);
  });
});

const progress = emptyProgressState();

async function toolsOperationStore(
  call: Pick<ToolsState['calls'][number], 'permission' | 'status'>,
  history: Message[]
): Promise<MemoryAgentRuntimeStore> {
  const store = new MemoryAgentRuntimeStore();
  await store.createSession({ id: 'session-hooks', createdAt: 1 });
  await store.saveLane({ sessionId: 'session-hooks', name: 'main', leafId: null, currentOperationId: null });
  const meta: OperationMeta = {
    id: 'operation-hooks', sessionId: 'session-hooks', lane: 'main', kind: 'run', createdAt: 2,
    providerId: 'provider-1', model: 'model-1', maxIterations: 12
  };
  const state: ToolsState = {
    phase: 'tools', operationId: 'operation-hooks', lane: 'main', iteration: 0,
    outputContinuations: 0, progress, assistantEntryId: 'assistant-entry', currentIndex: 0,
    noProgressDetected: false, finalResponseOnly: false,
    calls: [{
      toolIndex: 0, callId: 'call-1', toolName: 'echo', input: {},
      resultEntryId: 'result-entry', replay: 'safe',
      permission: call.permission, status: call.status
    }]
  };
  await store.startOperation(meta, state);
  let parentId: string | null = null;
  for (const message of history) {
    await store.appendEntry({ id: message.id, sessionId: 'session-hooks', parentId, type: 'message', message });
    parentId = message.id;
  }
  await store.saveLane({
    sessionId: 'session-hooks', name: 'main', leafId: parentId, currentOperationId: 'operation-hooks'
  });
  return store;
}

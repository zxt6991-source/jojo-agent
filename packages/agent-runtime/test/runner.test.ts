import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message, ModelProvider, ModelRequest, PermissionGate, Tool } from '@desktop-agent/contracts';
import { ScriptedProvider } from '@desktop-agent/agent';
import {
  MemoryAgentRuntimeStore,
  runAgentTurn,
  type AgentRunOptions,
  type MemoryRuntime,
  type OperationState
} from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const echoTool: Tool = {
  definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
  replay: 'safe',
  execute: async (input) => ({ callId: '', ok: true, content: JSON.stringify(input) })
};

function options(provider: ModelProvider, overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    sessionId: 'session-1',
    workingDirectory: process.cwd(),
    model: 'model-1',
    history: [],
    userText: 'go',
    provider,
    tools: [echoTool],
    permissionGate: allow,
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => true,
    ...overrides
  };
}

describe('runtime runner', () => {
  it('extends the default soft Loop limit when tool rounds keep making progress', async () => {
    const store = new MemoryAgentRuntimeStore();
    const events: AgentEvent[] = [];
    let requestIndex = 0;
    const provider: ModelProvider = {
      async *stream() {
        if (requestIndex < 9) {
          yield {
            type: 'tool_call_completed',
            call: { id: `dynamic-${requestIndex}`, name: 'echo', input: { value: requestIndex++ } }
          } as const;
          yield { type: 'response_completed', stopReason: 'tool_calls' } as const;
          return;
        }
        yield { type: 'text_delta', text: 'done after the soft limit extended' } as const;
        yield { type: 'response_completed', stopReason: 'stop' } as const;
      }
    };

    const result = await runAgentTurn(options(provider, {
      runtimeStore: store,
      operationId: 'operation-dynamic-loop',
      contextWindowTokens: 32_000,
      maxOutputTokens: 8_192,
      emit: (event) => events.push(event)
    }));

    expect(result.stopReason).toBe('stop');
    expect(events.some((event) => event.type === 'context.updated' && event.maxIterations === 12)).toBe(true);
    expect(await store.loadOperation('operation-dynamic-loop')).toMatchObject({
      meta: {
        maxIterations: 32,
        config: {
          dynamicIterationBudget: true,
          initialIterationLimit: 8,
          iterationExtensionStep: 4
        }
      }
    });
  });

  it('uses a mandatory tool-free final response instead of failing at the iteration limit', async () => {
    const store = new MemoryAgentRuntimeStore();
    const requests: ModelRequest[] = [];
    let requestIndex = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (requestIndex++ === 0) {
          yield { type: 'tool_call_completed', call: { id: 'limit-call', name: 'echo', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Partial result with a clear continuation step.' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };

    const result = await runAgentTurn(options(provider, {
      runtimeStore: store,
      operationId: 'operation-limit-final',
      maxIterations: 1
    }));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.instructions?.join('\n')).toContain('mandatory tool-free final response');
    expect(result.stopReason).toBe('max_iterations');
    expect(result.messages.at(-1)?.metadata).toMatchObject({ iteration: 1, finalResponseOnly: true });
    expect((await store.loadOperation('operation-limit-final'))?.state).toMatchObject({
      phase: 'completed', stopReason: 'max_iterations'
    });
  });

  it('forks a child lane from the parent leaf and keeps follow-ups on that branch', async () => {
    const store = new MemoryAgentRuntimeStore();
    const main = await runAgentTurn(options(new ScriptedProvider([[
      { type: 'text_delta', text: 'main answer' },
      { type: 'response_completed', stopReason: 'stop' }
    ]]), {
      runtimeStore: store,
      operationId: 'operation-main',
      userText: 'main task',
      tools: []
    }));
    const mainLane = await store.getLane('session-1', 'main');
    expect(mainLane?.leafId).toBe(main.messages.at(-1)?.id);

    const firstRequests: ModelRequest[] = [];
    const firstChildProvider: ModelProvider = {
      async *stream(request) {
        firstRequests.push(request);
        yield { type: 'text_delta', text: 'child answer' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    const firstChild = await runAgentTurn(options(firstChildProvider, {
      runtimeStore: store,
      operationId: 'operation-child-1',
      lane: 'agent:child-1',
      parentLane: 'main',
      history: [],
      userText: 'child task',
      tools: []
    }));
    const firstChildLane = await store.getLane('session-1', 'agent:child-1');
    const firstChildPath = await store.readPath(firstChildLane?.leafId ?? null);

    expect(firstRequests[0]?.messages.map((message) => message.content[0])).toMatchObject([
      { type: 'text', text: 'main task' },
      { type: 'text', text: 'main answer' },
      { type: 'text', text: 'child task' }
    ]);
    expect(firstChildPath.map((entry) => entry.id)).toEqual([
      ...main.messages.map((message) => message.id),
      ...firstChild.messages.map((message) => message.id)
    ]);
    expect((await store.getLane('session-1', 'main'))?.leafId).toBe(mainLane?.leafId);

    const followUpRequests: ModelRequest[] = [];
    const followUpProvider: ModelProvider = {
      async *stream(request) {
        followUpRequests.push(request);
        yield { type: 'text_delta', text: 'follow-up answer' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    await runAgentTurn(options(followUpProvider, {
      runtimeStore: store,
      operationId: 'operation-child-2',
      lane: 'agent:child-1',
      parentLane: 'main',
      history: firstChild.messages,
      userText: 'follow up',
      tools: []
    }));

    expect(followUpRequests[0]?.messages.map((message) => message.content[0])).toMatchObject([
      { type: 'text', text: 'main task' },
      { type: 'text', text: 'main answer' },
      { type: 'text', text: 'child task' },
      { type: 'text', text: 'child answer' },
      { type: 'text', text: 'follow up' }
    ]);
    expect((await store.listLanes('session-1')).map((lane) => lane.name)).toEqual(['agent:child-1', 'main']);
  });

  it('persists compaction as an entry and reuses its projection on the next run', async () => {
    const store = new MemoryAgentRuntimeStore();
    const summarize = vi.fn(async () => 'Durable summary of the old requirements.');
    const old: Message = {
      id: 'old-message',
      role: 'user',
      createdAt: '2026-08-20T00:00:00.000Z',
      content: [{ type: 'text', text: 'old requirement '.repeat(2_000) }]
    };
    const first = await runAgentTurn(options(new ScriptedProvider([[
      { type: 'text_delta', text: 'first answer' },
      { type: 'response_completed', stopReason: 'stop' }
    ]]), {
      runtimeStore: store,
      operationId: 'operation-compact-1',
      history: [old],
      userText: 'current requirement',
      tools: [],
      contextWindowTokens: 2_048,
      maxOutputTokens: 256,
      summarize
    }));

    const firstLane = await store.getLane('session-1', 'main');
    const durablePath = await store.readPath(firstLane?.leafId ?? null);
    const compaction = durablePath.find((entry) => entry.type === 'compaction');
    expect(compaction).toMatchObject({
      type: 'compaction',
      tokensBefore: expect.any(Number)
    });
    expect(compaction?.type === 'compaction' ? compaction.summary : '').toContain('Durable summary of the old requirements.');
    expect(compaction?.type === 'compaction' ? compaction.summary : '').toContain('old requirement');
    expect(await store.getEntry('old-message')).not.toBeNull();

    const requests: ModelRequest[] = [];
    const secondProvider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'second answer' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    await runAgentTurn(options(secondProvider, {
      runtimeStore: store,
      operationId: 'operation-compact-2',
      history: first.messages,
      userText: 'follow-up',
      tools: [],
      contextWindowTokens: 2_048,
      maxOutputTokens: 256,
      summarize
    }));

    expect(requests[0]?.messages.some((message) => message.id === 'old-message')).toBe(false);
    expect(requests[0]?.messages[0]).toMatchObject({ metadata: { internal: true } });
    expect(requests[0]?.messages.flatMap((message) => message.content)
      .some((block) => block.type === 'text' && block.text.includes('Durable summary'))).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('persists model intent and tool intent before executing either effect', async () => {
    class RecordingStore extends MemoryAgentRuntimeStore {
      readonly states: OperationState[] = [];
      override async saveOperationState(state: OperationState): Promise<void> {
        await super.saveOperationState(state);
        this.states.push(structuredClone(state));
      }
    }
    const store = new RecordingStore();
    let step = 0;
    const provider: ModelProvider = {
      async *stream() {
        expect(store.states.at(-1)?.phase).toBe('model_pending');
        if (step++ === 0) {
          yield { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };
    const execute = vi.fn(async () => {
      const current = store.states.at(-1);
      expect(current).toMatchObject({
        phase: 'tools',
        calls: [{ callId: 'call-1', status: 'effect_pending', resultEntryId: expect.any(String) }]
      });
      return { callId: '', ok: true, content: 'ok' };
    });

    await runAgentTurn(options(provider, {
      operationId: 'operation-durable',
      providerId: 'provider-1',
      runtimeStore: store,
      tools: [{ ...echoTool, replay: 'never', execute }]
    }));

    expect(execute).toHaveBeenCalledOnce();
    expect(await store.loadOperation('operation-durable')).toMatchObject({
      meta: { providerId: 'provider-1', model: 'model-1' },
      state: { phase: 'completed', stopReason: 'stop' }
    });
    expect(await store.getLane('session-1', 'main')).toMatchObject({ currentOperationId: null });
  });

  it('drives a model-tool-model turn through the interpreter', async () => {
    const execute = vi.fn(echoTool.execute);
    const committed: string[] = [];
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'call-1', name: 'echo', input: { value: 1 } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(options(provider, {
      tools: [{ ...echoTool, execute }],
      commitMessage: async (message) => { committed.push(message.id); }
    }));

    expect(result.stopReason).toBe('stop');
    expect(execute).toHaveBeenCalledOnce();
    expect(result.messages.map((message) => message.id)).toEqual(committed);
    expect(new Set(committed).size).toBe(committed.length);
    expect(result.messages.some((message) => message.role === 'tool')).toBe(true);
  });

  it('does not enter no-progress recovery for repeated polling calls', async () => {
    const execute = vi.fn(echoTool.execute);
    const pollingTool: Tool = { ...echoTool, repeatPolicy: 'polling', execute };
    const provider = new ScriptedProvider([
      ...Array.from({ length: 3 }, (_, index) => [
        { type: 'tool_call_completed' as const, call: { id: `wait-${index}`, name: 'echo', input: { id: 'agent-1' } } },
        { type: 'response_completed' as const, stopReason: 'tool_calls' }
      ]),
      [
        { type: 'text_delta', text: 'both sub-agents completed' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(options(provider, {
      operationId: 'operation-polling',
      tools: [pollingTool]
    }));
    const noProgressResults = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result' && block.result.code === 'no_progress');

    expect(result.stopReason).toBe('stop');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(noProgressResults).toHaveLength(0);
  });

  it('keeps max-token continuation state across model requests', async () => {
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'partial' },
        { type: 'response_completed', stopReason: 'max_tokens' }
      ],
      [
        { type: 'text_delta', text: ' finished' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(options(provider, {
      tools: [],
      emit: (event) => events.push(event)
    }));

    expect(result.stopReason).toBe('stop');
    expect(events).toContainEqual({ type: 'output.continuing', attempt: 1 });
    expect(result.messages.some((message) => message.metadata?.internal)).toBe(true);
  });

  it('settles all unfinished calls as cancelled when execution is aborted', async () => {
    const controller = new AbortController();
    const tool: Tool = {
      ...echoTool,
      replay: 'never',
      execute: async () => {
        controller.abort();
        throw new DOMException('cancelled', 'AbortError');
      }
    };
    const provider = new ScriptedProvider([[
      { type: 'tool_call_completed', call: { id: 'first', name: 'echo', input: {} } },
      { type: 'tool_call_completed', call: { id: 'second', name: 'echo', input: {} } },
      { type: 'response_completed', stopReason: 'tool_calls' }
    ]]);

    const result = await runAgentTurn(options(provider, { tools: [tool], signal: controller.signal }));
    const results = result.messages.flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.type === 'tool_result' ? block.result : null);

    expect(result.stopReason).toBe('cancelled');
    expect(results).toMatchObject([
      { callId: 'first', code: 'cancelled' },
      { callId: 'second', code: 'cancelled' }
    ]);
  });

  it('persists and reuses one memory snapshot as ambient context', async () => {
    const store = new MemoryAgentRuntimeStore();
    const snapshot = vi.fn(async () => ({
      id: 'snapshot-1', version: 1, scope: { globalScopeId: 'global' as const },
      content: 'Use pnpm for this project.', sourceEntryIds: ['mem-1'],
      scopeVersions: { global: 1 }, estimatedTokens: 8, contentHash: 'snapshot-hash'
    }));
    const memoryRuntime: MemoryRuntime = {
      snapshot,
      recallTriggered: async () => [],
      beforeCompact: async () => ({ refreshSnapshot: false }),
      onTurnSettled: async () => undefined
    };
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };
    await runAgentTurn(options(provider, {
      runtimeStore: store, operationId: 'memory-op-1', tools: [], memoryRuntime
    }));
    await runAgentTurn(options(provider, {
      runtimeStore: store, operationId: 'memory-op-2', tools: [], memoryRuntime, userText: 'follow up'
    }));

    expect(snapshot).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.instructions?.some((instruction) =>
      instruction.includes('Use pnpm for this project.')
    ))).toBe(true);
    const lane = await store.getLane('session-1', 'main');
    expect((await store.readPath(lane?.leafId ?? null)).filter((entry) => entry.type === 'memory_snapshot')).toHaveLength(1);
  });
});

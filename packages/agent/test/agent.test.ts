import { describe, expect, it, vi } from 'vitest';
import { runAgentTurn, ScriptedProvider } from '../src/index.js';
import type { AgentRunOptions } from '../src/index.js';
import type { AgentEvent, ModelProvider, ModelRequest, PermissionGate, Tool } from '@desktop-agent/contracts';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const echoTool: Tool = {
  definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
  execute: async (input) => ({ callId: '', ok: true, content: JSON.stringify(input) })
};

function createOptions(
  provider: ModelProvider,
  overrides: Partial<AgentRunOptions> = {}
): AgentRunOptions {
  return {
    sessionId: 's1',
    workingDirectory: process.cwd(),
    model: 'fake',
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

describe('runAgentTurn', () => {
  it('returns accumulated messages at the iteration limit when partial results are enabled', async () => {
    const provider = new ScriptedProvider([[
      { type: 'text_delta', text: 'partial evidence' },
      { type: 'tool_call_completed', call: { id: 'partial-call', name: 'echo', input: {} } },
      { type: 'response_completed', stopReason: 'tool_calls' }
    ]]);
    const events: AgentEvent[] = [];
    const result = await runAgentTurn(createOptions(provider, {
      maxIterations: 1,
      allowPartialOnMaxIterations: true,
      emit: (event) => events.push(event)
    }));
    expect(result.stopReason).toBe('max_iterations');
    expect(result.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(events).toContainEqual({ type: 'turn.completed', stopReason: 'max_iterations' });
  });

  it('reserves a tool-free final response after the tool iteration budget is exhausted', async () => {
    const requests: ModelRequest[] = [];
    let requestIndex = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (requestIndex++ === 0) {
          yield { type: 'tool_call_completed', call: { id: 'limit-call', name: 'echo', input: { value: 1 } } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Completed the lookup; the requested artifact remains unfinished.' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };
    const events: AgentEvent[] = [];

    const result = await runAgentTurn(createOptions(provider, {
      maxIterations: 1,
      emit: (event) => events.push(event)
    }));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.tools).toEqual([]);
    expect(requests[1]?.instructions?.join('\n')).toContain('mandatory tool-free final response');
    expect(result.stopReason).toBe('max_iterations');
    expect(result.messages.some((message) => message.metadata?.internal
      && message.content.some((block) => block.type === 'text' && block.text.includes('1-iteration budget')))).toBe(true);
    expect(result.messages.at(-1)?.metadata).toMatchObject({ iteration: 1, finalResponseOnly: true });
    expect(events).toContainEqual({ type: 'turn.completed', stopReason: 'max_iterations' });
  });

  it('runs a tool and feeds its result into the next model request', async () => {
    const events: AgentEvent[] = [];
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: { value: 1 } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, {
      emit: (event) => events.push(event)
    }));

    expect(result.stopReason).toBe('stop');
    expect(result.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
  });

  it('marks tools approved after the permission gate allows them', async () => {
    let approved: boolean | undefined;
    const writeTool: Tool = {
      definition: { name: 'write_file', description: 'write', inputSchema: { type: 'object' } },
      execute: async (_input, context) => {
        approved = context.approved;
        return { callId: '', ok: true, content: 'wrote' };
      }
    };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'w1', name: 'write_file', input: { path: 'a.ts', content: 'x' } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);
    await runAgentTurn(createOptions(provider, {
      tools: [writeTool],
      permissionGate: { check: async () => ({ decision: 'allow' }) }
    }));
    expect(approved).toBe(true);
  });

  it('does not execute a duplicate call id twice', async () => {
    const execute = vi.fn(echoTool.execute);
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'same', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'tool_call_completed', call: { id: 'same', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    await expect(runAgentTurn(createOptions(provider, {
      tools: [{ ...echoTool, execute }]
    }))).resolves.toBeDefined();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('detects a period-1 repeated tool batch before executing it a third time', async () => {
    const execute = vi.fn(echoTool.execute);
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'repeat-1', name: 'echo', input: { query: 'same' } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'tool_call_completed', call: { id: 'repeat-2', name: 'echo', input: { query: 'same' } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'tool_call_completed', call: { id: 'repeat-3', name: 'echo', input: { query: 'same' } } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'I will use the existing result.' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, {
      tools: [{ ...echoTool, execute }]
    }));
    expect(result.stopReason).toBe('loop_detected');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.messages.some((message) => message.metadata?.internal
      && message.content.some((block) => block.type === 'text' && block.text.includes('formed a cycle')))).toBe(true);
  });

  it('allows identical polling calls while background work is still changing state', async () => {
    let poll = 0;
    const execute = vi.fn(async () => ({
      callId: '', ok: true, content: JSON.stringify({ completed: ++poll >= 3 })
    }));
    const pollingTool: Tool = {
      definition: { name: 'background_wait', description: 'wait', inputSchema: { type: 'object' } },
      repeatPolicy: 'polling',
      execute
    };
    const provider = new ScriptedProvider([
      ...Array.from({ length: 3 }, (_, index) => [
        { type: 'tool_call_completed' as const, call: { id: `poll-${index}`, name: 'background_wait', input: { id: 'job-1' } } },
        { type: 'response_completed' as const, stopReason: 'tool_calls' }
      ]),
      [
        { type: 'text_delta', text: 'The background job completed.' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, { tools: [pollingTool] }));
    const noProgressResults = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result' && block.result.code === 'no_progress');

    expect(result.stopReason).toBe('stop');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(noProgressResults).toHaveLength(0);
  });

  it('detects an A-B-A-B-A-B tool-batch cycle and finalizes without the sixth execution', async () => {
    const execute = vi.fn(echoTool.execute);
    let step = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        if (step < 6) {
          const current = step++;
          yield {
            type: 'tool_call_completed',
            call: { id: `period-two-${current}`, name: 'echo', input: { value: current % 2 } }
          };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
          return;
        }
        expect(request.tools).toEqual([]);
        yield { type: 'text_delta', text: 'The repeated cycle was stopped.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, { tools: [{ ...echoTool, execute }] }));

    expect(result.stopReason).toBe('loop_detected');
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('enforces a bounded polling budget without treating polling as a batch cycle', async () => {
    const execute = vi.fn(echoTool.execute);
    const pollingTool: Tool = {
      ...echoTool,
      repeatPolicy: 'polling',
      polling: { maxPollsPerInput: 2 },
      execute
    };
    const provider = new ScriptedProvider([
      ...Array.from({ length: 3 }, (_, index) => [
        { type: 'tool_call_completed' as const, call: { id: `bounded-poll-${index}`, name: 'echo', input: { id: 'job' } } },
        { type: 'response_completed' as const, stopReason: 'tool_calls' }
      ]),
      [
        { type: 'text_delta', text: 'Polling could not continue safely.' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, { tools: [pollingTool] }));
    const budgetResult = result.messages.flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result' && block.result.code === 'no_progress');

    expect(result.stopReason).toBe('stop');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(budgetResult?.type === 'tool_result' && budgetResult.result.content).toContain('polling budget');
  });

  it('finalizes when the cumulative token budget is reached', async () => {
    let step = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        if (step++ === 0) {
          yield { type: 'usage', inputTokens: 6, outputTokens: 4 };
          yield { type: 'tool_call_completed', call: { id: 'token-call', name: 'echo', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'Token budget reached; here is the partial result.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, {
      loopBudget: { maxTotalTokens: 10 }
    }));

    expect(result.stopReason).toBe('token_budget');
    expect(requests.at(-1)?.tools).toEqual([]);
  });

  it('finalizes when provider-reported cost reaches the configured budget', async () => {
    let step = 0;
    const provider: ModelProvider = {
      async *stream() {
        if (step++ === 0) {
          yield { type: 'usage', costUsd: 0.25 };
          yield { type: 'tool_call_completed', call: { id: 'cost-call', name: 'echo', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'Cost budget reached.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, {
      loopBudget: { maxCostUsd: 0.25 }
    }));

    expect(result.stopReason).toBe('cost_budget');
  });

  it('starts with a tool-free final response when the wall-time budget is already exhausted', async () => {
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text_delta', text: 'No safe execution time remained.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, {
      loopBudget: { maxWallTimeMs: 0 }
    }));

    expect(result.stopReason).toBe('time_budget');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toEqual([]);
  });

  it('does not execute a batch that would exceed the tool-call budget', async () => {
    const execute = vi.fn(echoTool.execute);
    let step = 0;
    const provider: ModelProvider = {
      async *stream(request) {
        if (step++ === 0) {
          for (let index = 0; index < 3; index += 1) {
            yield { type: 'tool_call_completed', call: { id: `batch-${index}`, name: 'echo', input: { index } } };
          }
          yield { type: 'response_completed', stopReason: 'tool_calls' };
          return;
        }
        expect(request.tools).toEqual([]);
        yield { type: 'text_delta', text: 'The tool batch exceeded its budget.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, {
      tools: [{ ...echoTool, execute }],
      loopBudget: { maxToolCalls: 2 }
    }));

    expect(result.stopReason).toBe('tool_call_budget');
    expect(execute).not.toHaveBeenCalled();
  });

  it('detects repeated read-only results across different searches and forces a final response', async () => {
    let step = 0;
    const seenTools: string[][] = [];
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'same evidence' }));
    const searchTool: Tool = {
      definition: { name: 'grep', description: 'search', inputSchema: { type: 'object' } },
      execute
    };
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        seenTools.push(request.tools.map((tool) => tool.name));
        if (step < 4) {
          const current = step;
          step += 1;
          yield {
            type: 'tool_call_completed',
            call: { id: `search-${current}`, name: 'grep', input: { query: `variant-${current}` } }
          };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'The available evidence points to an authentication problem.' };
        yield { type: 'response_completed', stopReason: 'stop' };
      }
    };

    const result = await runAgentTurn(createOptions(provider, { tools: [searchTool] }));
    const noProgressResults = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result' && block.result.code === 'no_progress');

    expect(result.stopReason).toBe('no_progress');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(noProgressResults.length).toBe(3);
    expect(seenTools.at(-1)).toEqual([]);
  });

  it('allows a small coding task to continue beyond eight model iterations', async () => {
    const execute = vi.fn(echoTool.execute);
    const toolRounds = Array.from({ length: 9 }, (_, index) => [
      { type: 'tool_call_completed' as const, call: { id: `call-${index}`, name: 'echo', input: { index } } },
      { type: 'response_completed' as const, stopReason: 'tool_calls' }
    ]);
    const provider = new ScriptedProvider([
      ...toolRounds,
      [
        { type: 'text_delta', text: 'done' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    await expect(runAgentTurn(createOptions(provider, {
      tools: [{ ...echoTool, execute }]
    }))).resolves.toMatchObject({ stopReason: 'stop' });
    expect(execute).toHaveBeenCalledTimes(9);
  });

  it('refreshes lazily discovered tools between model steps', async () => {
    let activated = false;
    let step = 0;
    const seenTools: string[][] = [];
    const searchTool: Tool = {
      definition: { name: 'mcp_tool_manifest', description: 'search', inputSchema: { type: 'object' } },
      execute: async () => {
        activated = true;
        return { callId: '', ok: true, content: 'activated' };
      }
    };
    const remoteTool: Tool = {
      definition: { name: 'mcp__demo__weather', description: 'weather', inputSchema: { type: 'object' } },
      execute: async () => ({ callId: '', ok: true, content: 'sunny' })
    };
    const provider: ModelProvider = {
      async *stream(request: ModelRequest) {
        seenTools.push(request.tools.map((tool) => tool.name));
        if (step === 0) {
          step += 1;
          yield { type: 'tool_call_completed', call: { id: 'search', name: 'mcp_tool_manifest', input: { query: 'weather' } } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else if (step === 1) {
          step += 1;
          yield { type: 'tool_call_completed', call: { id: 'weather', name: 'mcp__demo__weather', input: {} } };
          yield { type: 'response_completed', stopReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'response_completed', stopReason: 'stop' };
        }
      }
    };

    await runAgentTurn(createOptions(provider, {
      tools: [],
      getTools: () => activated ? [searchTool, remoteTool] : [searchTool]
    }));

    expect(seenTools[0]).toEqual(['mcp_tool_manifest']);
    expect(seenTools[1]).toEqual(['mcp_tool_manifest', 'mcp__demo__weather']);
  });

  it('turns a denied approval into a tool result and continues', async () => {
    const ask: PermissionGate = {
      check: async (call) => ({
        decision: 'ask',
        request: { requestId: 'r1', sessionId: 's1', call, reason: 'test' }
      })
    };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'alternative' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, {
      permissionGate: ask,
      approve: async () => false
    }));
    const resultBlock = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result');

    expect(resultBlock?.type === 'tool_result' && resultBlock.result.code).toBe('user_denied');
  });

  it('records interrupted results for every unfinished call when a tool is cancelled', async () => {
    const controller = new AbortController();
    const cancellingTool: Tool = {
      ...echoTool,
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

    const result = await runAgentTurn(createOptions(provider, {
      tools: [cancellingTool],
      signal: controller.signal
    }));
    const interrupted = result.messages
      .flatMap((item) => item.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.type === 'tool_result' ? block.result : null);

    expect(result.stopReason).toBe('cancelled');
    expect(interrupted).toMatchObject([
      { callId: 'first', ok: false, code: 'cancelled' },
      { callId: 'second', ok: false, code: 'cancelled' }
    ]);
  });

  it('turns a tool exception into a failed result and continues', async () => {
    const failingTool: Tool = {
      ...echoTool,
      execute: async () => { throw new Error('tool exploded'); }
    };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [
        { type: 'text_delta', text: 'recovered' },
        { type: 'response_completed', stopReason: 'stop' }
      ]
    ]);

    const result = await runAgentTurn(createOptions(provider, { tools: [failingTool] }));
    const resultBlock = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result');

    expect(result.stopReason).toBe('stop');
    expect(resultBlock?.type === 'tool_result' && resultBlock.result).toMatchObject({
      ok: false,
      code: 'tool_error',
      content: 'tool exploded'
    });
  });

  it('preserves a classified tool error code', async () => {
    const conflictingTool: Tool = {
      ...echoTool,
      execute: async () => {
        throw Object.assign(new Error('file changed'), { code: 'file_conflict' });
      }
    };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: {} } },
        { type: 'response_completed', stopReason: 'tool_calls' }
      ],
      [{ type: 'response_completed', stopReason: 'stop' }]
    ]);

    const result = await runAgentTurn(createOptions(provider, { tools: [conflictingTool] }));
    const resultBlock = result.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_result');

    expect(resultBlock?.type === 'tool_result' && resultBlock.result.code).toBe('file_conflict');
  });

  it('emits a classified failure when the provider returns no events', async () => {
    const events: AgentEvent[] = [];

    await expect(runAgentTurn(createOptions(new ScriptedProvider([[]]), {
      emit: (event) => events.push(event)
    }))).rejects.toThrow('The provider returned no events.');

    expect(events.at(-1)).toEqual({
      type: 'turn.failed',
      code: 'empty_response',
      message: 'The provider returned no events.'
    });
  });
});

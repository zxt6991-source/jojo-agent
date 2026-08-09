import { describe, expect, it, vi } from 'vitest';
import { runAgentTurn, ScriptedProvider } from '../src/index.js';
import type { AgentRunOptions } from '../src/index.js';
import type { AgentEvent, ModelProvider, PermissionGate, Tool } from '@desktop-agent/contracts';

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

import { describe, expect, it, vi } from 'vitest';
import { runAgentTurn, ScriptedProvider } from '../src/index.js';
import type { AgentEvent, PermissionGate, Tool } from '@desktop-agent/contracts';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const tool: Tool = {
  definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
  execute: async (input) => ({ callId: '', ok: true, content: JSON.stringify(input) })
};

describe('runAgentTurn', () => {
  it('runs a tool and feeds its result into the next model request', async () => {
    const events: AgentEvent[] = [];
    const result = await runAgentTurn({
      sessionId: 's1', workingDirectory: process.cwd(), model: 'fake', history: [], userText: 'go',
      provider: new ScriptedProvider([
        [{ type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: { value: 1 } } }, { type: 'response_completed', stopReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]
      ]),
      tools: [tool], permissionGate: allow, signal: new AbortController().signal,
      emit: (event) => events.push(event), approve: async () => true
    });
    expect(result.stopReason).toBe('stop');
    expect(result.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
  });

  it('does not execute a duplicate call id twice', async () => {
    const execute = vi.fn(tool.execute);
    const duplicateTool = { ...tool, execute };
    await expect(runAgentTurn({
      sessionId: 's1', workingDirectory: process.cwd(), model: 'fake', history: [], userText: 'go',
      provider: new ScriptedProvider([
        [{ type: 'tool_call_completed', call: { id: 'same', name: 'echo', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
        [{ type: 'tool_call_completed', call: { id: 'same', name: 'echo', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'done' }, { type: 'response_completed', stopReason: 'stop' }]
      ]), tools: [duplicateTool], permissionGate: allow, signal: new AbortController().signal,
      emit: () => undefined, approve: async () => true
    })).resolves.toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('turns a denied approval into a tool result and continues', async () => {
    const ask: PermissionGate = { check: async (call) => ({
      decision: 'ask', request: { requestId: 'r1', sessionId: 's1', call, reason: 'test' }
    }) };
    const result = await runAgentTurn({
      sessionId: 's1', workingDirectory: process.cwd(), model: 'fake', history: [], userText: 'go',
      provider: new ScriptedProvider([
        [{ type: 'tool_call_completed', call: { id: 'c1', name: 'echo', input: {} } }, { type: 'response_completed', stopReason: 'tool_calls' }],
        [{ type: 'text_delta', text: 'alternative' }, { type: 'response_completed', stopReason: 'stop' }]
      ]), tools: [tool], permissionGate: ask, signal: new AbortController().signal,
      emit: () => undefined, approve: async () => false
    });
    const resultBlock = result.messages.flatMap((message) => message.content).find((block) => block.type === 'tool_result');
    expect(resultBlock?.type === 'tool_result' && resultBlock.result.code).toBe('user_denied');
  });
});

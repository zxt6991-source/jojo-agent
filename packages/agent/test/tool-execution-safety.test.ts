import { describe, expect, it, vi } from 'vitest';
import type { ModelProvider, PermissionGate, Tool, ToolCall } from '@desktop-agent/contracts';
import { executeToolCall, type AgentRunOptions, type ToolExecutionState } from '../src/index.js';

const allow: PermissionGate = { check: async () => ({ decision: 'allow' }) };
const unusedProvider: ModelProvider = { async *stream() { /* tool-only test */ } };

function state(tool: Tool): ToolExecutionState {
  return {
    toolsByName: new Map([[tool.definition.name, tool]]),
    executedCallIds: new Set(),
    toolCallCounts: new Map(),
    observationFingerprints: new Set(),
    pollingCalls: new Map(),
    repeatedToolCalls: 0,
    duplicateObservations: 0
  };
}

function options(tool: Tool): AgentRunOptions {
  return {
    sessionId: 'safety',
    workingDirectory: process.cwd(),
    model: 'unused',
    history: [],
    userText: '',
    provider: unusedProvider,
    tools: [tool],
    permissionGate: allow,
    signal: new AbortController().signal,
    emit: () => undefined,
    approve: async () => true
  };
}

describe('tool execution safety', () => {
  it('rejects the third identical non-polling call', async () => {
    const execute = vi.fn(async () => ({ callId: '', ok: true, content: 'same' }));
    const tool: Tool = {
      definition: { name: 'read', description: 'read', inputSchema: { type: 'object' } },
      execute
    };
    const executionState = state(tool);
    const runOptions = options(tool);
    const call = (index: number): ToolCall => ({ id: `call-${index}`, name: 'read', input: { path: 'a' } });

    await executeToolCall(call(1), executionState, runOptions);
    await executeToolCall(call(2), executionState, runOptions);
    const third = await executeToolCall(call(3), executionState, runOptions);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({ ok: false, code: 'no_progress' });
  });

  it('normalizes timestamps and request ids in idempotent observations', async () => {
    let index = 0;
    const tool: Tool = {
      definition: { name: 'inspect', description: 'inspect', inputSchema: { type: 'object' } },
      repeatPolicy: 'idempotent-observation',
      execute: async () => ({
        callId: '',
        ok: true,
        content: `status ready at 2026-08-23T01:00:0${index}Z request_id=req-${index++}`
      })
    };
    const executionState = state(tool);
    const runOptions = options(tool);

    const first = await executeToolCall({ id: 'one', name: 'inspect', input: { page: 1 } }, executionState, runOptions);
    const second = await executeToolCall({ id: 'two', name: 'inspect', input: { page: 2 } }, executionState, runOptions);

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'no_progress' });
    expect(executionState.duplicateObservations).toBe(1);
  });
});

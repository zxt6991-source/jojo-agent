import { describe, expect, it } from 'vitest';
import type { ToolCall } from '@desktop-agent/contracts';
import {
  advanceTool,
  assertOperationState,
  beginModelRequest,
  createReadyState,
  defaultAgentInterpreter,
  planToolCalls,
  prepareToolEffect,
  resolveToolPermission,
  settleToolEffect,
  type OperationState
} from '../src/index.js';

function pendingModel() {
  return beginModelRequest(createReadyState('op-1'), {
    responseEntryId: 'assistant-1',
    usageId: 'usage-1',
    providerId: 'provider-1',
    model: 'model-1',
    toolNames: ['lookup', 'send'],
    maxOutputTokens: 1_024,
    finalResponseOnly: false
  });
}

function plannedTools() {
  const calls: ToolCall[] = [
    { id: 'call-safe', name: 'lookup', input: { query: 'state' } },
    { id: 'call-unsafe', name: 'send', input: { message: 'hello' } }
  ];
  let id = 0;
  return planToolCalls(
    pendingModel(),
    'assistant-1',
    calls,
    (name) => name === 'lookup' ? 'safe' : 'never',
    () => `result-${id += 1}`
  );
}

describe('operation interpreter', () => {
  it('derives the next action without mutating state', () => {
    const state = createReadyState('op-1');
    const before = structuredClone(state);

    expect(defaultAgentInterpreter.peekAction(state, { maxIterations: 12 })).toEqual({ type: 'request_model' });
    expect(state).toEqual(before);
  });

  it('replays safe pending effects but synthesizes uncertain unsafe effects during recovery', () => {
    const safe = prepareToolEffect(resolveToolPermission(plannedTools(), 'call-safe', 'not_required'), 'call-safe');
    expect(defaultAgentInterpreter.peekAction(safe, { maxIterations: 12, recovering: true })).toEqual({
      type: 'execute_tool', callId: 'call-safe'
    });

    const safeResult = settleToolEffect(safe, 'call-safe', {
      callId: 'call-safe', ok: true, content: 'found'
    });
    const unsafePlanned = advanceTool(safeResult);
    expect(unsafePlanned.phase).toBe('tools');
    if (unsafePlanned.phase !== 'tools') return;
    const unsafe = prepareToolEffect(resolveToolPermission(unsafePlanned, 'call-unsafe', 'approved'), 'call-unsafe');
    expect(defaultAgentInterpreter.peekAction(unsafe, { maxIterations: 12, recovering: true })).toEqual({
      type: 'synthesize_interrupted_tool_result', callId: 'call-unsafe'
    });
    expect(defaultAgentInterpreter.peekAction(unsafe, { maxIterations: 12 })).toEqual({
      type: 'execute_tool', callId: 'call-unsafe'
    });
  });

  it('reserves every tool result id before an effect becomes pending', () => {
    const planned = plannedTools();
    expect(planned.calls.map((call) => [call.callId, call.resultEntryId, call.replay])).toEqual([
      ['call-safe', 'result-1', 'safe'],
      ['call-unsafe', 'result-2', 'never']
    ]);
    const pending = prepareToolEffect(resolveToolPermission(planned, 'call-safe', 'not_required'), 'call-safe');
    expect(pending.calls[0]).toMatchObject({ status: 'effect_pending', resultEntryId: 'result-1' });
    expect(() => assertOperationState(pending)).not.toThrow();
  });

  it('returns no action for terminal and suspended operations', () => {
    const states: OperationState[] = [
      { phase: 'completed', operationId: 'op', lane: 'main', stopReason: 'stop', finalEntryId: null },
      { phase: 'failed', operationId: 'op', lane: 'main', error: { code: 'provider_error', message: 'failed' } },
      { phase: 'aborted', operationId: 'op', lane: 'main', reason: 'cancelled' },
      { phase: 'suspended', operationId: 'op', lane: 'main', reason: 'provider_unavailable' }
    ];
    for (const state of states) {
      expect(defaultAgentInterpreter.peekAction(state, { maxIterations: 12 })).toBeUndefined();
    }
  });
});

import { createAgentRuntime } from '@desktop-agent/agent-runtime';
import { describeTestProvider, ScriptedProvider, MemoryAgentRuntimeStore } from '@desktop-agent/agent-runtime/testing';
import type { Message } from '@desktop-agent/contracts';
import type { RunResult } from '@desktop-agent/contracts/runtime';
import { describe, expect, it } from 'vitest';
import { selectCommittedSpeechReply } from './committed-speech-reply';

const message = (id: string, text: string): Message => ({ id, role: 'assistant', content: text ? [{ type: 'text', text }] : [], createdAt: '2026-01-01T00:00:00.000Z' });
const result = (messages: Message[], status: RunResult['status'] = 'completed'): RunResult => ({ runId: 'run-a', sessionId: 'session-a', laneId: 'main', status, messages });

describe('exact committed reply receipts', () => {
  it('does not read historical text when the current committed reply has an empty body', () => {
    expect(selectCommittedSpeechReply(result([message('old', '上一轮回答'), message('current', '')]), 'current')).toBeUndefined();
  });
  it('reads the exact terminal entry even if other visible assistant messages follow it', () => {
    const final = message('current', '本轮回答');
    expect(selectCommittedSpeechReply(result([message('old', '上一轮回答'), final, message('later', '别的正文')]), 'current')).toBe(final);
  });
  it.each([null, 'missing'])('does not infer a message for a missing terminal entry %s', id => {
    expect(selectCommittedSpeechReply(result([message('old', '旧回答')]), id)).toBeUndefined();
  });
  it.each(['failed','cancelled'] as const)('never creates a receipt for %s results', status => {
    expect(selectCommittedSpeechReply(result([message('current', '正文')], status), 'current')).toBeUndefined();
  });
  it.each(['user','internal','planning','whitespace'] as const)('rejects a terminal %s entry', type => {
    const value = message('current', type === 'whitespace' ? ' \n ' : '正文');
    if (type === 'user') value.role = 'user';
    if (type === 'internal') value.metadata = { internal: true };
    if (type === 'planning') value.content.push({ type: 'tool_call', call: { id: 'call-a', name: 'tool', input: {} } });
    expect(selectCommittedSpeechReply(result([message('old', '旧回答'), value]), 'current')).toBeUndefined();
  });
  it('uses real Runtime terminal IDs to suppress history after a completed empty response', async () => {
    const store = new MemoryAgentRuntimeStore();
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: '上一轮有正文' }, { type: 'response_completed', stopReason: 'stop' }],
      [{ type: 'response_completed', stopReason: 'stop' }]
    ]);
    const runtime = createAgentRuntime({ store, environment: { host: { kind: 'test' },
      providers: { describe: describeTestProvider, resolve: () => provider }, tools: { resolve: () => ({ snapshot: () => [] }) },
      permissions: { check: async () => ({ decision: 'allow' }) } } });
    try {
      const lane = await (await runtime.openSession({ id: 'session-a', executionScope: { kind: 'none' } })).getLane();
      const first = await (await lane.run({ runId: 'old-run', input: '第一句', providerId: 'p', model: 'm' })).result;
      const old = await store.loadOperation('old-run');
      if (old?.state.phase !== 'completed') throw new Error('Expected a committed first response.');
      expect(selectCommittedSpeechReply(first, old.state.finalEntryId)?.content).toEqual([{ type: 'text', text: '上一轮有正文' }]);
      const current = await (await lane.run({ runId: 'empty-run', input: '第二句', providerId: 'p', model: 'm' })).result;
      const operation = await store.loadOperation('empty-run');
      expect(current.status).toBe('completed'); expect(current.messages.some(item => item.content.some(block => block.type === 'text' && block.text === '上一轮有正文'))).toBe(true);
      if (operation?.state.phase !== 'completed') throw new Error('Expected a committed empty response.');
      expect(operation.state.finalEntryId).not.toBe(old.state.finalEntryId);
      expect(selectCommittedSpeechReply(current, operation.state.finalEntryId)).toBeUndefined();
    } finally { await runtime.close(); }
  });
});

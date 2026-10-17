import { describe, expect, it } from 'vitest';
import type { Message } from '@desktop-agent/contracts';
import type { RuntimeRunSnapshot } from '@desktop-agent/agent-runtime';
import { committedHeadlessScheduleResult } from './scheduler-runtime.js';

const timestamp = '2026-10-14T00:00:00.000Z';
function assistant(text: string): Message {
  return { id: 'reply', role: 'assistant', createdAt: timestamp, content: [{ type: 'text', text }] };
}
function snapshot(messages: Message[]): RuntimeRunSnapshot {
  return {
    id: 'run', sessionId: 'session', laneId: 'schedule:1', status: 'completed',
    result: { runId: 'run', sessionId: 'session', laneId: 'schedule:1', status: 'completed', stopReason: 'stop', messages, finalText: 'Untrusted result preview' }
  };
}

describe('committed headless schedule result', () => {
  it('reads the committed final message instead of the diagnostic preview', () => {
    const text = '完整结果'.repeat(2_000);
    expect(committedHeadlessScheduleResult(snapshot([assistant(text)]))).toBe(text);
  });

  it('does not expose an internal or tool-call message, or fall back to an earlier reply', () => {
    const oldReply = assistant('旧一轮的结果');
    expect(committedHeadlessScheduleResult(snapshot([oldReply, { ...assistant('秘密轨迹'), metadata: { internal: true } }]))).toBeUndefined();
    expect(committedHeadlessScheduleResult(snapshot([oldReply, {
      ...assistant('运行中的解释'), content: [{ type: 'text', text: '运行中的解释' }, { type: 'tool_call', call: { id: 'call', name: 'tool', input: {} } }]
    }]))).toBeUndefined();
    expect(committedHeadlessScheduleResult(snapshot([oldReply, { ...assistant('not assistant'), role: 'tool' }]))).toBeUndefined();
    expect(committedHeadlessScheduleResult({ ...snapshot([oldReply]), status: 'running' })).toBeUndefined();
  });
});

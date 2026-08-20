import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelEvent, ModelProvider, ModelRequest } from '@desktop-agent/contracts';
import { groupContextMessages, prepareModelContext, runAgentTurn } from '../src/index.js';

const time = '2026-08-09T00:00:00.000Z';
const textMessage = (id: string, role: 'user' | 'assistant', text: string): Message => ({
  id, role, createdAt: time, content: [{ type: 'text', text }]
});

describe('context management', () => {
  it('keeps tool calls and their matching results in one atomic group', () => {
    const messages: Message[] = [
      textMessage('u1', 'user', 'inspect'),
      { id: 'a1', role: 'assistant', createdAt: time, content: [{ type: 'tool_call', call: { id: 'c1', name: 'read', input: {} } }] },
      { id: 't1', role: 'tool', createdAt: time, content: [{ type: 'tool_result', result: { callId: 'c1', ok: true, content: 'ok' } }] },
      textMessage('a2', 'assistant', 'done')
    ];
    expect(groupContextMessages(messages).map((group) => group.map((message) => message.id))).toEqual([
      ['u1'], ['a1', 't1'], ['a2']
    ]);
  });

  it('reclaims large tool output and summarizes only complete old groups', async () => {
    const summarize = vi.fn(async () => 'requirements and completed inspection');
    const messages: Message[] = [
      textMessage('u1', 'user', 'x'.repeat(20_000)),
      { id: 'a1', role: 'assistant', createdAt: time, content: [{ type: 'tool_call', call: { id: 'c1', name: 'read', input: {} } }] },
      { id: 't1', role: 'tool', createdAt: time, content: [{ type: 'tool_result', result: { callId: 'c1', ok: true, content: 'y'.repeat(30_000) } }] },
      textMessage('u2', 'user', 'latest requirement'),
      textMessage('a2', 'assistant', 'z'.repeat(8_000))
    ];
    const result = await prepareModelContext({
      messages, tools: [], contextWindowTokens: 8_192, maxOutputTokens: 1_024,
      summarize, signal: new AbortController().signal
    });
    expect(result.compactedMessages).toBeGreaterThan(0);
    expect(result.reclaimedToolCharacters).toBeGreaterThan(0);
    expect(result.messages[0]?.metadata?.internal).toBe(true);
    expect(result.messages.some((message) => message.id === 'u2')).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });
});

class CapturingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private index = 0;
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.index++ === 0) {
      yield { type: 'text_delta', text: 'partial' };
      yield { type: 'response_completed', stopReason: 'max_tokens' };
    } else {
      yield { type: 'text_delta', text: ' finished' };
      yield { type: 'response_completed', stopReason: 'end_turn' };
    }
  }
}

describe('output truncation recovery', () => {
  it('continues a token-limited response with an internal persisted marker', async () => {
    const provider = new CapturingProvider();
    const events: string[] = [];
    const result = await runAgentTurn({
      sessionId: 's1', workingDirectory: process.cwd(), model: 'model', history: [], userText: 'go',
      provider, tools: [], permissionGate: { check: async () => ({ decision: 'allow' }) },
      signal: new AbortController().signal, emit: (event) => events.push(event.type), approve: async () => true
    });
    expect(provider.requests).toHaveLength(2);
    expect(events).toContain('output.continuing');
    expect(result.messages.some((message) => message.metadata?.internal)).toBe(true);
    expect(result.stopReason).toBe('end_turn');
  });
});

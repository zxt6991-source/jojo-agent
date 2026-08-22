import { describe, expect, it, vi } from 'vitest';
import type { Message, ModelEvent, ModelProvider, ModelRequest } from '@desktop-agent/contracts';
import { calculateContextBudget, groupContextMessages, prepareModelContext, runAgentTurn } from '../src/index.js';

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

  it('fails before compaction when fixed instructions and tools exceed the request budget', async () => {
    const tools = [{
      name: 'oversized_tool',
      description: 'x'.repeat(32_000),
      inputSchema: { type: 'object' as const, properties: {} }
    }];
    const budget = calculateContextBudget({
      tools, instructions: ['y'.repeat(16_000)],
      contextWindowTokens: 8_192, maxOutputTokens: 256
    });
    expect(budget.overCapacity).toBe(true);
    expect(budget.minimumContextWindowTokens).toBeGreaterThan(8_192);

    await expect(prepareModelContext({
      messages: [textMessage('u1', 'user', 'do not discard this task')],
      tools, instructions: ['y'.repeat(16_000)], contextWindowTokens: 8_192, maxOutputTokens: 256,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: 'context_overflow' });
  });

  it('keeps verbatim user requirements stable across repeated compactions', async () => {
    const summarize = vi.fn(async () => 'Model-generated summary without exact requirements.');
    const first = await prepareModelContext({
      messages: [
        textMessage('u1', 'user', '必须把全部划线整理到同一篇飞书文档'),
        textMessage('a1', 'assistant', 'a'.repeat(7_000)),
        textMessage('u2', 'user', '保留原书章节顺序和原文引用'),
        textMessage('a2', 'assistant', 'b'.repeat(7_000))
      ],
      tools: [], contextWindowTokens: 4_096, maxOutputTokens: 512,
      summarize, signal: new AbortController().signal
    });
    const firstSummary = first.compaction?.summary ?? '';
    expect(firstSummary).toContain(JSON.stringify('必须把全部划线整理到同一篇飞书文档'));
    expect(firstSummary).toContain(JSON.stringify('保留原书章节顺序和原文引用'));

    const second = await prepareModelContext({
      messages: [
        ...first.messages,
        textMessage('u3', 'user', '新增要求：标题不要重复'),
        textMessage('a3', 'assistant', 'c'.repeat(7_000))
      ],
      tools: [], contextWindowTokens: 4_096, maxOutputTokens: 512,
      summarize, signal: new AbortController().signal
    });
    const secondSummary = second.compaction?.summary ?? '';
    expect(secondSummary).toContain(JSON.stringify('必须把全部划线整理到同一篇飞书文档'));
    expect(secondSummary).toContain(JSON.stringify('保留原书章节顺序和原文引用'));
    expect(secondSummary).toContain(JSON.stringify('新增要求：标题不要重复'));
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

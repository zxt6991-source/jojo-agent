import type { Message, ModelEvent, ModelRequest } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatCompletionBody } from '../src/chat-completions-request.js';
import { parseChatCompletionStream } from '../src/chat-completions-stream.js';
import { OpenAICompatibleProvider } from '../src/index.js';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: 'test-model',
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    ...overrides
  };
}

function message(role: Message['role'], content: Message['content']): Message {
  return { id: `${role}-1`, role, content, createdAt: '2026-08-09T00:00:00.000Z' };
}

function streamFrom(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const collected: ModelEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Chat Completions request conversion', () => {
  it('serializes text, tool calls, tool results, and tool definitions', () => {
    const body = createChatCompletionBody(request({
      messages: [
        message('user', [{ type: 'text', text: 'inspect this' }]),
        message('assistant', [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_call', call: { id: 'call-1', name: 'read_file', input: { path: 'a.ts' } } }
        ]),
        message('tool', [{
          type: 'tool_result',
          result: { callId: 'call-1', ok: true, content: 'contents' }
        }])
      ],
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }]
    }));

    expect(body).toMatchObject({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system' },
        { role: 'user', content: 'inspect this' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'contents' }
      ],
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }
      }]
    });
  });
});

describe('Chat Completions stream parsing', () => {
  it('handles chunk boundaries, usage, and a final event without a trailing newline', async () => {
    const body = streamFrom(
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":3},"choices":[]}\n\n',
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]'
    );

    await expect(collect(parseChatCompletionStream(body))).resolves.toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'usage', inputTokens: 12, outputTokens: 3 },
      { type: 'response_completed', stopReason: 'stop' }
    ]);
  });

  it('assembles fragmented tool calls in index order and preserves invalid JSON', async () => {
    const body = streamFrom(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call-b","function":{"name":"write_","arguments":"{bad"}},{"index":0,"id":"call-a","function":{"name":"read_","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"a.ts\\"}"}},{"index":1,"function":{"name":"file","arguments":" json}"}}]},"finish_reason":"tool_calls"}]}\n\n'
    );

    const events = await collect(parseChatCompletionStream(body));
    expect(events.slice(-3)).toEqual([
      {
        type: 'tool_call_completed',
        call: { id: 'call-a', name: 'read_file', input: { path: 'a.ts' } }
      },
      {
        type: 'tool_call_completed',
        call: { id: 'call-b', name: 'write_file', input: { _invalidJson: '{bad json}' } }
      },
      { type: 'response_completed', stopReason: 'tool_calls' }
    ]);
  });
});

describe('OpenAICompatibleProvider', () => {
  it('normalizes the base URL and sends the expected authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://provider.example/v1///'
    });
    await collect(provider.stream(request()));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/chat/completions');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret'
      }
    });
  });

  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate_limit'],
    [500, 'provider_unavailable'],
    [400, 'provider_request']
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream detail', { status })));
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret' });

    await expect(collect(provider.stream(request()))).resolves.toEqual([{
      type: 'response_failed',
      code,
      message: `Provider returned HTTP ${status}: upstream detail`
    }]);
  });

  it('returns a timeout event when the response stream stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason));
        }
      });
      return new Response(body);
    }));
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret', timeoutMs: 10 });

    const result = collect(provider.stream(request()));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    await expect(result).resolves.toEqual([{
      type: 'response_failed',
      code: 'timeout',
      message: 'The model request timed out.'
    }]);
  });

  it('throws AbortError when the caller already cancelled the request', async () => {
    const controller = new AbortController();
    controller.abort('cancelled by user');
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret' });

    await expect(collect(provider.stream(request({ signal: controller.signal })))).rejects.toMatchObject({
      name: 'AbortError'
    });
  });
});

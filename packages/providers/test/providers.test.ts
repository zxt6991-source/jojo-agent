import type { Message, ModelEvent, ModelRequest } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChatCompletionBody } from '../src/chat-completions-request.js';
import { parseChatCompletionStream } from '../src/chat-completions-stream.js';
import { OpenAICompatibleEmbeddingProvider, OpenAICompatibleProvider, PROVIDER_REGISTRY, createProvider } from '../src/index.js';

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

  it('keeps tool content textual and follows it with a user vision message', () => {
    const body = createChatCompletionBody(request({
      instructions: ['MCP server “Vision” instructions:\nInspect images carefully.'],
      messages: [
        message('assistant', [{ type: 'tool_call', call: { id: 'vision-1', name: 'capture', input: {} } }]),
        message('tool', [{
          type: 'tool_result',
          result: {
            callId: 'vision-1', ok: true, content: 'Captured frame',
            contentBlocks: [
              { type: 'text', text: 'Captured frame' },
              { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
            ]
          }
        }])
      ]
    }));

    expect(body.messages).toEqual([
      { role: 'system', content: expect.stringContaining('Inspect images carefully.') },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'vision-1', type: 'function', function: { name: 'capture', arguments: '{}' } }]
      },
      {
        role: 'tool', tool_call_id: 'vision-1',
        content: 'Captured frame'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image output from tool call vision-1. Use it together with the preceding textual tool result.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
        ]
      }
    ]);
  });

  it('serializes user image attachments for vision-capable models', () => {
    const body = createChatCompletionBody(request({
      messages: [message('user', [
        { type: 'text', text: 'What is shown?' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=', name: 'screen.png' }
      ])]
    }));

    expect(body.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
        ]
      }
    ]);
  });

  it('emits every consecutive tool result before vision follow-up messages', () => {
    const body = createChatCompletionBody(request({
      messages: [
        message('assistant', [
          { type: 'tool_call', call: { id: 'one', name: 'first', input: {} } },
          { type: 'tool_call', call: { id: 'two', name: 'second', input: {} } }
        ]),
        message('tool', [{ type: 'tool_result', result: {
          callId: 'one', ok: true, content: 'first result',
          contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'b25l' }]
        } }]),
        message('tool', [{ type: 'tool_result', result: {
          callId: 'two', ok: true, content: 'second result',
          contentBlocks: [{ type: 'image', mimeType: 'image/png', data: 'dHdv' }]
        } }])
      ]
    }));

    expect((body.messages as Array<Record<string, unknown>>).slice(2).map((item) => item.role)).toEqual([
      'tool', 'tool', 'user', 'user'
    ]);
  });

  it('repairs an interrupted historical tool call before the next user message', () => {
    const body = createChatCompletionBody(request({
      messages: [
        message('assistant', [
          { type: 'text', text: 'Opening the page.' },
          { type: 'tool_call', call: { id: 'browser-1', name: 'browser_open', input: { url: 'https://example.com' } } }
        ]),
        message('user', [{ type: 'text', text: 'Try again.' }])
      ]
    }));

    expect(body.messages).toEqual([
      { role: 'system', content: expect.any(String) },
      {
        role: 'assistant', content: 'Opening the page.',
        tool_calls: [{
          id: 'browser-1', type: 'function',
          function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' }
        }]
      },
      {
        role: 'tool', tool_call_id: 'browser-1',
        content: 'Tool execution was interrupted before a result was recorded.'
      },
      { role: 'user', content: 'Try again.' }
    ]);
  });

  it('fills only the missing result when a multi-tool turn was partially recorded', () => {
    const body = createChatCompletionBody(request({
      messages: [
        message('assistant', [
          { type: 'tool_call', call: { id: 'one', name: 'first', input: {} } },
          { type: 'tool_call', call: { id: 'two', name: 'second', input: {} } }
        ]),
        message('tool', [{ type: 'tool_result', result: { callId: 'one', ok: true, content: 'done' } }]),
        message('user', [{ type: 'text', text: 'Continue.' }])
      ]
    }));

    expect((body.messages as Array<Record<string, unknown>>).slice(2)).toEqual([
      { role: 'tool', tool_call_id: 'one', content: 'done' },
      { role: 'tool', tool_call_id: 'two', content: 'Tool execution was interrupted before a result was recorded.' },
      { role: 'user', content: 'Continue.' }
    ]);
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
  it('loads, normalizes, and sorts models from the provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'model-z' }, { id: ' model-a ' }, { id: 'model-z' }, { missing: true }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://provider.example/v1///'
    });

    await expect(provider.listModels()).resolves.toEqual(['model-a', 'model-z']);
    expect(fetchMock).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer secret' }
    }));
  });

  it('loads only account-available tool models from OpenRouter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      object: 'list',
      data: [
        { id: 'tool-model', supported_parameters: ['tools', 'temperature'] },
        { id: 'text-model', supported_parameters: ['temperature'] },
        { id: 'unknown-model' }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: ' secret ',
      baseUrl: 'https://openrouter.ai/api/v1'
    });

    await expect(provider.listModels()).resolves.toEqual(['tool-model']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://openrouter.ai/api/v1/models/user?supported_parameters=tools'
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer secret' }
    });
  });

  it('rejects invalid or empty model-list responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret' });

    await expect(provider.listModels()).rejects.toThrow('no available models');
  });

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
        Authorization: 'Bearer secret'
      }
    });
  });

  it('sends text-only messages to the DeepSeek Chat Completions API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
      { status: 200 }
    ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'secret',
      baseUrl: 'https://api.deepseek.com'
    });

    await collect(provider.stream(request({
      messages: [message('user', [
        { type: 'text', text: 'Describe this.' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
      ])]
    })));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body.messages.find((item) => item.role === 'system')?.content).toContain('does not support image inputs');
    expect(body.messages.find((item) => item.role === 'user')?.content).toBe(
      'Describe this.\n\n[Image input omitted because the selected provider accepts text-only messages.]'
    );
    expect(JSON.stringify(body)).not.toContain('image_url');
  });

  it('retries a rejected rich request as text-only for compatible providers with unknown capabilities', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'unknown variant `image_url`, expected `text`' }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(
        'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n',
        { status: 200 }
      ));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret', baseUrl: 'https://provider.example/v1' });

    await expect(collect(provider.stream(request({
      messages: [message('user', [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }])]
    })))).resolves.toContainEqual({ type: 'response_completed', stopReason: 'stop' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = String((fetchMock.mock.calls[0]?.[1] as RequestInit).body);
    const retryBody = String((fetchMock.mock.calls[1]?.[1] as RequestInit).body);
    expect(firstBody).toContain('image_url');
    expect(retryBody).not.toContain('image_url');
    expect(retryBody).toContain('Image input omitted');
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

  it('turns OpenRouter tool-routing failures into an actionable model error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'No endpoints found that support tool use. Try disabling "read_file".' }
    }), { status: 404 })));
    const provider = new OpenAICompatibleProvider({ apiKey: 'secret' });

    await expect(collect(provider.stream(request()))).resolves.toEqual([{
      type: 'response_failed',
      code: 'model_tools_unsupported',
      message: 'The selected model has no endpoint that supports tool calling with the current provider routing settings. Refresh the model list and choose another tool-capable model.'
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

describe('provider registry', () => {
  it('registers and constructs the OpenAI-compatible adapter', () => {
    expect(PROVIDER_REGISTRY.map((entry) => entry.protocol)).toEqual(['openai_chat_completions']);
    expect(createProvider({
      id: 'compatible', name: 'Compatible', protocol: 'openai_chat_completions', baseUrl: 'https://provider.example/v1',
      model: 'model-a', models: ['model-a'], contextWindowTokens: 32_000, maxOutputTokens: 2_000, hasApiKey: true
    }, 'secret')).toBeInstanceOf(OpenAICompatibleProvider);
  });
});

describe('OpenAI-compatible embeddings', () => {
  it('uses the dedicated embeddings endpoint and returns Float32 vectors with usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] }
      ],
      usage: { prompt_tokens: 7 }
    })));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleEmbeddingProvider({
      id: 'remote', model: 'text-embedding', apiKey: 'secret', baseUrl: 'https://provider.example/v1///'
    });
    const result = await provider.embed(['one', 'two']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.example/v1/embeddings');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      model: 'text-embedding', input: ['one', 'two'], encoding_format: 'float'
    });
    expect([...result.vectors[0]!]).toEqual([1, 0]);
    expect(result.usage).toEqual({ inputTokens: 7 });
    expect(provider.remote).toBe(true);
  });

  it('classifies localhost as local and rejects inconsistent dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 2] }]
    }))));
    const provider = new OpenAICompatibleEmbeddingProvider({
      id: 'local', model: 'embed', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1'
    });
    expect(provider.remote).toBe(false);
    await expect(provider.embed(['one', 'two'])).rejects.toThrow('inconsistent dimensions');
  });
});

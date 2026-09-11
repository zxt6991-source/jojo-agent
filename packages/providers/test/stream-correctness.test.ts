import type { ModelRequest } from '@desktop-agent/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseChatCompletionStream } from '../src/chat-completions-stream.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible-provider.js';
import { retryDelay, requestPolicy } from '../src/request-policy.js';
import { readSseData } from '../src/sse.js';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (content: string) => frame({ choices: [{ delta: { content } }] });
const finish = (reason = 'stop') => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const tool = (id = 'one', index = 0, name = 'write', args = '{') =>
  frame({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] });
const req = (signal = new AbortController().signal): ModelRequest => ({ model: 'test', messages: [], tools: [], signal });
const body = (text: string) => new Response(text).body!;
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function provider(policy = {}) {
  return new OpenAICompatibleProvider({ apiKey: 'secret', requestPolicy: policy });
}
function hanging(text = '') {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; if (text) value.enqueue(new TextEncoder().encode(text)); }, cancel
  });
  return { stream, controller, cancel };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('strict stream completion', () => {
  it.each([
    ['', 'empty_response'],
    [': heartbeat\n\n', 'empty_response'],
    [frame({ usage: { prompt_tokens: 1 }, choices: [] }), 'empty_response'],
    [frame({ choices: [{ delta: { role: 'assistant' } }] }), 'empty_response'],
    ['data: [DONE]\n\n', 'empty_response'],
    [delta('partial'), 'provider_stream_incomplete'],
    [tool(), 'provider_stream_incomplete'],
    [frame({ error: { message: 'upstream' } }), 'provider_stream_error'],
    ['data: broken\n\n', 'provider_protocol_error'],
    ['data: []\n\n', 'provider_protocol_error'],
    [finish('content_filter'), 'provider_content_filtered'],
    [finish('unknown'), 'provider_protocol_error'],
    [tool() + finish('length'), 'provider_stream_incomplete'],
    [finish() + delta('late'), 'provider_protocol_error'],
    [finish() + finish('length'), 'provider_protocol_error'],
    [finish() + frame({ error: 'late' }), 'provider_stream_error'],
    [finish() + 'data: broken\n\n', 'provider_protocol_error'],
    [tool('') + finish('tool_calls'), 'provider_protocol_error'],
    [tool('one', 0, '') + finish('tool_calls'), 'provider_protocol_error'],
    [tool() + tool('one', 1) + finish('tool_calls'), 'provider_protocol_error'],
    [tool() + tool('two', 0) + finish('tool_calls'), 'provider_protocol_error']
  ])('fails safely for %j', async (source, code) => {
    const fetchMock = vi.fn(async () => new Response(source));
    vi.stubGlobal('fetch', fetchMock);
    const events = await collect(provider().stream(req()));
    expect(events.filter((e) => e.type === 'response_failed')).toEqual([expect.objectContaining({ code })]);
    expect(events.some((e) => e.type === 'response_completed' || e.type === 'tool_call_completed')).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each(['stop', 'length', 'tool_calls'])('preserves legal finish-only %s', async (reason) => {
    await expect(collect(parseChatCompletionStream(body(finish(reason))))).resolves.toEqual([
      { type: 'response_completed', stopReason: reason }
    ]);
  });
  it('accepts done-only solely with trusted policy and content', async () => {
    const options = { completionPolicy: { mode: 'done_only' as const, allowedFinishReasons: ['stop'] } };
    const source = delta('ok') + 'data: [DONE]\n\n';
    await expect(collect(parseChatCompletionStream(body(source)))).rejects.toMatchObject({ code: 'provider_stream_incomplete' });
    await expect(collect(parseChatCompletionStream(body(source), options))).resolves.toContainEqual({ type: 'response_completed', stopReason: 'stop' });
    await expect(collect(parseChatCompletionStream(body('data: [DONE]\n\n'), options))).rejects.toMatchObject({ code: 'empty_response' });
  });
  it('handles CRLF, split UTF-8, multiline data, and EOF without newline', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\nevent: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: tail');
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
      c.close();
    } });
    await expect(collect(readSseData(stream))).resolves.toEqual(['{"text":\n"你好"}', 'tail']);
  });
  it('stops at DONE without waiting for connection closure', async () => {
    const source = hanging(finish() + 'data: [DONE]\n\n');
    await expect(collect(parseChatCompletionStream(source.stream))).resolves.toContainEqual({ type: 'response_completed', stopReason: 'stop' });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
  });
});

describe('bounded request deadlines', () => {
  it.each(['response_headers', 'first_content', 'idle', 'total'])('times out %s and releases resources', async (phase) => {
    vi.useFakeTimers();
    const source = hanging(phase === 'idle' ? delta('first') : '');
    const fetchMock = vi.fn(() => phase === 'response_headers' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(source.stream)));
    vi.stubGlobal('fetch', fetchMock);
    const policy = { totalTimeoutMs: 1000, responseHeadersTimeoutMs: 500, firstContentTimeoutMs: 500, idleTimeoutMs: 500,
      [({ response_headers: 'responseHeadersTimeoutMs', first_content: 'firstContentTimeoutMs', idle: 'idleTimeoutMs', total: 'totalTimeoutMs' })[phase]!]: 10 };
    const result = collect(provider(policy).stream(req()));
    await vi.advanceTimersByTimeAsync(10);
    const events = await result;
    expect(events.at(-1)).toMatchObject({ type: 'response_failed', code: 'timeout', message: expect.stringContaining(phase) });
    expect(fetchMock).toHaveBeenCalledOnce();
    if (phase !== 'response_headers') { expect(source.cancel).toHaveBeenCalledOnce(); expect(source.stream.locked).toBe(false); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not refresh the first-content deadline with heartbeats, role, or usage', async () => {
    vi.useFakeTimers();
    const source = hanging();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ firstContentTimeoutMs: 20 }).stream(req()));
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5);
      source.controller.enqueue(new TextEncoder().encode(': heartbeat\n\n' + frame({ choices: [{ delta: { role: 'assistant' } }], usage: { prompt_tokens: 1 } })));
    }
    await vi.advanceTimersByTimeAsync(5);
    expect((await result).at(-1)).toMatchObject({ code: 'timeout', message: expect.stringContaining('first_content') });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('drains a finished response within its window and retains trailing usage', async () => {
    vi.useFakeTimers();
    const source = hanging(finish());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ finishDrainTimeoutMs: 20 }).stream(req()));
    await vi.advanceTimersByTimeAsync(10);
    source.controller.enqueue(new TextEncoder().encode(frame({ usage: { prompt_tokens: 2 }, choices: [] })));
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual([{ type: 'usage', inputTokens: 2 }, { type: 'response_completed', stopReason: 'stop' }]);
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('finishes with unknown usage after the drain window', async () => {
    vi.useFakeTimers();
    const source = hanging(finish());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ finishDrainTimeoutMs: 10 }).stream(req()));
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual([{ type: 'response_completed', stopReason: 'stop' }]);
  });
  it('accepts only transport failure after finish and gives total timeout priority', async () => {
    vi.useFakeTimers();
    const source = hanging(finish());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ totalTimeoutMs: 10, finishDrainTimeoutMs: 20 }).stream(req()));
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toEqual([expect.objectContaining({ code: 'timeout' })]);
    const second = hanging(finish());
    const events = collect(parseChatCompletionStream(second.stream));
    await vi.advanceTimersByTimeAsync(0);
    second.controller.error(new TypeError('terminated'));
    expect(await events).toEqual([{ type: 'response_completed', stopReason: 'stop' }]);
  });
  it.each(['headers', 'content', 'drain'])('cancels during %s without late terminal events', async (phase) => {
    vi.useFakeTimers();
    const source = hanging(phase === 'drain' ? finish() : '');
    vi.stubGlobal('fetch', vi.fn(() => phase === 'headers' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(source.stream))));
    const controller = new AbortController();
    const result = collect(provider().stream(req(controller.signal)));
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    if (phase !== 'headers') expect(source.cancel).toHaveBeenCalledOnce();
  });
});

describe('bounded retries', () => {
  it('retries 429 then succeeds with a single terminal event', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('slow', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockResolvedValueOnce(new Response(delta('ok') + finish()));
    vi.stubGlobal('fetch', fetchMock);
    const result = collect(provider().stream(req()));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual([{ type: 'text_delta', text: 'ok' }, { type: 'response_completed', stopReason: 'stop' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('exhausts three attempts and publishes one failure', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = collect(provider().stream(req()));
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual([expect.objectContaining({ code: 'provider_unavailable' })]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'ENOTFOUND'])('classifies network %s', async (code) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code } }))
      .mockResolvedValueOnce(new Response(finish()));
    vi.stubGlobal('fetch', fetchMock);
    const result = collect(provider().stream(req()));
    await vi.runAllTimersAsync();
    const retries = ['ECONNRESET', 'UND_ERR_SOCKET'].includes(code);
    expect(fetchMock).toHaveBeenCalledTimes(retries ? 2 : 1);
    expect((await result).at(-1)?.type).toBe(retries ? 'response_completed' : 'response_failed');
  });
  it.each([delta('partial'), frame({ choices: [], usage: { prompt_tokens: 1 } })])('does not retry after public events', async (prefix) => {
    vi.useFakeTimers();
    const source = hanging(prefix);
    const fetchMock = vi.fn(async () => new Response(source.stream));
    vi.stubGlobal('fetch', fetchMock);
    const result = collect(provider().stream(req()));
    await vi.advanceTimersByTimeAsync(0);
    source.controller.error(new TypeError('disconnected', { cause: { code: 'ECONNRESET' } }));
    expect((await result).at(-1)).toMatchObject({ code: 'network', message: expect.stringContaining('not saved as a completed result') });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('honors Retry-After dates and rejects a delay beyond the remaining deadline', async () => {
    const now = Date.parse('2026-09-11T00:00:00Z');
    expect(retryDelay(1, 'Fri, 11 Sep 2026 00:00:10 GMT', requestPolicy(), now, 1)).toBe(10000);
    expect(retryDelay(1, 'invalid', requestPolicy(), now, 1)).toBe(500);
    const fetchMock = vi.fn(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '100' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await collect(provider({ totalTimeoutMs: 50 }).stream(req()))).toEqual([expect.objectContaining({ code: 'rate_limit' })]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('shares the attempt budget with the text-only downgrade', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unknown variant `image_url`, expected `text`', { status: 400 }))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(new Response(finish()));
    vi.stubGlobal('fetch', fetchMock);
    const request = req();
    request.messages = [{ id: 'user', role: 'user', createdAt: '', content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] }];
    const result = collect(provider().stream(request));
    await vi.runAllTimersAsync();
    expect(await result).toEqual([{ type: 'response_completed', stopReason: 'stop' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = fetchMock.mock.calls.map((call) => String((call as unknown as [string, RequestInit])[1].body));
    expect(requests[0]).toContain('image_url');
    expect(requests[1]).not.toContain('image_url');
    expect(requests[1]).toBe(requests[2]);
  });
  it('cancels during retry backoff', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = collect(provider().stream(req(controller.signal)));
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('deadline and retry boundary races', () => {
  it('keeps a fixed total deadline despite continuing content', async () => {
    vi.useFakeTimers();
    const source = hanging();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ totalTimeoutMs: 20, firstContentTimeoutMs: 10, idleTimeoutMs: 10 }).stream(req()));
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5);
      source.controller.enqueue(new TextEncoder().encode(delta('progress')));
    }
    await vi.advanceTimersByTimeAsync(5);
    expect((await result).at(-1)).toMatchObject({ code: 'timeout', message: expect.stringContaining('total') });
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let usage or empty tool deltas refresh idle time', async () => {
    vi.useFakeTimers();
    const source = hanging(tool());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    const result = collect(provider({ idleTimeoutMs: 10 }).stream(req()));
    await vi.advanceTimersByTimeAsync(5);
    source.controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }], usage: { prompt_tokens: 1 } })));
    await vi.advanceTimersByTimeAsync(5);
    expect((await result).at(-1)).toMatchObject({ code: 'timeout', message: expect.stringContaining('idle') });
  });
  it('does not exceed the attempt cap when downgrade consumes an attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unknown variant `image_url`, expected `text`', { status: 400 }))
      .mockResolvedValueOnce(new Response('busy', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = req();
    request.messages = [{ id: 'u', role: 'user', createdAt: '', content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] }];
    const result = collect(provider({ maxAttempts: 2 }).stream(request));
    await vi.runAllTimersAsync();
    expect(await result).toEqual([expect.objectContaining({ code: 'rate_limit' })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('releases the reader when the consumer stops after a delta', async () => {
    vi.useFakeTimers();
    const source = hanging(delta('first'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source.stream)));
    for await (const event of provider().stream(req())) {
      expect(event.type).toBe('text_delta');
      break;
    }
    expect(source.cancel).toHaveBeenCalledOnce();
    expect(source.stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports attempt and backoff diagnostics without assuming missing usage is zero', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(finish())));
    const onDiagnostic = vi.fn();
    const result = collect(new OpenAICompatibleProvider({ apiKey: 'secret', onDiagnostic }).stream(req()));
    await vi.runAllTimersAsync();
    await result;
    expect(onDiagnostic.mock.calls.map(([event]) => event)).toEqual([
      { type: 'attempt', attempt: 1, elapsedMs: 0, published: false, usageReceived: false },
      { type: 'retry', attempt: 1, delayMs: 500 },
      { type: 'attempt', attempt: 2, elapsedMs: 0, published: true, usageReceived: false }
    ]);
  });
});

it('honors caller cancellation immediately after the last completion chunk', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(finish())));
  const controller = new AbortController();
  const events = provider().stream(req(controller.signal))[Symbol.asyncIterator]();
  expect((await events.next()).value).toEqual({ type: 'response_completed', stopReason: 'stop' });
  controller.abort();
  await expect(events.next()).rejects.toMatchObject({ name: 'AbortError' });
});

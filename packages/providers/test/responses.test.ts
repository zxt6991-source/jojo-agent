import { describe, expect, it, vi, afterEach } from 'vitest';
import type { ModelRequest } from '@desktop-agent/contracts';
import { createResponsesBody, parseResponsesStream, OpenAIResponsesProvider, createProvider } from '../src/index.js';
const stream = (events: unknown[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } });
const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => { const result: T[] = []; for await (const event of events) result.push(event); return result; };
const request = (): ModelRequest => ({ model: 'fixed', tools: [], messages: [], signal: new AbortController().signal });
afterEach(() => vi.unstubAllGlobals());
describe('native Responses protocol', () => {
  it('maps tools, images, original call IDs and opaque reasoning deterministically', () => {
    const value = request();
    value.tools = [{ name: 'z', description: 'z', inputSchema: { type: 'object' } }, { name: 'a', description: 'a', inputSchema: { type: 'object' } }];
    value.messages = [{ id: 'u', role: 'user', createdAt: '2026-10-07T00:00:00.000Z', content: [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }] }, { id: 'a', role: 'assistant', createdAt: '2026-10-07T00:00:00.000Z', metadata: { providerState: { protocol: 'openai_responses', model: 'fixed', reasoning: [{ type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] }] } }, content: [{ type: 'tool_call', call: { id: 'original', name: 'a', input: { x: 1 } } }] }, { id: 't', role: 'tool', createdAt: '2026-10-07T00:00:00.000Z', content: [{ type: 'tool_result', result: { callId: 'original', ok: true, content: 'done' } }] }];
    const body = createResponsesBody(value);
    expect(body.store).toBe(false);
    expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'original', output: 'done' });
    expect(body.input).toContainEqual({ type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] });
    expect(JSON.stringify(body)).toContain('input_image');
    expect((body.tools as { name: string }[]).map(tool => tool.name)).toEqual(['a', 'z']);
    expect(createResponsesBody({ ...value, model: 'other' }).input).not.toContainEqual({ type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] });
    expect(createProvider({ baseUrl: 'https://api.example/v1', protocol: 'openai_responses' }, 'key')).toBeInstanceOf(OpenAIResponsesProvider);
  });
  it('replays streaming function calls and terminal usage without exposing reasoning text', async () => {
    const events = await collect(parseResponsesStream(stream([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item', delta: '{"path":"a"}' },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read', arguments: '{"path":"a"}' } },
      { type: 'response.output_item.done', item: { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] } },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } }
    ]), 'fixed'));
    expect(events).toContainEqual({ type: 'tool_call_completed', call: { id: 'call', name: 'read', input: { path: 'a' } } });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 4 });
    expect(events.at(-1)).toEqual({ type: 'response_completed', stopReason: 'tool_calls' });
    expect(events.filter(event => event.type === 'text_delta')).toEqual([]);
  });
  it('rejects interrupted and malformed streams, and preserves cancellation', async () => {
    await expect(collect(parseResponsesStream(stream([{ type: 'response.output_text.delta', delta: 'partial' }]), 'fixed'))).rejects.toMatchObject({ code: 'provider_stream_incomplete' });
    await expect(collect(parseResponsesStream(stream([{ type: 'response.function_call_arguments.delta', item_id: 'unknown', delta: '{}' }]), 'fixed'))).rejects.toMatchObject({ code: 'provider_protocol_error' });
    const controller = new AbortController(); controller.abort();
    await expect(collect(new OpenAIResponsesProvider({ apiKey: 'key' }).stream({ ...request(), signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each(['unfinished', 'invalid_done', 'complete'])('discards all calls on output limit, including %s arguments, and retains usage', async (state) => {
    const events = [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'first', call_id: 'first', name: 'write' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'first', call_id: 'first', name: 'write', arguments: '{}' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'second', call_id: 'second', name: 'write' } },
      { type: 'response.function_call_arguments.delta', item_id: 'second', delta: state === 'complete' ? '{}' : '{' },
      ...(state === 'unfinished' ? [] : [{ type: 'response.output_item.done', item: { type: 'function_call', id: 'second', call_id: 'second', name: 'write', arguments: state === 'complete' ? '{}' : '{' } }]),
      { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 12, output_tokens: 8192 } } }
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(events))));
    const result = await collect(new OpenAIResponsesProvider({ apiKey: 'key' }).stream(request()));
    expect(result).toContainEqual({ type: 'usage', inputTokens: 12, outputTokens: 8192 });
    expect(result.at(-1)).toMatchObject({ type: 'response_failed', code: 'provider_tool_output_limit' });
    expect(result.some(event => event.type === 'tool_call_completed' || event.type === 'response_completed')).toBe(false);
  });
  it.each(['eof', 'invalid_json', 'unfinished', 'filtered'])('does not release completed calls before rejecting %s', async (ending) => {
    const events = [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'first', call_id: 'first', name: 'write' } },
      { type: 'response.output_item.done', item: { type: 'function_call', id: 'first', call_id: 'first', name: 'write', arguments: '{}' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'second', call_id: 'second', name: 'write' } },
      ...(ending === 'invalid_json' ? [{ type: 'response.output_item.done', item: { type: 'function_call', id: 'second', call_id: 'second', name: 'write', arguments: '{' } }] : []),
      ...(ending === 'eof' ? [] : [{ type: ending === 'filtered' ? 'response.incomplete' : 'response.completed', response: { incomplete_details: { reason: 'content_filter' } } }])
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream(events))));
    const result = await collect(new OpenAIResponsesProvider({ apiKey: 'key' }).stream(request()));
    expect(result.at(-1)).toMatchObject({ type: 'response_failed', code: ending === 'eof' ? 'provider_stream_incomplete' : ending === 'filtered' ? 'provider_content_filtered' : 'provider_protocol_error' });
    expect(result.some(event => event.type === 'tool_call_completed' || event.type === 'response_completed')).toBe(false);
  });
  it('preserves text-only output-limit continuation and cancellation after terminal usage', async () => {
    const terminal = { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 8192 } } };
    expect(await collect(parseResponsesStream(stream([terminal]), 'fixed'))).toEqual([
      { type: 'usage', outputTokens: 8192 }, { type: 'response_completed', stopReason: 'max_tokens' }
    ]);
    const controller = new AbortController();
    const events = parseResponsesStream(stream([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'write' } }, terminal
    ]), 'fixed', controller.signal)[Symbol.asyncIterator]();
    expect((await events.next()).value).toEqual({ type: 'usage', outputTokens: 8192 });
    controller.abort();
    await expect(events.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('uses /responses and classifies overflow errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('context window exceeded', { status: 400 })); vi.stubGlobal('fetch', fetch);
    const events = await collect(new OpenAIResponsesProvider({ apiKey: 'key', baseUrl: 'https://api.example/v1/' }).stream(request()));
    expect(fetch.mock.calls[0]?.[0]).toBe('https://api.example/v1/responses');
    expect(events).toContainEqual(expect.objectContaining({ type: 'response_failed', code: 'context_overflow' }));
  });
});

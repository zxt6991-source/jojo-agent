import { ProviderStateSchema, type ModelRequest, type ModelEvent, type ModelProvider, type DiscoveredModel } from '@desktop-agent/contracts';
import { toChatMessages, SYSTEM_PROMPT } from './chat-completions-request.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import { readSseData } from './sse.js';
import { ProviderStreamError } from './provider-errors.js';
import type { OpenAIProviderOptions } from './types.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
function protocolError(message: string): never { throw new ProviderStreamError('provider_protocol_error', message); }
export function createResponsesBody(request: ModelRequest): ObjectValue {
  const input: ObjectValue[] = [];
  const chat = toChatMessages(request.messages, request.attachments);
  // Replay opaque reasoning immediately before the matching assistant item.
  const assistantStates = request.messages.filter(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool_call' || (block.type === 'text' && block.text)))
    .map(message => message.metadata?.providerState?.model === request.model ? message.metadata.providerState : undefined);
  const emittedReasoning = new Set<string>();
  for (const message of chat.slice(1)) {
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls as ObjectValue[] : [];
    const state = message.role === 'assistant' ? assistantStates.shift() : undefined;
    for (const item of state?.reasoning ?? []) {
      if (emittedReasoning.has(item.id)) continue;
      input.push(item); emittedReasoning.add(item.id);
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
      continue;
    }
    if (message.content) {
      const content = Array.isArray(message.content) ? message.content.map(part => {
        const block = object(part)!;
        return block.type === 'image_url' ? { type: 'input_image', image_url: object(block.image_url)?.url, detail: 'auto' } : { type: 'input_text', text: block.text };
      }) : message.content;
      input.push({ role: message.role, content });
    }
    for (const call of calls) {
      const fn = object(call.function);
      input.push({ type: 'function_call', call_id: call.id, name: fn?.name, arguments: fn?.arguments });
    }
  }
  return { model: request.model, stream: true, store: false, include: ['reasoning.encrypted_content'],
    instructions: [SYSTEM_PROMPT, ...(request.instructions ?? [])].join('\n\n'), input,
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
    tools: [...request.tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false })) };
}
export async function* parseResponsesStream(body: ReadableStream<Uint8Array>, model: string, signal?: AbortSignal): AsyncIterable<ModelEvent> {
  const calls = new Map<string, { id: string; name: string; arguments: string; completed: boolean }>();
  const callIds = new Set<string>();
  const reasoning: unknown[] = [];
  let completed = false;
  for await (const data of readSseData(body, signal)) {
    signal?.throwIfAborted();
    let payload: ObjectValue | undefined;
    try { payload = object(JSON.parse(data)); } catch { protocolError('Malformed Responses event JSON.'); }
    if (!payload || typeof payload.type !== 'string') protocolError('Invalid Responses event envelope.');
    if (completed) protocolError('Responses event arrived after completion.');
    const type = payload.type;
    if (type === 'error' || type === 'response.failed') {
      const error = object(object(payload.response)?.error) ?? payload;
      throw new ProviderStreamError(String(error.code ?? 'provider_stream_error'), String(error.message ?? 'Response failed.').slice(0, 1000));
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (typeof payload.delta !== 'string') protocolError('Invalid text delta.');
      yield { type: 'text_delta', text: payload.delta };
    }
    if (type === 'response.output_item.added') {
      const item = object(payload.item);
      if (item?.type === 'function_call') {
        if (typeof item.id !== 'string' || typeof item.call_id !== 'string' || typeof item.name !== 'string' || callIds.has(item.call_id) || calls.has(item.id)) protocolError('Missing or duplicate function call identity.');
        calls.set(item.id, { id: item.call_id, name: item.name, arguments: '', completed: false });
        callIds.add(item.call_id);
      }
    }
    if (type === 'response.function_call_arguments.delta') {
      const call = calls.get(String(payload.item_id));
      if (!call || call.completed || typeof payload.delta !== 'string') protocolError('Invalid function arguments delta.');
      call.arguments += payload.delta;
      if (call.arguments.length > 2000000) protocolError('Function arguments exceed the limit.');
      yield { type: 'tool_call_delta', id: call.id, name: call.name, argumentsDelta: payload.delta };
    }
    if (type === 'response.output_item.done') {
      const item = object(payload.item);
      if (item?.type === 'function_call') {
        const call = calls.get(String(item.id));
        if (!call || call.completed || call.id !== item.call_id || call.name !== item.name || typeof item.arguments !== 'string' || item.arguments.length > 2000000 || (call.arguments && call.arguments !== item.arguments)) protocolError('Conflicting completed function call.');
        let input: unknown;
        try { input = JSON.parse(item.arguments); } catch { protocolError('Invalid completed function JSON.'); }
        call.completed = true;
        yield { type: 'tool_call_completed', call: { id: call.id, name: call.name, input } };
      }
      if (item?.type === 'reasoning' && item.encrypted_content) reasoning.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: item.summary ?? [] });
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = object(payload.response);
      if (!response) protocolError('Missing terminal response.');
      if ([...calls.values()].some(call => !call.completed)) protocolError('Unfinished function call at response completion.');
      if (reasoning.length) yield { type: 'provider_state', state: ProviderStateSchema.parse({ protocol: 'openai_responses', model, reasoning }) };
      const incompleteReason = object(response.incomplete_details)?.reason;
      const usage = object(response.usage);
      const cached = object(usage?.input_tokens_details)?.cached_tokens;
      if (usage) yield { type: 'usage', ...(typeof usage.input_tokens === 'number' ? { inputTokens: usage.input_tokens } : {}), ...(typeof usage.output_tokens === 'number' ? { outputTokens: usage.output_tokens } : {}), ...(typeof cached === 'number' ? { cacheReadInputTokens: cached } : {}) };
      completed = true;
      yield { type: 'response_completed', stopReason: type === 'response.incomplete' ? incompleteReason === 'max_output_tokens' ? 'max_tokens' : 'content_filter' : calls.size ? 'tool_calls' : 'stop' };
    }
  }
  if (!completed) throw new ProviderStreamError('provider_stream_incomplete', 'Responses stream ended without a terminal response.');
}
export class OpenAIResponsesProvider implements ModelProvider {
  readonly capabilities = { protocol: 'openai_responses' as const, toolCalls: true, vision: true, reasoning: true, usage: true, cacheUsage: true, cancellation: 'abort-stream' as const };
  constructor(private readonly options: OpenAIProviderOptions) {}
  listModels(signal?: AbortSignal): Promise<DiscoveredModel[]> { return new OpenAICompatibleProvider(this.options).listModels(signal); }
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    request.signal.throwIfAborted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? 90000);
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    try {
      const base = (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/u, '');
      const response = await fetch(`${base}/responses`, { method: 'POST', signal, headers: { Authorization: `Bearer ${this.options.apiKey.trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(createResponsesBody(request)) });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        const code = /context.*(?:length|window)|too many tokens/iu.test(detail) ? 'context_overflow' : response.status === 401 || response.status === 403 ? 'authentication' : response.status === 429 ? 'rate_limit' : 'provider_request';
        throw new ProviderStreamError(code, `Provider returned HTTP ${response.status}: ${detail}`);
      }
      if (!response.body) protocolError('Missing Responses stream body.');
      yield* parseResponsesStream(response.body, request.model, signal);
    } catch (error) {
      request.signal.throwIfAborted();
      yield { type: 'response_failed', code: timeout.signal.aborted ? 'provider_timeout' : error instanceof ProviderStreamError ? error.code : 'provider_request', message: error instanceof Error ? error.message : String(error) };
    } finally { clearTimeout(timer); }
  }
}

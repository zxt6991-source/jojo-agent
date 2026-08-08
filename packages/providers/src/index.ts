import type { ContentBlock, Message, ModelEvent, ModelProvider, ModelRequest, ToolCall } from '@desktop-agent/contracts';

type OpenAIProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

type ChatMessage = Record<string, unknown>;

function textOf(blocks: ContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function toChatMessages(messages: Message[]): ChatMessage[] {
  const result: ChatMessage[] = [{
    role: 'system',
    content: 'You are a local desktop coding assistant. Use tools when useful. Never claim a tool ran unless its result is present.'
  }];
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.content) {
        if (block.type === 'tool_result') {
          result.push({ role: 'tool', tool_call_id: block.result.callId, content: block.result.content });
        }
      }
      continue;
    }
    const toolCalls = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'tool_call' }> => block.type === 'tool_call')
      .map((block) => ({
        id: block.call.id,
        type: 'function',
        function: { name: block.call.name, arguments: JSON.stringify(block.call.input) }
      }));
    result.push({
      role: message.role,
      content: textOf(message.content) || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
  }
  return result;
}

function errorCode(status: number): string {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_request';
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out.')), this.timeoutMs);
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({
            model: request.model,
            stream: true,
            stream_options: { include_usage: true },
            messages: toChatMessages(request.messages),
            tools: request.tools.map((tool) => ({
              type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
            }))
          }),
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          yield { type: 'response_failed', code: 'timeout', message: 'The model request timed out.' };
          return;
        }
        yield { type: 'response_failed', code: 'network', message: `Cannot reach the model provider: ${error instanceof Error ? error.message : String(error)}` };
        return;
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000);
        yield { type: 'response_failed', code: errorCode(response.status), message: `Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
        return;
      }
      if (!response.body) {
        yield { type: 'response_failed', code: 'empty_response', message: 'The provider response had no body.' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const calls = new Map<number, { id: string; name: string; json: string }>();
      let stopReason = 'stop';
      const reader = response.body.getReader();
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        const chunk = read.value;
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let payload: any;
          try { payload = JSON.parse(data); } catch { continue; }
          if (payload.usage) {
            yield { type: 'usage', inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens };
          }
          const choice = payload.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) stopReason = choice.finish_reason;
          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) yield { type: 'text_delta', text: delta.content };
          for (const toolDelta of delta.tool_calls ?? []) {
            const index = Number(toolDelta.index ?? 0);
            const current = calls.get(index) ?? { id: toolDelta.id ?? `call_${index}`, name: '', json: '' };
            if (toolDelta.id) current.id = toolDelta.id;
            if (toolDelta.function?.name) current.name += toolDelta.function.name;
            if (toolDelta.function?.arguments) current.json += toolDelta.function.arguments;
            calls.set(index, current);
            yield {
              type: 'tool_call_delta', id: current.id,
              ...(toolDelta.function?.name ? { name: toolDelta.function.name as string } : {}),
              argumentsDelta: toolDelta.function?.arguments ?? ''
            };
          }
        }
      }
      for (const call of calls.values()) {
        let input: unknown;
        try { input = JSON.parse(call.json || '{}'); }
        catch {
          input = { _invalidJson: call.json };
        }
        const completed: ToolCall = { id: call.id, name: call.name, input };
        yield { type: 'tool_call_completed', call: completed };
      }
      yield { type: 'response_completed', stopReason };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', abort);
    }
  }
}

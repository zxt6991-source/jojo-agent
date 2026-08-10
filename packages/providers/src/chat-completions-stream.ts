import type { ModelEvent, ToolCall } from '@desktop-agent/contracts';

import { readSseData } from './sse.js';
import type { PendingToolCall } from './types.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? value as JsonObject : undefined;
}

function firstChoice(payload: JsonObject): JsonObject | undefined {
  const choices = payload.choices;
  return Array.isArray(choices) ? asObject(choices[0]) : undefined;
}

function usageEvent(payload: JsonObject): ModelEvent | undefined {
  const usage = asObject(payload.usage);
  if (!usage) return undefined;

  const inputTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined;
  const promptDetails = asObject(usage.prompt_tokens_details);
  const cacheReadInputTokens = typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined;
  return {
    type: 'usage',
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
  };
}

function completedToolCall(call: PendingToolCall): ToolCall {
  let input: unknown;
  try {
    input = JSON.parse(call.argumentsJson || '{}');
  } catch {
    input = { _invalidJson: call.argumentsJson };
  }
  return { id: call.id, name: call.name, input };
}

export async function* parseChatCompletionStream(
  body: ReadableStream<Uint8Array>
): AsyncIterable<ModelEvent> {
  const calls = new Map<number, PendingToolCall>();
  let stopReason = 'stop';

  for await (const data of readSseData(body)) {
    if (!data || data === '[DONE]') continue;

    let payload: JsonObject | undefined;
    try {
      payload = asObject(JSON.parse(data));
    } catch {
      continue;
    }
    if (!payload) continue;

    const usage = usageEvent(payload);
    if (usage) yield usage;

    const choice = firstChoice(payload);
    if (!choice) continue;

    if (typeof choice.finish_reason === 'string') stopReason = choice.finish_reason;
    const delta = asObject(choice.delta);
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'text_delta', text: delta.content };
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const value of toolCalls) {
      const toolDelta = asObject(value);
      if (!toolDelta) continue;

      const index = typeof toolDelta.index === 'number' ? toolDelta.index : 0;
      const current = calls.get(index) ?? {
        id: typeof toolDelta.id === 'string' ? toolDelta.id : `call_${index}`,
        name: '',
        argumentsJson: ''
      };
      const functionDelta = asObject(toolDelta.function);
      const nameDelta = typeof functionDelta?.name === 'string' ? functionDelta.name : '';
      const argumentsDelta = typeof functionDelta?.arguments === 'string' ? functionDelta.arguments : '';

      if (typeof toolDelta.id === 'string') current.id = toolDelta.id;
      current.name += nameDelta;
      current.argumentsJson += argumentsDelta;
      calls.set(index, current);

      yield {
        type: 'tool_call_delta',
        id: current.id,
        ...(nameDelta ? { name: nameDelta } : {}),
        argumentsDelta
      };
    }
  }

  for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
    yield { type: 'tool_call_completed', call: completedToolCall(call) };
  }
  yield { type: 'response_completed', stopReason };
}

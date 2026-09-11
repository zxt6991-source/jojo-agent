import type { ModelEvent, ToolCall } from '@desktop-agent/contracts';

import { ProviderStreamError } from './provider-errors.js';
import { readSseData } from './sse.js';
import type { PendingToolCall } from './types.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
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

export type CompletionPolicy = {
  mode: 'finish_reason' | 'done_only';
  allowedFinishReasons: readonly string[];
};

type StreamOptions = {
  signal?: AbortSignal;
  completionPolicy?: CompletionPolicy;
  finishDrainTimeoutMs?: number;
  onProgress?: (phase: 'content' | 'finish') => void;
};

function protocolError(message: string): never {
  throw new ProviderStreamError('provider_protocol_error', message);
}

export async function* parseChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions = {}
): AsyncIterable<ModelEvent> {
  const policy = options.completionPolicy ?? {
    mode: 'finish_reason', allowedFinishReasons: ['stop', 'tool_calls', 'length']
  };
  const calls = new Map<number, PendingToolCall>();
  let stopReason: string | undefined;
  let sawContent = false;
  let sawDone = false;
  const drain = new AbortController();
  const drainEnd = new Error('Finish drain ended');
  const signal = options.signal ? AbortSignal.any([options.signal, drain.signal]) : drain.signal;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    try {
      for await (const data of readSseData(body, signal)) {
        options.signal?.throwIfAborted();
        if (!data.trim()) continue;
        if (data.trim() === '[DONE]') {
          sawDone = true;
          break;
        }
        let payload: JsonObject | undefined;
        try {
          payload = asObject(JSON.parse(data));
        } catch {
          protocolError('The provider sent malformed JSON.');
        }
        if (!payload) protocolError('The provider sent a non-object envelope.');
        if (payload.error != null) {
          const detail = asObject(payload.error)?.message;
          throw new ProviderStreamError('provider_stream_error',
            `The provider reported a stream error${typeof detail === 'string' ? `: ${detail.slice(0, 1000)}` : '.'}`);
        }
        if (payload.choices !== undefined && !Array.isArray(payload.choices)) {
          protocolError('Invalid completion choices.');
        }
        const choices = (payload.choices ?? []) as unknown[];
        if (choices.length > 1) protocolError('Multiple completion choices are not supported.');
        const usage = usageEvent(payload);
        if (usage) yield usage;
        if (!choices.length) continue;
        const choice = asObject(choices[0]);
        if (!choice || (choice.index !== undefined && choice.index !== 0)) protocolError('Invalid completion choice.');
        if (choice.delta != null && !asObject(choice.delta)) protocolError('Invalid completion delta.');
        const delta = asObject(choice.delta) ?? {};
        if (delta.content != null && typeof delta.content !== 'string') protocolError('Invalid text delta.');
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) protocolError('Invalid tool deltas.');
        const toolCalls = (delta.tool_calls ?? []) as unknown[];
        const text = typeof delta.content === 'string' ? delta.content : '';
        if (stopReason && (text || toolCalls.length)) protocolError('Content arrived after the finish reason.');
        if (text) {
          sawContent = true;
          options.onProgress?.('content');
          yield { type: 'text_delta', text };
        }
        for (const value of toolCalls) {
          const toolDelta = asObject(value);
          if (!toolDelta || !Number.isInteger(toolDelta.index) || (toolDelta.index as number) < 0) {
            protocolError('A tool delta has no valid index.');
          }
          const index = toolDelta.index as number;
          const previous = calls.get(index);
          const id = toolDelta.id ?? previous?.id;
          if (typeof id !== 'string' || !id.trim() || (previous && previous.id !== id)) {
            protocolError('A tool call has a missing or conflicting ID.');
          }
          if ([...calls.entries()].some(([otherIndex, call]) => otherIndex !== index && call.id === id)) {
            protocolError('Duplicate tool call ID.');
          }
          const fn = asObject(toolDelta.function);
          if (toolDelta.function != null && !fn) protocolError('Invalid tool function.');
          if ((fn?.name != null && typeof fn.name !== 'string')
            || (fn?.arguments != null && typeof fn.arguments !== 'string')) protocolError('Invalid tool function delta.');
          const name = typeof fn?.name === 'string' ? fn.name : '';
          const args = typeof fn?.arguments === 'string' ? fn.arguments : '';
          if (previous && !name && !args) continue;
          const current = previous ?? { id, name: '', argumentsJson: '' };
          current.name += name;
          current.argumentsJson += args;
          calls.set(index, current);
          sawContent = true;
          options.onProgress?.('content');
          yield { type: 'tool_call_delta', id, ...(name ? { name } : {}), argumentsDelta: args };
        }
        if (choice.finish_reason != null) {
          const reason = choice.finish_reason;
          if (typeof reason !== 'string') protocolError('Invalid finish reason.');
          if (stopReason && reason !== stopReason) protocolError('Conflicting finish reasons.');
          if (reason === 'content_filter') {
            throw new ProviderStreamError('provider_content_filtered', 'The provider filtered this response.');
          }
          if (!policy.allowedFinishReasons.includes(reason)) protocolError('Unrecognized finish reason.');
          if (reason === 'length' && calls.size) {
            throw new ProviderStreamError('provider_stream_incomplete', 'Tool arguments reached the output limit.');
          }
          if (!stopReason) {
            stopReason = reason;
            options.onProgress?.('finish');
            drainTimer = setTimeout(() => drain.abort(drainEnd), options.finishDrainTimeoutMs ?? 2000);
          }
        }
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      // Only transport failures after a valid finish may be drained as success.
      if (!stopReason || error instanceof ProviderStreamError) throw error;
    }
    options.signal?.throwIfAborted();
    if (!stopReason && !(policy.mode === 'done_only' && sawDone && sawContent)) {
      throw new ProviderStreamError(sawContent ? 'provider_stream_incomplete' : 'empty_response',
        'The provider response ended without a valid finish reason. Response interrupted; this output was not saved as a completed result.');
    }
    for (const call of calls.values()) {
      if (!call.name.trim()) protocolError('A tool call has no function name.');
    }
    for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
      options.signal?.throwIfAborted();
      yield { type: 'tool_call_completed', call: completedToolCall(call) };
    }
    options.signal?.throwIfAborted();
    yield { type: 'response_completed', stopReason: stopReason ?? 'stop' };
  } finally {
    clearTimeout(drainTimer);
  }
}

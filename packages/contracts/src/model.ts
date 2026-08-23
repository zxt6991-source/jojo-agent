import type { Message, ToolCall } from './messages';
import type { ToolDefinition } from './tools';

export type ModelRequest = {
  model: string;
  messages: Message[];
  tools: ToolDefinition[];
  /** Trusted extension instructions appended to the provider system message. */
  instructions?: string[];
  signal: AbortSignal;
  maxOutputTokens?: number;
};

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; id: string; name?: string; argumentsDelta: string }
  | { type: 'tool_call_completed'; call: ToolCall }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
      /** Optional provider-computed request cost. */
      costUsd?: number;
    }
  | { type: 'response_completed'; stopReason: string }
  | { type: 'response_failed'; code: string; message: string };

export interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

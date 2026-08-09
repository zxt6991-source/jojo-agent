export type OpenAIProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
};

export type ChatMessage = Record<string, unknown>;

export type PendingToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

import type { RequestPolicy } from './request-policy.js';

/** Adapter-local diagnostics; absent usage means token consumption is unknown. */
export type ProviderRequestDiagnostic =
  | { type: 'attempt'; attempt: number; elapsedMs: number; published: boolean; usageReceived: boolean }
  | { type: 'retry'; attempt: number; delayMs: number };

export type OpenAIProviderOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  requestPolicy?: Partial<RequestPolicy>;
  onDiagnostic?: (event: ProviderRequestDiagnostic) => void;
};

export type ChatMessage = Record<string, unknown>;

export type PendingToolCall = {
  id: string;
  name: string;
  argumentsJson: string;
};

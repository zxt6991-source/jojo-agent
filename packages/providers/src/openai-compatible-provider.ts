import type { ModelEvent, ModelProvider, ModelRequest } from '@desktop-agent/contracts';

import { createChatCompletionBody } from './chat-completions-request.js';
import { parseChatCompletionStream } from './chat-completions-stream.js';
import type { OpenAIProviderOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ERROR_DETAIL_LENGTH = 1_000;

function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_request';
}

function cancellationError(): DOMException {
  return new DOMException('Cancelled', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listModels(): Promise<string[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Provider request timed out.')),
      this.timeoutMs
    );

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_LENGTH);
        throw new Error(`Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
        throw new Error('The provider returned an invalid model list.');
      }
      const models = Array.from(new Set((payload as { data: unknown[] }).data.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const id = (item as { id?: unknown }).id;
        return typeof id === 'string' && id.trim() ? [id.trim()] : [];
      }))).sort((left, right) => left.localeCompare(right));
      if (models.length === 0) throw new Error('The provider returned no available models.');
      return models;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('The model list request timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    if (request.signal.aborted) throw cancellationError();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Provider request timed out.')),
      this.timeoutMs
    );
    const cancelRequest = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', cancelRequest, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`
        },
        body: JSON.stringify(createChatCompletionBody(request)),
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_LENGTH);
        yield {
          type: 'response_failed',
          code: httpErrorCode(response.status),
          message: `Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        };
        return;
      }

      if (!response.body) {
        yield {
          type: 'response_failed',
          code: 'empty_response',
          message: 'The provider response had no body.'
        };
        return;
      }

      yield* parseChatCompletionStream(response.body);
    } catch (error) {
      if (request.signal.aborted) throw cancellationError();
      if (controller.signal.aborted) {
        yield {
          type: 'response_failed',
          code: 'timeout',
          message: 'The model request timed out.'
        };
        return;
      }
      yield {
        type: 'response_failed',
        code: 'network',
        message: `The model provider request failed: ${errorMessage(error)}`
      };
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', cancelRequest);
    }
  }
}

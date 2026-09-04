import type { ModelEvent, ModelProvider, ModelRequest } from '@desktop-agent/contracts';

import {
  createChatCompletionBody,
  hasChatImageInputs,
  toTextOnlyChatCompletionBody
} from './chat-completions-request.js';
import { parseChatCompletionStream } from './chat-completions-stream.js';
import type { OpenAIProviderOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_ERROR_DETAIL_LENGTH = 1_000;

function httpErrorCode(status: number, detail = ''): string {
  if (status === 404 && /(?:support(?:s|ed)?|supporting) tool (?:use|calls?|calling)/i.test(detail)) {
    return 'model_tools_unsupported';
  }
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_unavailable';
  return 'provider_request';
}

function providerErrorMessage(status: number, detail: string): string {
  if (httpErrorCode(status, detail) === 'model_tools_unsupported') {
    return 'The selected model has no endpoint that supports tool calling with the current provider routing settings. Refresh the model list and choose another tool-capable model.';
  }
  return `Provider returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

function rejectsImageMessageContent(status: number, detail: string): boolean {
  return status === 400 && /unknown variant [`'"]?image_url[`'"]?, expected [`'"]?text/i.test(detail);
}

function deepSeekRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.max_completion_tokens !== 'number') return body;
  const { max_completion_tokens: maxTokens, ...rest } = body;
  return { ...rest, max_tokens: maxTokens };
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
      const modelsUrl = new URL(`${this.baseUrl}/models`);
      const isOpenRouter = modelsUrl.hostname === 'openrouter.ai' || modelsUrl.hostname.endsWith('.openrouter.ai');
      if (isOpenRouter) {
        modelsUrl.pathname = `${modelsUrl.pathname.replace(/\/$/, '')}/user`;
        modelsUrl.searchParams.set('supported_parameters', 'tools');
      }
      const response = await fetch(modelsUrl.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.options.apiKey.trim()}` },
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
        const model = item as { id?: unknown; supported_parameters?: unknown };
        if (isOpenRouter && (!Array.isArray(model.supported_parameters) || !model.supported_parameters.includes('tools'))) {
          return [];
        }
        const id = model.id;
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
      const richBody = createChatCompletionBody(request);
      const providerUrl = new URL(this.baseUrl);
      const isDeepSeek = providerUrl.hostname === 'api.deepseek.com' || providerUrl.hostname.endsWith('.api.deepseek.com');
      let requestBody = isDeepSeek
        ? deepSeekRequestBody(hasChatImageInputs(richBody) ? toTextOnlyChatCompletionBody(richBody) : richBody)
        : richBody;
      const post = (body: Record<string, unknown>) => fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey.trim()}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      let response = await post(requestBody);

      if (!response.ok) {
        let detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_LENGTH);
        if (requestBody === richBody && hasChatImageInputs(richBody) && rejectsImageMessageContent(response.status, detail)) {
          requestBody = toTextOnlyChatCompletionBody(richBody);
          response = await post(requestBody);
          if (!response.ok) detail = (await response.text()).slice(0, MAX_ERROR_DETAIL_LENGTH);
        }
        if (!response.ok) {
          yield {
            type: 'response_failed',
            code: httpErrorCode(response.status, detail),
            message: providerErrorMessage(response.status, detail)
          };
          return;
        }
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

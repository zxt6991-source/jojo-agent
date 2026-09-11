import type { ModelEvent, ModelProvider, ModelRequest } from '@desktop-agent/contracts';

import {
  createChatCompletionBody,
  hasChatImageInputs,
  toTextOnlyChatCompletionBody
} from './chat-completions-request.js';
import { parseChatCompletionStream } from './chat-completions-stream.js';
import { ProviderStreamError, isRetryableStatus, isTransientNetworkError } from './provider-errors.js';
import { abortable, requestPolicy, retryDelay, timeoutError, waitForRetry } from './request-policy.js';
import type { OpenAIProviderOptions, ProviderRequestDiagnostic } from './types.js';

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

async function readErrorDetail(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let detail = '';
  try {
    while (detail.length < MAX_ERROR_DETAIL_LENGTH) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      detail += decoder.decode(value.subarray(0, MAX_ERROR_DETAIL_LENGTH * 4), { stream: true });
    }
    return (detail + decoder.decode()).slice(0, MAX_ERROR_DETAIL_LENGTH);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private diagnose(event: ProviderRequestDiagnostic): void {
    try { this.options.onDiagnostic?.(event); }
    catch { /* Diagnostics must not change request delivery or retry semantics. */ }
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
    const policy = requestPolicy(this.options.timeoutMs, this.options.requestPolicy);
    const controller = new AbortController();
    const deadline = Date.now() + policy.totalTimeoutMs;
    const timeout = setTimeout(() => controller.abort(timeoutError('total')), policy.totalTimeoutMs);
    const cancelRequest = () => controller.abort(cancellationError());
    request.signal.addEventListener('abort', cancelRequest, { once: true });
    let published = false;

    try {
      const richBody = createChatCompletionBody(request);
      const providerUrl = new URL(this.baseUrl);
      const isDeepSeek = providerUrl.hostname === 'api.deepseek.com' || providerUrl.hostname.endsWith('.api.deepseek.com');
      let requestBody = isDeepSeek
        ? deepSeekRequestBody(hasChatImageInputs(richBody) ? toTextOnlyChatCompletionBody(richBody) : richBody)
        : richBody;
      let downgraded = false;
      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        controller.signal.throwIfAborted();
        const attemptController = new AbortController();
        const signal = AbortSignal.any([controller.signal, attemptController.signal]);
        let phaseTimer: ReturnType<typeof setTimeout> | undefined;
        const phase = (name: string, ms: number) => {
          clearTimeout(phaseTimer);
          phaseTimer = setTimeout(() => attemptController.abort(timeoutError(name)), ms);
        };
        const startedAt = Date.now();
        let usageReceived = false;
        let response: Response | undefined;
        let failure: unknown;
        let retryable = false;
        let retryAfter: string | null = null;
        let downgrade = false;
        try {
          phase('response_headers', policy.responseHeadersTimeoutMs);
          const pendingResponse = fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              Authorization: `Bearer ${this.options.apiKey.trim()}`
            },
            body: JSON.stringify(requestBody),
            signal
          });
          // Dispose a late response from transports that ignore the abort signal.
          void pendingResponse.then((late) => {
            if (signal.aborted) void late.body?.cancel().catch(() => {});
          }, () => {});
          response = await abortable(pendingResponse, signal);
          phase('first_content', policy.firstContentTimeoutMs);
          if (!response.ok) {
            const detail = await readErrorDetail(response, signal);
            failure = new ProviderStreamError(httpErrorCode(response.status, detail), providerErrorMessage(response.status, detail));
            downgrade = !downgraded && requestBody === richBody && hasChatImageInputs(richBody)
              && rejectsImageMessageContent(response.status, detail);
            retryable = isRetryableStatus(response.status);
            retryAfter = response.headers.get('retry-after');
          } else {
            if (!response.body) throw new ProviderStreamError('empty_response', 'The provider response had no body.');
            for await (const event of parseChatCompletionStream(response.body, {
              signal,
              finishDrainTimeoutMs: policy.finishDrainTimeoutMs,
              onProgress: (progress) => {
                if (progress === 'finish') clearTimeout(phaseTimer);
                else phase('idle', policy.idleTimeoutMs);
              }
            })) {
              signal.throwIfAborted();
              if (event.type === 'usage') usageReceived = true;
              published = true; // Usage is public progress too: never retry after any event.
              yield event;
            }
            if (request.signal.aborted) throw cancellationError();
            return;
          }
        } catch (error) {
          failure = signal.aborted ? signal.reason : error;
          retryable = !(failure instanceof ProviderStreamError) && isTransientNetworkError(failure);
        } finally {
          clearTimeout(phaseTimer);
          this.diagnose({ type: 'attempt', attempt, elapsedMs: Date.now() - startedAt, published, usageReceived });
          attemptController.abort();
          if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
        }
        controller.signal.throwIfAborted();
        if (published || attempt === policy.maxAttempts || (!downgrade && !retryable)) throw failure;
        if (downgrade) {
          downgraded = true;
          requestBody = toTextOnlyChatCompletionBody(richBody);
          continue;
        }
        const delay = retryDelay(attempt, retryAfter, policy);
        // Retry-After is a minimum: do not shorten it to fit the remaining budget.
        if (delay >= deadline - Date.now()) throw failure;
        this.diagnose({ type: 'retry', attempt, delayMs: delay });
        await waitForRetry(delay, controller.signal);
      }
    } catch (error) {
      if (request.signal.aborted) throw cancellationError();
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      const detail = failure instanceof ProviderStreamError ? failure.message
        : `The model provider request failed: ${errorMessage(failure).slice(0, MAX_ERROR_DETAIL_LENGTH)}`;
      yield {
        type: 'response_failed',
        code: failure instanceof ProviderStreamError ? failure.code : 'network',
        message: published && !detail.includes('not saved as a completed result')
          ? `${detail} Response interrupted; this output was not saved as a completed result.` : detail
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
      request.signal.removeEventListener('abort', cancelRequest);
    }
  }
}

import type { EmbeddingProvider } from '@desktop-agent/contracts';
import type { OpenAIProviderOptions } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

function isLocalBaseUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLocaleLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly remote: boolean;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly options: OpenAIProviderOptions;

  constructor(input: OpenAIProviderOptions & { id: string; model: string }) {
    this.options = input;
    this.id = input.id;
    this.model = input.model;
    this.baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.remote = !isLocalBaseUrl(this.baseUrl);
  }

  async embed(texts: string[], options: { signal?: AbortSignal } = {}): Promise<{
    vectors: Float32Array[];
    usage?: { inputTokens?: number; costUsd?: number };
  }> {
    if (!texts.length) return { vectors: [] };
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Embedding request timed out.')), this.timeoutMs);
    const cancel = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey.trim()}`
        },
        body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }),
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 1_000);
        throw new Error(`Embedding Provider returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      const payload = await response.json() as {
        data?: Array<{ index?: unknown; embedding?: unknown }>;
        usage?: { prompt_tokens?: unknown; total_tokens?: unknown };
      };
      if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
        throw new Error('Embedding Provider returned an invalid vector count.');
      }
      const ordered = [...payload.data].sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0));
      const vectors = ordered.map((item) => {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0
          || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new Error('Embedding Provider returned an invalid vector.');
        }
        return Float32Array.from(item.embedding as number[]);
      });
      const dimensions = vectors[0]!.length;
      if (vectors.some((vector) => vector.length !== dimensions)) {
        throw new Error('Embedding Provider returned inconsistent dimensions.');
      }
      const inputTokens = typeof payload.usage?.prompt_tokens === 'number'
        ? payload.usage.prompt_tokens
        : typeof payload.usage?.total_tokens === 'number' ? payload.usage.total_tokens : undefined;
      return { vectors, ...(inputTokens !== undefined ? { usage: { inputTokens } } : {}) };
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (controller.signal.aborted) throw new Error('Embedding request timed out.');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}

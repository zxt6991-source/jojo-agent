/** Internal errors are converted to a single public failure by the adapter. */
export class ProviderStreamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProviderStreamError';
  }
}

export function isTransientNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String(value.code))
    || (value.cause !== undefined && value.cause !== error && isTransientNetworkError(value.cause));
}

export function isRetryableStatus(status: number): boolean {
  return [429, 500, 502, 503, 504].includes(status);
}

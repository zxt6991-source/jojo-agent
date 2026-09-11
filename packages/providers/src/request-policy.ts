import { ProviderStreamError } from './provider-errors.js';

export type RequestPolicy = {
  totalTimeoutMs: number;
  responseHeadersTimeoutMs: number;
  firstContentTimeoutMs: number;
  idleTimeoutMs: number;
  finishDrainTimeoutMs: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
};

export function requestPolicy(timeoutMs?: number, overrides: Partial<RequestPolicy> = {}): RequestPolicy {
  const policy = {
    totalTimeoutMs: timeoutMs ?? 90_000,
    responseHeadersTimeoutMs: 30_000,
    firstContentTimeoutMs: 60_000,
    idleTimeoutMs: 30_000,
    finishDrainTimeoutMs: 2_000,
    maxAttempts: 3,
    baseRetryDelayMs: 500,
    maxRetryDelayMs: 5_000,
    ...overrides
  };
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < (key.includes('Delay') ? 0 : 1)
      || value > 2_147_483_647) throw new Error(`Invalid request policy: ${key}`);
  }
  if (!Number.isInteger(policy.maxAttempts)) throw new Error('maxAttempts must be an integer.');
  return policy;
}

/** Race even test/custom transports that do not implement fetch cancellation. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }), signal);
  } finally {
    clearTimeout(timer);
  }
}

export function retryDelay(attempt: number, retryAfter: string | null, policy: RequestPolicy,
  now = Date.now(), random = Math.random()): number {
  const cap = Math.min(policy.maxRetryDelayMs, policy.baseRetryDelayMs * 2 ** (attempt - 1));
  const backoff = cap * (0.5 + random * 0.5);
  let serverDelay = 0;
  if (retryAfter !== null) {
    const seconds = /^\s*\d+(?:\.\d+)?\s*$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const date = Date.parse(retryAfter);
    serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(0, date - now) : 0;
  }
  return Math.max(backoff, serverDelay);
}

export function timeoutError(phase: string): ProviderStreamError {
  return new ProviderStreamError('timeout', `The model request timed out (${phase}).`);
}

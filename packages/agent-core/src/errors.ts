export class AgentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The turn was cancelled.', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

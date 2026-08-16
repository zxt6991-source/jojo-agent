export class OrchestrationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'OrchestrationError';
  }
}

export function orchestrationErrorCode(error: unknown, fallback: string): string {
  return error instanceof OrchestrationError ? error.code : fallback;
}

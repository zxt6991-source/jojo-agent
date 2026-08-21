import type { HookErrorCode } from '@desktop-agent/contracts';

export class HookExecutionError extends Error {
  constructor(readonly code: HookErrorCode, message: string) {
    super(message);
    this.name = 'HookExecutionError';
  }
}

export function hookError(error: unknown): HookExecutionError {
  return error instanceof HookExecutionError
    ? error
    : new HookExecutionError('hook_internal_error', error instanceof Error ? error.message : String(error));
}

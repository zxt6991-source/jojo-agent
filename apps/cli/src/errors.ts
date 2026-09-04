export const ExitCode = {
  success: 0,
  failure: 1,
  invalidConfig: 2,
  alreadyRunning: 3,
  bindFailure: 4,
  secretFailure: 5,
  storageFailure: 6,
  serviceFailure: 7,
  shutdownTimeout: 8
} as const;

export class JojoCliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly details?: Record<string, unknown>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'JojoCliError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatFatalError(error: unknown): string {
  if (error instanceof JojoCliError) return `${error.code}: ${error.message}`;
  return `JOJO_CLI_FAILED: ${errorMessage(error)}`;
}

export function exitCodeFor(error: unknown): number {
  return error instanceof JojoCliError ? error.exitCode : ExitCode.failure;
}

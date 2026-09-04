import type { Logger } from 'pino';
import { ExitCode, JojoCliError } from '../errors.js';

type ShutdownReason = NodeJS.Signals | 'uncaughtException' | 'unhandledRejection';

export type ShutdownController = {
  wait(): Promise<void>;
  dispose(): void;
};

export function installShutdownHandlers(input: {
  close: () => Promise<void>;
  logger: Logger;
  timeoutMs: number;
}): ShutdownController {
  let resolveWait: (() => void) | undefined;
  let rejectWait: ((error: unknown) => void) | undefined;
  let shuttingDown = false;
  const wait = new Promise<void>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });

  const shutdown = async (reason: ShutdownReason, fatal?: unknown) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (fatal !== undefined) input.logger.fatal({ event: `process.${reason === 'uncaughtException' ? 'uncaught_exception' : 'unhandled_rejection'}`, error: fatal });
    else input.logger.info({ event: 'process.signal', signal: reason });
    input.logger.info({ event: 'server.stopping', reason });
    try {
      await withTimeout(input.close(), input.timeoutMs);
      input.logger.info({ event: 'server.stopped' });
      if (fatal !== undefined) rejectWait?.(fatal);
      else resolveWait?.();
    } catch (error) {
      input.logger.error({ event: 'server.stop_failed', error });
      rejectWait?.(error);
    }
  };
  const sigint = () => void shutdown('SIGINT');
  const sigterm = () => void shutdown('SIGTERM');
  const uncaught = (error: Error) => void shutdown('uncaughtException', error);
  const rejection = (reason: unknown) => void shutdown('unhandledRejection', reason);
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  process.once('uncaughtException', uncaught);
  process.once('unhandledRejection', rejection);
  return {
    wait: () => wait,
    dispose() {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
      process.off('uncaughtException', uncaught);
      process.off('unhandledRejection', rejection);
    }
  };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new JojoCliError(
          `Server shutdown exceeded ${timeoutMs}ms.`,
          'SERVER_SHUTDOWN_TIMEOUT',
          ExitCode.shutdownTimeout
        )), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

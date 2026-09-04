import { readRuntimeStatus, isProcessAlive } from '../bootstrap/instance-lock.js';
import { ExitCode, JojoCliError } from '../errors.js';
import { loadCommandConfig, type ConfigOptions } from './common.js';

export async function stopCommand(
  options: ConfigOptions & { force?: boolean; timeout?: number },
  output: NodeJS.WritableStream
): Promise<void> {
  const config = await loadCommandConfig(options);
  const status = await readRuntimeStatus(config.paths.statusFile) ?? await readRuntimeStatus(config.paths.lockFile);
  if (!status || !isProcessAlive(status.pid)) {
    output.write(`Instance "${config.runtime.instanceId}" is not running.\n`);
    return;
  }
  if (status.instanceId !== config.runtime.instanceId) {
    throw new JojoCliError('PID identity does not match the requested instance.', 'PROCESS_IDENTITY_MISMATCH', ExitCode.failure);
  }
  process.kill(status.pid, 'SIGTERM');
  const deadline = Date.now() + (options.timeout ?? config.shutdown.timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(status.pid)) {
      output.write(`Stopped instance "${status.instanceId}".\n`);
      return;
    }
    await delay(100);
  }
  if (options.force) {
    process.kill(status.pid, 'SIGKILL');
    output.write(`Force-stopped instance "${status.instanceId}".\n`);
    return;
  }
  throw new JojoCliError(
    `Instance did not stop within ${options.timeout ?? config.shutdown.timeoutMs}ms. Re-run with --force to send SIGKILL.`,
    'SERVER_STOP_TIMEOUT',
    ExitCode.shutdownTimeout
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

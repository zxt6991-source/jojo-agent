import { inspectServer, formatUptime } from '../diagnostics/process-info.js';
import { loadCommandConfig, type ConfigOptions } from './common.js';

export async function statusCommand(options: ConfigOptions & { json?: boolean; quiet?: boolean }, output: NodeJS.WritableStream): Promise<void> {
  const config = await loadCommandConfig(options);
  const status = await inspectServer(config);
  if (options.json) {
    output.write(`${JSON.stringify(status, undefined, 2)}\n`);
    return;
  }
  if (options.quiet) {
    output.write(`${status.status}\n`);
    return;
  }
  output.write(`Jojo Server\n\n`);
  output.write(`Status:       ${status.status}\n`);
  output.write(`PID:          ${status.pid ?? '-'}\n`);
  output.write(`Instance:     ${status.instanceId}\n`);
  output.write(`Version:      ${status.version ?? '-'}\n`);
  output.write(`Address:      ${status.address ?? '-'}\n`);
  output.write(`Health:       ${status.health ?? '-'}\n`);
  output.write(`Ready:        ${status.ready === undefined ? '-' : status.ready ? 'ready' : 'not ready'}\n`);
  output.write(`Data Dir:     ${status.dataDir}\n`);
  output.write(`Config:       ${status.configFile}\n`);
  output.write(`Uptime:       ${formatUptime(status.uptimeMs)}\n`);
}

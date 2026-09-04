import { createServiceManager } from '../service/service-manager.js';
import { loadCommandConfig, type ConfigOptions } from './common.js';

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';

export async function serviceCommand(action: ServiceAction, options: ConfigOptions & { json?: boolean }, output: NodeJS.WritableStream): Promise<void> {
  const config = await loadCommandConfig(options);
  const manager = createServiceManager();
  if (action === 'install') {
    await manager.install({
      config,
      executable: process.execPath,
      ...(process.argv[1] ? { script: process.argv[1] } : {})
    });
    output.write(`Installed ${manager.definitionPath}\nRun: jojo service start\n`);
    return;
  }
  if (action === 'uninstall') {
    await manager.uninstall();
    output.write(`Uninstalled ${manager.definitionPath}\n`);
    return;
  }
  if (action === 'start') await manager.start();
  if (action === 'stop') await manager.stop();
  if (action === 'restart') await manager.restart();
  const status = await manager.status();
  if (options.json) output.write(`${JSON.stringify(status, undefined, 2)}\n`);
  else output.write(`Service: ${status.installed ? (status.running ? 'running' : 'stopped') : 'not installed'}\n`);
}

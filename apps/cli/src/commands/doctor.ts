import { loadCommandConfig, type ConfigOptions } from './common.js';
import { diagnose } from '../diagnostics/doctor.js';

export async function doctorCommand(options: ConfigOptions & { json?: boolean }, output: NodeJS.WritableStream): Promise<void> {
  const config = await loadCommandConfig(options);
  const checks = await diagnose(config);
  if (options.json) {
    output.write(`${JSON.stringify({ checks }, undefined, 2)}\n`);
    return;
  }
  output.write('Jojo Doctor\n\n');
  for (const check of checks) output.write(`${check.status === 'ok' ? '✓' : '!'} ${check.message}\n`);
}

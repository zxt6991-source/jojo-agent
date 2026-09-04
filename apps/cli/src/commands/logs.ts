import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServiceManager } from '../service/service-manager.js';
import { loadCommandConfig, type ConfigOptions } from './common.js';

export async function logsCommand(
  options: ConfigOptions & { follow?: boolean; lines?: number; level?: string; file?: boolean },
  output: NodeJS.WritableStream
): Promise<void> {
  const config = await loadCommandConfig(options);
  const lines = options.lines ?? 200;
  if (!options.file) {
    try {
      await createServiceManager().logs({ follow: options.follow ?? false, lines });
      return;
    } catch {
      // Fall back to the configured application log.
    }
  }
  const file = config.logging.file ?? path.join(config.paths.logDir, 'jojo-server.log');
  if (options.follow) {
    await spawnInherited('tail', ['-f', '-n', String(lines), file]);
    return;
  }
  const records = (await readFile(file, 'utf8')).trimEnd().split('\n').slice(-lines);
  for (const record of records) {
    if (!options.level || recordLevel(record) >= levelNumber(options.level)) output.write(`${record}\n`);
  }
}

function recordLevel(line: string): number {
  try { return Number((JSON.parse(line) as { level?: unknown }).level ?? 0); } catch { return 100; }
}

function levelNumber(level: string): number {
  return { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }[level] ?? 0;
}

async function spawnInherited(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { stringify as stringifyYaml } from 'yaml';
import { runPreflight } from '../bootstrap/preflight.js';
import { loadConfig } from '../config/loader.js';
import { defaultConfigPath, expandPath } from '../config/paths.js';
import { redactConfig } from '../config/redact.js';
import { DEFAULT_CONFIG_YAML } from '../config/template.js';
import { ExitCode, JojoCliError } from '../errors.js';

export async function configPathCommand(options: { config?: string }, output: NodeJS.WritableStream): Promise<void> {
  output.write(`${expandPath(options.config ?? process.env.JOJO_CONFIG ?? defaultConfigPath())}\n`);
}

export async function configInitCommand(options: { config?: string; force?: boolean }, output: NodeJS.WritableStream): Promise<void> {
  const file = expandPath(options.config ?? process.env.JOJO_CONFIG ?? defaultConfigPath());
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (options.force) await writeFile(file, DEFAULT_CONFIG_YAML, { mode: 0o600 });
  else {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(DEFAULT_CONFIG_YAML, 'utf8');
      await handle.close();
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new JojoCliError(`Config already exists: ${file}. Use --force to replace it.`, 'CONFIG_EXISTS', ExitCode.invalidConfig);
      }
      throw error;
    }
  }
  output.write(`Created ${file}\n`);
}

export async function configShowCommand(options: { config?: string; effective?: boolean }, output: NodeJS.WritableStream): Promise<void> {
  const config = await loadConfig({ ...(options.config ? { configPath: options.config } : {}) });
  const shown = redactConfig(config);
  if (!options.effective) delete shown.paths;
  output.write(stringifyYaml(shown));
}

export async function configValidateCommand(options: { config?: string }, output: NodeJS.WritableStream): Promise<void> {
  const config = await loadConfig({ ...(options.config ? { configPath: options.config } : {}) });
  const checks = await runPreflight(config);
  for (const check of checks) output.write(`${check.status === 'ok' ? 'OK' : 'WARN'} ${check.name}: ${check.message}\n`);
}

export function generateTokenCommand(output: NodeJS.WritableStream): void {
  output.write(`export JOJO_SERVER_TOKEN='${randomBytes(32).toString('base64url')}'\n`);
}

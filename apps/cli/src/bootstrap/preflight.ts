import { constants } from 'node:fs';
import { access, mkdir, open, unlink } from 'node:fs/promises';
import net from 'node:net';
import type { EffectiveConfig } from '../config/schema.js';
import type { Secret } from '../config/schema.js';
import { resolveSecret } from '../config/redact.js';
import { ExitCode, JojoCliError, errorMessage } from '../errors.js';
import { validateProviderSecret } from './runtime-dependencies.js';

export type CheckResult = { name: string; status: 'ok' | 'warning'; message: string };

export async function runPreflight(config: EffectiveConfig, options: { requireProviderSecret?: boolean } = {}): Promise<CheckResult[]> {
  validateRemoteBinding(config);
  await Promise.all([
    ensureWritable(config.paths.dataDir),
    ensureWritable(config.paths.runDir),
    ...(config.logging.file ? [ensureWritable(config.paths.logDir)] : [])
  ]);
  await checkPort(config.server.host, config.server.port);
  const results: CheckResult[] = [
    { name: 'config', status: 'ok', message: 'Configuration is valid' },
    { name: 'dataDir', status: 'ok', message: `${config.paths.dataDir} is writable` },
    { name: 'runDir', status: 'ok', message: `${config.paths.runDir} is writable` },
    { name: 'bind', status: 'ok', message: `${config.server.host}:${config.server.port} is available` }
  ];
  const literalSecrets = configuredLiteralSecrets(config);
  for (const name of literalSecrets) {
    results.push({
      name: 'config.secret_literal',
      status: 'warning',
      message: `${name} is configured as a literal; prefer an environment reference`
    });
  }
  try {
    validateProviderSecret(config);
    results.push({ name: 'provider', status: 'ok', message: 'Default provider secret is available' });
  } catch (error) {
    if (options.requireProviderSecret) throw error;
    results.push({ name: 'provider', status: 'warning', message: errorMessage(error) });
  }
  return results;
}

function configuredLiteralSecrets(config: EffectiveConfig): string[] {
  const names: string[] = [];
  if (isLiteral(config.server.token)) names.push('server.token');
  for (const [providerId, provider] of Object.entries(config.provider.providers)) {
    if (isLiteral(provider.apiKey)) names.push(`provider.providers.${providerId}.apiKey`);
  }
  return names;
}

function isLiteral(secret: Secret | undefined): boolean {
  return typeof secret === 'string' || Boolean(secret && typeof secret === 'object' && 'literal' in secret);
}

export function validateRemoteBinding(config: EffectiveConfig): void {
  if (isLoopback(config.server.host)) return;
  if (!config.server.allowRemote || !resolveSecret(config.server.token)) {
    throw new JojoCliError(
      'Refusing remote bind. Configure both server.allowRemote=true and server.token.',
      'SERVER_REMOTE_TOKEN_REQUIRED',
      ExitCode.invalidConfig
    );
  }
}

async function ensureWritable(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await access(directory, constants.W_OK);
    const probe = `${directory}/.jojo-write-probe-${process.pid}-${crypto.randomUUID()}`;
    const handle = await open(probe, 'wx', 0o600);
    await handle.close();
    await unlink(probe);
  } catch (error) {
    throw new JojoCliError(
      `Directory is not writable: ${directory}: ${errorMessage(error)}`,
      'STORAGE_INIT_FAILED',
      ExitCode.storageFailure,
      { directory },
      { cause: error }
    );
  }
}

async function checkPort(host: string, port: number): Promise<void> {
  if (port === 0) return;
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(new JojoCliError(
      `Cannot bind ${host}:${port}: ${errorMessage(error)}`,
      'SERVER_BIND_FAILED',
      ExitCode.bindFailure,
      { host, port },
      { cause: error }
    )));
    server.listen(port, host, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

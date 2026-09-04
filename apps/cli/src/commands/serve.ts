import { stringify as stringifyYaml } from 'yaml';
import { runPreflight } from '../bootstrap/preflight.js';
import { serve } from '../bootstrap/server-bootstrap.js';
import { redactConfig } from '../config/redact.js';
import { expandPath } from '../config/paths.js';
import type { ConfigOverrides, Secret } from '../config/schema.js';
import { ExitCode, JojoCliError } from '../errors.js';
import { createLogger } from '../logging/logger.js';
import { loadCommandConfig, type ConfigOptions } from './common.js';

export type ServeOptions = ConfigOptions & {
  dataDir?: string;
  host?: string;
  port?: number;
  allowRemote?: boolean;
  token?: string;
  tokenEnv?: string;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logFormat?: 'json' | 'pretty';
  logFile?: string;
  pidFile?: string;
  shutdownTimeout?: number;
  printEffectiveConfig?: boolean;
  check?: boolean;
  quiet?: boolean;
  daemon?: boolean;
};

export async function serveCommand(options: ServeOptions, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  if (options.daemon) {
    throw new JojoCliError(
      'In-process daemon mode is not supported. Use `jojo service install` and `jojo service start`.',
      'DAEMON_MODE_UNSUPPORTED',
      ExitCode.invalidConfig
    );
  }
  if (options.token && options.tokenEnv) {
    throw new JojoCliError('Use either --token or --token-env, not both.', 'CONFIG_INVALID', ExitCode.invalidConfig);
  }
  const token: Secret | undefined = options.token
    ? { literal: options.token }
    : options.tokenEnv ? { env: options.tokenEnv } : undefined;
  const overrides: ConfigOverrides = {
    server: {
      ...(options.host ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.allowRemote !== undefined ? { allowRemote: options.allowRemote } : {}),
      ...(token ? { token } : {})
    },
    runtime: { ...(options.dataDir ? { dataDir: options.dataDir } : {}) },
    logging: {
      ...(options.logLevel ? { level: options.logLevel } : {}),
      ...(options.logFormat ? { format: options.logFormat } : {}),
      ...(options.logFile ? { file: options.logFile } : {}),
      ...(options.quiet ? { level: 'warn' as const } : {})
    },
    shutdown: { ...(options.shutdownTimeout !== undefined ? { timeoutMs: options.shutdownTimeout } : {}) }
  };
  const config = await loadCommandConfig(options, overrides);
  if (options.pidFile) config.paths.pidFile = expandPath(options.pidFile, { baseDirectory: process.cwd() });
  if (options.printEffectiveConfig) {
    output.write(stringifyYaml(redactConfig(config)));
    return;
  }
  if (options.check) {
    const checks = await runPreflight(config, { requireProviderSecret: true });
    for (const check of checks) output.write(`${check.status === 'ok' ? 'OK' : 'WARN'} ${check.name}: ${check.message}\n`);
    return;
  }
  await serve(config, createLogger(config));
}

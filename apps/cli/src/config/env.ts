import { ExitCode, JojoCliError } from '../errors.js';
import type { ConfigOverrides } from './schema.js';

type Environment = Record<string, string | undefined>;

export function parseEnvironment(environment: Environment): ConfigOverrides {
  const config: ConfigOverrides = {};
  assign(config, 'runtime', 'dataDir', environment.JOJO_DATA_DIR);
  assign(config, 'runtime', 'instanceId', environment.JOJO_INSTANCE_ID);
  assign(config, 'server', 'host', environment.JOJO_SERVER_HOST);
  assign(config, 'server', 'port', integer(environment.JOJO_SERVER_PORT, 'JOJO_SERVER_PORT'));
  assign(config, 'server', 'allowRemote', bool(environment.JOJO_SERVER_ALLOW_REMOTE, 'JOJO_SERVER_ALLOW_REMOTE'));
  if (environment.JOJO_SERVER_TOKEN !== undefined) {
    (config.server ??= {}).token = { env: 'JOJO_SERVER_TOKEN' };
  }
  assign(config, 'provider', 'defaultProviderId', environment.JOJO_PROVIDER);
  assign(config, 'provider', 'defaultModel', environment.JOJO_MODEL);
  assign(config, 'logging', 'level', environment.JOJO_LOG_LEVEL);
  assign(config, 'logging', 'format', environment.JOJO_LOG_FORMAT);
  assign(config, 'logging', 'file', environment.JOJO_LOG_FILE);
  assign(config, 'shutdown', 'timeoutMs', integer(environment.JOJO_SHUTDOWN_TIMEOUT_MS, 'JOJO_SHUTDOWN_TIMEOUT_MS'));
  return config;
}

function assign(
  config: ConfigOverrides,
  section: keyof ConfigOverrides,
  key: string,
  value: unknown
): void {
  if (value === undefined) return;
  const target = (config[section] ??= {}) as Record<string, unknown>;
  target[key] = value;
}

function integer(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/u.test(value)) throw invalidEnvironment(name, value);
  return Number(value);
}

function bool(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (/^(?:1|true|yes|on)$/iu.test(value)) return true;
  if (/^(?:0|false|no|off)$/iu.test(value)) return false;
  throw invalidEnvironment(name, value);
}

function invalidEnvironment(name: string, value: string): JojoCliError {
  return new JojoCliError(`Invalid ${name} value: ${value}`, 'CONFIG_ENV_INVALID', ExitCode.invalidConfig);
}

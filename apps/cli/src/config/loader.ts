import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ExitCode, JojoCliError, errorMessage } from '../errors.js';
import { parseEnvironment } from './env.js';
import { deepMerge } from './merge.js';
import { defaultConfigPath, expandPath } from './paths.js';
import { ConfigSchema, type ConfigOverrides, type EffectiveConfig, type JojoConfig } from './schema.js';

export type LoadConfigInput = {
  configPath?: string;
  cliOverrides?: ConfigOverrides;
  environment?: Record<string, string | undefined>;
  homeDirectory?: string;
  cwd?: string;
};

export async function loadConfig(input: LoadConfigInput = {}): Promise<EffectiveConfig> {
  const environment = input.environment ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const configuredPath = input.configPath ?? environment.JOJO_CONFIG;
  const configFile = expandPath(configuredPath ?? defaultConfigPath(input.homeDirectory), {
    ...(input.homeDirectory ? { homeDirectory: input.homeDirectory } : {}),
    baseDirectory: cwd
  });
  const fileConfig = await readConfig(configFile, configuredPath !== undefined);
  try {
    const config = ConfigSchema.parse(deepMerge<unknown>(
      ConfigSchema.parse({}),
      fileConfig,
      parseEnvironment(environment),
      input.cliOverrides ?? {}
    ));
    return normalizePaths(config, configFile, input.homeDirectory);
  } catch (error) {
    if (error instanceof JojoCliError) throw error;
    const detail = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')
      : errorMessage(error);
    throw new JojoCliError(`Invalid configuration: ${detail}`, 'CONFIG_INVALID', ExitCode.invalidConfig, undefined, {
      cause: error
    });
  }
}

async function readConfig(file: string, required: boolean): Promise<unknown> {
  try {
    const source = await readFile(file, 'utf8');
    const parsed = parseYaml(source);
    return parsed === null ? {} : parsed;
  } catch (error) {
    if (!required && isNotFound(error)) return {};
    throw new JojoCliError(
      `Cannot read config ${file}: ${errorMessage(error)}`,
      'CONFIG_READ_FAILED',
      ExitCode.invalidConfig,
      { configFile: file },
      { cause: error }
    );
  }
}

function normalizePaths(config: JojoConfig, configFile: string, homeDirectory?: string): EffectiveConfig {
  const baseDirectory = path.dirname(configFile);
  const options = { ...(homeDirectory ? { homeDirectory } : {}), baseDirectory };
  const dataDir = expandPath(config.runtime.dataDir, options);
  const runDir = expandPath(config.runtime.runDir, options);
  const logFile = config.logging.file ? expandPath(config.logging.file, options) : undefined;
  const instanceId = config.runtime.instanceId;
  return {
    ...config,
    runtime: { ...config.runtime, dataDir, runDir },
    logging: { ...config.logging, ...(logFile ? { file: logFile } : {}) },
    paths: {
      configFile,
      dataDir,
      runDir,
      logDir: logFile ? path.dirname(logFile) : expandPath('~/.jojo/logs', options),
      pidFile: path.join(runDir, `${instanceId}.pid`),
      lockFile: path.join(runDir, `${instanceId}.lock`),
      statusFile: path.join(runDir, `${instanceId}.status.json`)
    }
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

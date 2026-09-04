import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JojoCliError } from '../errors.js';
import { loadConfig } from './loader.js';
import { redactConfig, REDACTED } from './redact.js';

describe('CLI configuration', () => {
  it('merges defaults, YAML, environment and CLI in the documented order', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-config-'));
    const file = path.join(root, 'config.yml');
    await writeFile(file, `server:\n  port: 7000\nruntime:\n  dataDir: ./runtime-data\nprovider:\n  defaultModel: file-model\n`);
    const config = await loadConfig({
      configPath: file,
      homeDirectory: root,
      cwd: root,
      environment: { JOJO_SERVER_PORT: '8000', JOJO_MODEL: 'env-model' },
      cliOverrides: { server: { port: 9000 } }
    });
    expect(config.server).toMatchObject({ host: '127.0.0.1', port: 9000, allowRemote: false });
    expect(config.provider.defaultModel).toBe('env-model');
    expect(config.paths.dataDir).toBe(path.join(root, 'runtime-data'));
    expect(config.paths.runDir).toBe(path.join(root, '.jojo/run'));
  });

  it('reports invalid YAML as a stable CLI configuration error', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-config-invalid-'));
    const file = path.join(root, 'config.yml');
    await writeFile(file, 'server: [\n');
    await expect(loadConfig({ configPath: file, environment: {} })).rejects.toMatchObject({
      name: 'JojoCliError', code: 'CONFIG_READ_FAILED', exitCode: 2
    } satisfies Partial<JojoCliError>);
  });

  it('redacts server and provider secrets from effective output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-redact-'));
    const config = await loadConfig({
      homeDirectory: root,
      environment: { JOJO_SERVER_TOKEN: 'server-secret' },
      cliOverrides: {
        provider: {
          providers: {
            openai: { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: { literal: 'sk-test' } }
          }
        }
      }
    });
    const shown = redactConfig(config);
    expect((shown.server as Record<string, unknown>).token).toBe(REDACTED);
    expect(JSON.stringify(shown)).not.toContain('server-secret');
    expect(JSON.stringify(shown)).not.toContain('sk-test');
  });
});

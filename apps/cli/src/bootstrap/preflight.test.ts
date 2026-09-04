import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';
import { validateRemoteBinding } from './preflight.js';

describe('remote bind policy', () => {
  it('allows loopback without a token', async () => {
    const config = await loadConfig({ environment: {}, cliOverrides: { server: { host: '127.0.0.1' } } });
    expect(() => validateRemoteBinding(config)).not.toThrow();
  });

  it('requires both explicit remote access and a token', async () => {
    const denied = await loadConfig({ environment: {}, cliOverrides: { server: { host: '0.0.0.0' } } });
    expect(() => validateRemoteBinding(denied)).toThrow(/allowRemote=true/u);
    const missingToken = await loadConfig({ environment: {}, cliOverrides: { server: { host: '0.0.0.0', allowRemote: true } } });
    expect(() => validateRemoteBinding(missingToken)).toThrow(/server.token/u);
    const allowed = await loadConfig({
      environment: {},
      cliOverrides: { server: { host: '0.0.0.0', allowRemote: true, token: { literal: 'secret' } } }
    });
    expect(() => validateRemoteBinding(allowed)).not.toThrow();
  });

  it('warns when a secret is stored literally', async () => {
    const { runPreflight } = await import('./preflight.js');
    const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'jojo-preflight-'));
    const config = await loadConfig({
      homeDirectory,
      environment: {},
      cliOverrides: {
        server: { port: 0, token: { literal: 'server-secret' } },
        provider: {
          providers: {
            openai: { type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: { literal: 'key' } }
          }
        }
      }
    });
    const results = await runPreflight(config);
    expect(results.filter((result) => result.name === 'config.secret_literal')).toHaveLength(2);
  });
});

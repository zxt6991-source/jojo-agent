import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';
import { validateProviderSecret } from './runtime-dependencies.js';

describe('provider preflight diagnostics', () => {
  it('names the missing environment variable without exposing a secret', async () => {
    const environmentName = 'JOJO_TEST_PROVIDER_KEY_MISSING';
    delete process.env[environmentName];
    const config = await loadConfig({
      environment: {},
      cliOverrides: {
        provider: {
          defaultProviderId: 'openai',
          providers: {
            openai: {
              type: 'openai-compatible',
              baseUrl: 'https://api.openai.com/v1',
              apiKey: { env: environmentName }
            }
          }
        }
      }
    });
    expect(() => validateProviderSecret(config)).toThrow(
      `export ${environmentName}='<your-api-key>'`
    );
  });
});

it('resolves remote model limits once, caches them, and caps each headless request', async () => {
  const { vi } = await import('vitest');
  const { createRuntimeDependencies } = await import('./runtime-dependencies.js');
  const { default: pino } = await import('pino');
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
    { id: 'custom', context_length: 64_000, max_output_tokens: 4_096 }
  ] })));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const config = await loadConfig({ environment: {}, cliOverrides: { provider: { providers: { openai: { type: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: { literal: 'test-key' } } } } } });
    const dependencies = createRuntimeDependencies(config, pino({ enabled: false }));
    expect(await dependencies.providers.resolveLimits({ providerId: 'openai', model: 'custom' })).toEqual({ contextWindowTokens: 64_000, modelMaxOutputTokens: 4_096, requestMaxOutputTokens: 4_096 });
    expect((await dependencies.providers.resolveLimits({ providerId: 'openai', model: 'custom' }, { maxOutputTokens: 256 })).requestMaxOutputTokens).toBe(256);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
it('keeps a headless endpoint usable when model discovery is unavailable', async () => {
  const { vi } = await import('vitest');
  const { createRuntimeDependencies } = await import('./runtime-dependencies.js');
  const { default: pino } = await import('pino');
  const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const config = await loadConfig({ environment: {}, cliOverrides: { provider: { providers: { openai: { type: 'openai-compatible', baseUrl: 'https://example.test/v1', apiKey: { literal: 'test-key' } } } } } });
    const dependencies = createRuntimeDependencies(config, pino({ enabled: false }));
    const context = { providerId: 'openai', model: 'unknown' };
    expect((await dependencies.providers.resolveLimits(context)).contextWindowTokens).toBe(256_000);
    await dependencies.providers.resolveLimits(context);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

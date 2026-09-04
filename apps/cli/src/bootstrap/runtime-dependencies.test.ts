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

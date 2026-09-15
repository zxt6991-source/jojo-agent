import { describe, expect, it } from 'vitest';
import { RuntimeEnvironmentRegistry } from '../src/environment-registry.js';
import { ScriptedProvider } from '@desktop-agent/agent-runtime/testing';
import type { RuntimeResolutionContext } from '@desktop-agent/agent-runtime';

const context: RuntimeResolutionContext = { sessionId: 's', laneId: 'main', runId: 'o', providerId: 'p', model: 'm', executionScope: { kind: 'none' }, workingDirectory: '' };
const configured = (baseUrl = 'https://example.test/v1') => ({ id: 'p', protocol: 'openai_chat_completions' as const, baseUrl,
  models: [{ id: 'm', discovered: { contextWindowTokens: 48000, maxOutputTokens: 8192, contextSource: 'builtin' as const, maxOutputSource: 'builtin' as const }, defaultOutputTokens: 1024 }] });

describe('provider binding description', () => {
  it('rejects mismatched lane routing and preserves the bound configuration', async () => {
    const registry = new RuntimeEnvironmentRegistry();
    const provider = new ScriptedProvider([]);
    const config = configured();
    registry.bind('s', 'main', { provider, providerConfig: config, tools: { snapshot: () => [] }, permissions: { check: async () => ({ decision: 'allow' }) } });
    const binding = await registry.providers.describe!(context);
    config.baseUrl = 'https://mutated.test';
    expect(await registry.providers.describe!(context)).toEqual(binding);
    expect(await registry.providers.resolve(context)).toBe(provider);
    expect(() => registry.providers.resolve({ ...context, providerId: 'other' })).toThrow('runtime_resume_provider_unavailable');
    expect(() => registry.providers.describe!({ ...context, model: 'removed' })).toThrow('runtime_resume_provider_unavailable');
    registry.bind('s', 'main', { provider: new ScriptedProvider([]), providerConfig: configured('https://new.test'), tools: { snapshot: () => [] }, permissions: { check: async () => ({ decision: 'allow' }) } });
    expect(await registry.providers.describe!(context)).not.toEqual(binding);
  });
});

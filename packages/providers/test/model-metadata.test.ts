import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModelMetadataStale, legacyModelConfig, ModelConfigSchema, resolveEffectiveModelLimits, resolveModelForRun } from '@desktop-agent/contracts';
import { lookupBuiltinModel, mergeRefreshedModels, ModelDiscoveryRefresh, OpenAICompatibleProvider, resolveModelMetadata } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());
describe('model metadata', () => {
  it('merges each limit independently and separates capability from request policy', () => {
    const model = resolveModelMetadata({ discovered: { id: 'gpt-5-mini', contextWindowTokens: 200_000 }, override: { defaultOutputTokens: 4_096 } });
    expect(model.discovered).toMatchObject({ contextWindowTokens: 200_000, contextSource: 'provider', maxOutputTokens: 128_000, maxOutputSource: 'builtin' });
    expect(resolveEffectiveModelLimits(model)).toEqual({ contextWindowTokens: 200_000, modelMaxOutputTokens: 128_000, requestMaxOutputTokens: 4_096 });
    expect(resolveEffectiveModelLimits(model, { maxOutputTokens: 200_000 }).requestMaxOutputTokens).toBe(128_000);
  });
  it('uses user > provider > builtin > fallback and preserves actual model IDs', () => {
    const model = resolveModelMetadata({ discovered: { id: 'openai/gpt-4.1-2025-04-14', contextWindowTokens: 64_000 }, override: { contextWindowTokens: 32_000, maxOutputTokens: 4_000 } });
    expect(model.id).toBe('openai/gpt-4.1-2025-04-14');
    expect(resolveEffectiveModelLimits(model).contextWindowTokens).toBe(32_000);
    expect(lookupBuiltinModel('my-gpt-4.1-deployment')).toBeUndefined();
    expect(resolveModelMetadata({ discovered: { id: 'unknown' } }).discovered).toMatchObject({ contextWindowTokens: 256_000, maxOutputTokens: 16_384, contextSource: 'fallback', maxOutputSource: 'fallback' });
  });
  it('ignores invalid metadata and never constructs an impossible automatic budget', () => {
    for (const value of [0, -1, NaN, Infinity, 2.5, 9_999_999]) {
      const model = resolveModelMetadata({ discovered: { id: 'unknown', contextWindowTokens: value, maxOutputTokens: value } });
      expect(model.discovered.contextSource).toBe('fallback');
    }
    const small = resolveModelMetadata({ discovered: { id: 'gpt-5-mini', contextWindowTokens: 8_192, maxOutputTokens: 128_000 } });
    expect(small.discovered.maxOutputTokens).toBeLessThan(8_192);
    expect(() => resolveModelMetadata({ discovered: { id: 'unknown' }, override: { contextWindowTokens: 8_192, maxOutputTokens: 8_192 } })).toThrow();
  });
  it('refresh preserves overrides and missing models, reset reveals the latest automatic values', () => {
    const first = { ...legacyModelConfig('a'), override: { contextWindowTokens: 64_000 } };
    const refreshed = mergeRefreshedModels([first, legacyModelConfig('missing')], [{ id: 'a', contextWindowTokens: 200_000 }, { id: 'a' }, { id: 'new' }]);
    expect(refreshed).toHaveLength(3);
    expect(refreshed[0]?.override).toEqual(first.override);
    expect(refreshed[2]?.discovered.unavailable).toBe(true);
    const automatic = { ...refreshed[0]! }; delete automatic.override;
    expect(resolveEffectiveModelLimits(automatic).contextWindowTokens).toBe(200_000);
    expect(isModelMetadataStale(first)).toBe(true);
    expect(isModelMetadataStale(automatic)).toBe(false);
    expect(isModelMetadataStale(automatic, Date.now() + 86_400_001)).toBe(true);
  });
  it('switching models changes context immediately but not to a 128k request reservation', () => {
    const provider = { models: [legacyModelConfig('small', 64_000), resolveModelMetadata({ discovered: { id: 'large', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 } })] };
    expect(resolveModelForRun(provider, 'small').contextWindowTokens).toBe(64_000);
    expect(resolveModelForRun(provider, 'large')).toEqual({ contextWindowTokens: 1_000_000, modelMaxOutputTokens: 128_000, requestMaxOutputTokens: 16_384 });
    expect(() => resolveModelForRun(provider, 'absent')).toThrow();
    expect(() => resolveEffectiveModelLimits(provider.models[0]!, { maxOutputTokens: 0 })).toThrow();
    expect(ModelConfigSchema.safeParse({ ...provider.models[0], raw: { secret: 'never persist' } }).success).toBe(false);
  });
  it('normalizes extended discovery, ignores invalid values and deduplicates ids', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'a', context_length: 200_000, top_provider: { context_length: 64_000, max_completion_tokens: 4_096 }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
      { id: 'a' }, { id: 'b', context_length: '128000', max_output_tokens: -2 }, { id: '' }
    ] }))));
    const models = await new OpenAICompatibleProvider({ apiKey: 'key' }).listModels();
    expect(models).toEqual([{ id: 'a', contextWindowTokens: 64_000, maxOutputTokens: 4_096, capabilities: { toolCalls: true, structuredOutput: false, vision: true } }, { id: 'b' }]);
  });
  it('deduplicates refresh, cancels old credentials and permits retry after failure', async () => {
    const refresh = new ModelDiscoveryRefresh();
    let firstSignal: AbortSignal | undefined;
    const discover = vi.fn((signal: AbortSignal) => { firstSignal = signal; return new Promise<[]>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); });
    const first = refresh.refresh('p', 'old', discover);
    const failed = expect(first).rejects.toThrow();
    expect(refresh.refresh('p', 'old', discover)).toBe(first);
    await Promise.resolve();
    await expect(refresh.refresh('p', 'new', async () => [{ id: 'new' }])).resolves.toEqual([{ id: 'new' }]);
    await failed;
    expect(firstSignal?.aborted).toBe(true);
    await expect(refresh.refresh('p', 'new', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    await expect(refresh.refresh('p', 'new', async () => [{ id: 'retry' }])).resolves.toEqual([{ id: 'retry' }]);
  });
});

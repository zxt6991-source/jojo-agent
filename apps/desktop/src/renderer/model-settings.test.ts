import { describe, expect, it } from 'vitest';
import { legacyModelConfig, type ProviderConfig } from '@desktop-agent/contracts';
import { applyRefreshedModels } from './model-settings';

const provider = (model = 'z-ai/glm-5.3-flash'): ProviderConfig => ({
  id: 'openai', name: 'Compatible', protocol: 'openai_chat_completions', baseUrl: 'https://api.deepseek.com',
  hasApiKey: true, model, models: [{ ...legacyModelConfig(model), override: { defaultOutputTokens: 1_024 } }]
});

describe('model settings discovery', () => {
  it('replaces an old provider catalog and selects a model actually returned by the new service', () => {
    const draft = provider();
    const result = applyRefreshedModels(draft, [legacyModelConfig('deepseek-flash'), legacyModelConfig('deepseek-v4-pro')], false);
    expect(result.model).toBe('deepseek-flash');
    expect(result.models.map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(draft.models).toHaveLength(1);
  });

  it('does not transfer overrides between different endpoints with the same model id', () => {
    const result = applyRefreshedModels(provider('shared'), [legacyModelConfig('shared')], false);
    expect(result.models[0]?.override).toBeUndefined();
  });

  it('preserves unsaved overrides across repeated refreshes of the same endpoint', () => {
    const result = applyRefreshedModels(provider('deepseek-flash'), [legacyModelConfig('deepseek-flash')], true);
    expect(result.models[0]?.override).toEqual({ defaultOutputTokens: 1_024 });
    delete result.models[0]!.override;
    const reset = applyRefreshedModels({ ...provider('deepseek-flash'), ...result }, [provider('deepseek-flash').models[0]!], true);
    expect(reset.models[0]?.override).toBeUndefined();
  });

  it('repairs a previously saved missing default while retaining same-service references', () => {
    const draft = provider();
    const result = applyRefreshedModels(draft, [legacyModelConfig('deepseek-flash'), {
      ...draft.models[0]!, discovered: { ...draft.models[0]!.discovered, unavailable: true }
    }], true);
    expect(result.model).toBe('deepseek-flash');
    expect(result.models[1]?.discovered.unavailable).toBe(true);
  });

  it('retains and flags conflicting draft limits without selecting another returned model', () => {
    const draft = provider('deepseek-flash');
    draft.models[0]!.override = { defaultOutputTokens: 8_192 };
    const result = applyRefreshedModels(draft, [legacyModelConfig('other'), legacyModelConfig('deepseek-flash', 64_000, 4_096)], true);
    expect(result.model).toBe('deepseek-flash');
    expect(result.models[1]).toMatchObject({ override: { defaultOutputTokens: 8_192 }, discovered: { unavailable: true } });
  });

  it('rejects an empty discovery without changing the draft', () => {
    const draft = provider();
    const before = structuredClone(draft);
    expect(() => applyRefreshedModels(draft, [], false)).toThrow('未返回可用模型');
    expect(draft).toEqual(before);
  });
});

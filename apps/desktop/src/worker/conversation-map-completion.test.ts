import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettingsSchema, type ModelEvent, type ModelRequest } from '@desktop-agent/contracts';
import { assertConversationMapModel, completeConversationMap } from './conversation-map-completion';

function runtime() {
  const settings = structuredClone(ProviderSettingsSchema.parse({}));
  settings.providers[0]!.models[0]!.discovered.maxOutputTokens = 4096;
  return { settings, apiKeys: { openai: 'private-test-key' } };
}
function provider(events: ModelEvent[]) {
  const stream = vi.fn(async function* (_request: ModelRequest) { yield* events; });
  return { factory: vi.fn(() => ({ stream })), stream };
}
function deepseekRuntime() {
  const config = runtime();
  const selected = config.settings.providers[0]!;
  selected.baseUrl = 'https://api.deepseek.com';
  selected.protocol = 'openai_chat_completions';
  selected.model = 'deepseek-flash';
  selected.models[0]!.id = 'deepseek-flash';
  config.settings.utilityModel.model = 'deepseek-flash';
  return config;
}
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
}
afterEach(() => vi.unstubAllGlobals());
describe('conversation map configured auxiliary model', () => {
  it('allows configured aliases omitted by discovery without changing the default chat model', async () => {
    const config = runtime();
    const initial = config.settings.providers[0]!.models[0]!;
    config.settings.providers[0]!.models.push({ ...initial, id: 'deepseek-flash', discovered: { ...initial.discovered, unavailable: true } });
    config.settings.utilityModel.model = 'deepseek-flash';
    expect(() => assertConversationMapModel(config)).not.toThrow();
    const f = provider([{ type: 'text_delta', text: '{"events":[]}' }]);
    await completeConversationMap(config, 'prompt', new AbortController().signal, 8192, f.factory);
    expect(f.stream.mock.calls[0]![0].model).toBe('deepseek-flash');
    expect(config.settings.providers[0]!.model).toBe('gpt-5-mini');
  });
  it('fails before constructing the provider if configuration or credentials are missing', async () => {
    const f = provider([]);
    await expect(completeConversationMap(null, 'private history', new AbortController().signal, 8192, f.factory)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    const config = runtime(); config.apiKeys.openai = ' ';
    await expect(completeConversationMap(config, 'private history', new AbortController().signal, 8192, f.factory)).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('uses the explicitly configured utility model with no tools and bounded output', async () => {
    const config = runtime();
    const f = provider([{ type: 'text_delta', text: ' {"events":[]} ' }]);
    expect(await completeConversationMap(config, 'test prompt', new AbortController().signal, 8192, f.factory)).toBe('{"events":[]}');
    expect(f.stream).toHaveBeenCalledWith(expect.objectContaining({ model: config.settings.utilityModel.model, tools: [], reasoning: 'disabled', responseFormat: 'json_object', maxOutputTokens: 4096 }));
    expect(f.stream.mock.calls[0]![0].instructions?.join(' ')).toContain('untrusted');
  });
  it('preserves a safe failure category from streamed failures and never exposes raw content', async () => {
    const f = provider([{ type: 'response_failed', code: 'authentication', message: 'private-key and private history' }]);
    await expect(completeConversationMap(runtime(), 'private history', new AbortController().signal, 8192, f.factory)).rejects.toMatchObject({ code: 'MODEL_AUTHENTICATION', message: '分析模型身份验证失败，请检查 API Key 和服务地址后重试。' });
  });
  it('reports an empty model result separately and never silently switches providers', async () => {
    const f = provider([]);
    await expect(completeConversationMap(runtime(), 'prompt', new AbortController().signal, 8192, f.factory)).rejects.toMatchObject({ code: 'MODEL_EMPTY_RESPONSE' });
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it.each(['length', 'max_tokens'])('reports %s as an output limit, even without final text', async stopReason => {
    const f = provider([{ type: 'usage', outputTokens: 4096 }, { type: 'response_completed', stopReason }]);
    await expect(completeConversationMap(runtime(), 'prompt', new AbortController().signal, 8192, f.factory))
      .rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' });
  });
  it('does not accept truncated output even when it happens to be valid JSON', async () => {
    const f = provider([{ type: 'text_delta', text: '{"events":[]}' }, { type: 'response_completed', stopReason: 'length' }]);
    await expect(completeConversationMap(runtime(), 'prompt', new AbortController().signal, 8192, f.factory))
      .rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' });
  });
  it('recognizes a real DeepSeek reasoning-only stream ending at the token limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sse([
      { choices: [{ delta: { reasoning_content: 'private reasoning', content: null } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }], usage: { completion_tokens: 4096 } }
    ])));
    await expect(completeConversationMap(deepseekRuntime(), 'prompt', new AbortController().signal, 8192))
      .rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' });
  });
  it('sends analysis through the real DeepSeek adapter with thinking disabled and preserves settings', async () => {
    const config = deepseekRuntime();
    const originalSettings = structuredClone(config.settings);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.thinking?.type === 'disabled'
        ? sse([{ choices: [{ delta: { content: '{"events":[]}' }, finish_reason: 'stop' }] }])
        : sse([{ choices: [{ delta: { reasoning_content: 'reasoning only' }, finish_reason: 'length' }] }]);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(completeConversationMap(config, 'prompt', new AbortController().signal, 16384)).resolves.toBe('{"events":[]}');
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, max_tokens: 4096, tools: [] });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(config.settings).toEqual(originalSettings);
  });
});

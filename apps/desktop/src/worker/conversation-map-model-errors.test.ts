import { describe, expect, it } from 'vitest';
import { conversationMapModelError } from './conversation-map-model-errors';

describe('safe conversation map model failures', () => {
  it.each([
    ['authentication', 'MODEL_AUTHENTICATION', '身份验证失败'],
    ['rate_limit', 'MODEL_RATE_LIMIT', '额度'],
    ['provider_unavailable', 'MODEL_UNAVAILABLE', '服务暂时不可用'],
    ['network', 'MODEL_NETWORK', '检查网络'],
    ['timeout', 'MODEL_TIMEOUT', '响应超时'],
    ['provider_timeout', 'MODEL_TIMEOUT', '响应超时'],
    ['context_overflow', 'MODEL_CONTEXT_OVERFLOW', '上下文限制'],
    ['empty_response', 'MODEL_EMPTY_RESPONSE', '未返回有效内容'],
    ['output_limit', 'MODEL_OUTPUT_LIMIT', '达到输出上限'],
    ['provider_stream_incomplete', 'MODEL_STREAM_INCOMPLETE', '响应中断'],
    ['provider_request', 'MODEL_REQUEST_FAILED', '未被模型服务接受'],
    ['model_tools_unsupported', 'MODEL_TOOLS_UNSUPPORTED', '不支持']
  ])('classifies %s without exposing raw provider diagnostics', (providerCode, code, message) => {
    const error = Object.assign(new Error('secret API key: sk-private; private history'), {
      code: providerCode,
      cause: new Error('https://private.invalid?token=private-token'),
      response: { body: 'private request and response body' }
    });
    const result = conversationMapModelError(error);
    expect(result.code).toBe(code);
    expect(result.message).toContain(message);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|sk-/u);
  });

  it.each([
    undefined, null, 'secret API key', 401,
    new Error('authentication failed: secret API key'),
    { code: 'secret-code', message: 'secret diagnostic' },
    { code: '__proto__' },
    { code: 'constructor' },
    { code: { toString: (): string => 'authentication' } }
  ])('keeps unknown failures generic and does not infer codes from messages', error => {
    expect(conversationMapModelError(error)).toEqual({
      code: 'MODEL_FAILED', message: '分析模型不可用，请检查模型配置后重试。'
    });
  });

  it('never reads provider error messages', () => {
    const error = { code: 'authentication', get message(): string { throw new Error('must not read message'); } };
    expect(conversationMapModelError(error).code).toBe('MODEL_AUTHENTICATION');
  });

  it('gives timeout and context failures actionable guidance instead of claiming invalid credentials', () => {
    for (const code of ['timeout', 'provider_timeout', 'context_overflow']) {
      const failure = conversationMapModelError({ code });
      expect(failure.message).toContain('缩小分析时间范围');
      expect(failure.message).not.toContain('API Key');
    }
  });
});

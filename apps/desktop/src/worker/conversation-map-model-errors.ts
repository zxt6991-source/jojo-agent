/** Only known provider codes cross the analysis boundary; raw diagnostics may contain credentials or history. */
export function conversationMapModelError(error: unknown): { code: string; message: string } {
  const providerCode = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  switch (providerCode) {
    case 'authentication':
      return { code: 'MODEL_AUTHENTICATION', message: '分析模型身份验证失败，请检查 API Key 和服务地址后重试。' };
    case 'rate_limit':
      return { code: 'MODEL_RATE_LIMIT', message: '分析模型请求过于频繁或额度不足，请稍后重试或检查服务额度。' };
    case 'provider_unavailable':
      return { code: 'MODEL_UNAVAILABLE', message: '分析模型服务暂时不可用，请稍后重试或切换模型。' };
    case 'network':
      return { code: 'MODEL_NETWORK', message: '无法连接分析模型，请检查网络和服务地址后重试。' };
    case 'timeout':
    case 'provider_timeout':
      return { code: 'MODEL_TIMEOUT', message: '分析模型响应超时，请稍后重试或缩小分析时间范围。' };
    case 'context_overflow':
      return { code: 'MODEL_CONTEXT_OVERFLOW', message: '分析内容超出模型上下文限制，请缩小分析时间范围或切换模型。' };
    case 'empty_response':
      return { code: 'MODEL_EMPTY_RESPONSE', message: '分析模型未返回有效内容，请重试或切换模型。' };
    case 'output_limit':
      return { code: 'MODEL_OUTPUT_LIMIT', message: '分析模型已达到输出上限，未能完成分析。请提高模型最大输出上限或切换模型后重试。' };
    case 'provider_stream_incomplete':
      return { code: 'MODEL_STREAM_INCOMPLETE', message: '分析模型响应中断，请重试或切换模型。' };
    case 'provider_request':
      return { code: 'MODEL_REQUEST_FAILED', message: '分析请求未被模型服务接受，请检查模型配置后重试。' };
    case 'model_tools_unsupported':
      return { code: 'MODEL_TOOLS_UNSUPPORTED', message: '当前分析模型不支持所需的请求能力，请切换模型后重试。' };
    default:
      return { code: 'MODEL_FAILED', message: '分析模型不可用，请检查模型配置后重试。' };
  }
}

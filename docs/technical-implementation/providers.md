# Providers 技术实现方案

路径：`packages/providers`  
包名：`@desktop-agent/providers`

## 1. 定位与边界

Providers 把内部统一的 `ModelRequest` 转换为具体模型服务请求，并把厂商响应还原为 `ModelEvent`。当前只实现 OpenAI Chat Completions 兼容协议，不负责 Agent 循环、重试决策、密钥存储或 UI。

公开入口 `src/index.ts` 只导出 `OpenAICompatibleProvider` 和 `OpenAIProviderOptions`，协议细节按职责拆分：

| 文件 | 职责 |
|---|---|
| `openai-compatible-provider.ts` | HTTP 请求、认证、超时、取消与错误分类 |
| `chat-completions-request.ts` | 内部消息和工具定义到 Chat Completions 请求体的纯转换 |
| `sse.ts` | 从字节流增量解码标准 SSE `data` 事件 |
| `chat-completions-stream.ts` | 解析 Chat Completions JSON 增量并聚合 Tool Call |
| `types.ts` | Provider 配置和包内协议状态类型 |

这样的边界让请求转换和流解析可以脱离网络独立测试，同时保持包的公共 API 简洁。

## 2. 请求转换

`OpenAICompatibleProvider` 向 `{baseUrl}/chat/completions` 发送：

- Bearer API Key；
- `model`、`stream: true`；
- `stream_options.include_usage: true`；
- 转换后的 `messages`；
- Function Calling 格式的 `tools`。

内部消息转换规则：

- 每次请求前插入固定 System Message；
- User/Assistant 的文本块拼接成 `content`；
- Assistant 的 Tool Call 转为 `tool_calls`；
- Tool Result 按 `tool_call_id` 转为独立 Tool Message。

## 3. SSE 流解析

`readSseData` 使用 Fetch API 的 Response Body reader 和流式 `TextDecoder` 解码字节。它以空行作为 SSE 事件边界，支持同一事件的多个 `data:` 行，并保留跨网络 chunk 的残片；响应结束时也会提交没有尾换行的最后一个事件。注释和其他 SSE 字段会被忽略。

`parseChatCompletionStream` 对每个 `data` JSON：

- `delta.content` 产生 `text_delta`；
- `delta.tool_calls` 按 index 聚合 ID、函数名和参数字符串；
- `usage` 产生 token 用量事件；
- `finish_reason` 更新停止原因。

流结束后按 Tool Call index 排序，统一解析每个 Tool Call 的 JSON 参数并产生 `tool_call_completed`，最后产生 `response_completed`。参数 JSON 无效时保存在 `{ _invalidJson }` 中，由后续工具 Schema 拒绝，而不是让解析器崩溃。无法解析的 JSON 事件和结构不完整的增量被忽略。

## 4. 取消、超时与错误分类

Provider 创建内部 `AbortController`，同时监听调用方 AbortSignal 和默认 90 秒超时。计时覆盖建立连接、读取错误正文和消费完整响应流：

- 调用方取消：抛出 `AbortError`，由 Agent Core 归一为取消；
- 内部超时：产生 `response_failed(timeout)`；
- 建连或读取响应流失败：`network`；
- 401/403：`authentication`；
- 429：`rate_limit`；
- 5xx：`provider_unavailable`；
- 其他非成功 HTTP：`provider_request`；
- 无响应体：`empty_response`。

错误响应正文最多截取 1,000 个字符，避免把过大上游响应带入 UI。

## 5. 兼容性约束

“OpenAI 兼容”服务必须同时支持流式 Chat Completions、Function Tools、分片 Tool Call 和 usage 选项。当前解析器忽略无法解析的 SSE 行和没有首个 choice 的数据，因此能容忍心跳或非业务事件，但也可能隐藏不兼容响应；联调时应记录经过脱敏的协议诊断信息。

本包不得记录 Authorization Header、API Key 或完整敏感消息。若增加日志，必须默认关闭正文并支持字段脱敏。

## 6. 测试

`packages/providers/test/providers.test.ts` 直接覆盖协议适配，不依赖真实 API：

- User/Assistant/Tool 消息及工具定义的请求序列化；
- 跨 chunk 文本、usage、finish reason 和无尾换行事件；
- 多 Tool Call 按 index 聚合、分片函数名/参数及非法 JSON；
- Base URL 归一化和认证请求头；
- 401/403、429、5xx 和其他 HTTP 状态分类；
- 内部超时和调用方预取消。

后续仍应补充响应流中途失败、调用方在流式传输期间取消，以及真实本地 mock HTTP server 的集成测试。

## 7. 演进方案

- 对兼容服务差异引入显式 capability/config，而不是散布条件判断。
- 在上层注入重试策略，只对限流、暂时性 5xx 和连接失败做有界重试。
- 新增 Responses 或其他厂商协议时实现新的 `ModelProvider`，不修改 Agent Core。

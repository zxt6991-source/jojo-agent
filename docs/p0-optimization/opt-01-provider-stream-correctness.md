# OPT-01：Provider 流响应正确性与有界重试

> 日期：2026-09-10 · 基线：`e544bae` · 优先级：P0  
> 状态：详细设计，尚未实施。文中的新增类型、文件和选项均为建议。  
> 上级文档：[P0 实施索引](README.md) · [后续优化总方案](../jojo_next_optimization_plan.md)

## 1. 问题与交付目标

当前 [parseChatCompletionStream](../../packages/providers/src/chat-completions-stream.ts) 默认 `stopReason = 'stop'`，跳过解析失败或不认识的数据，读流结束后无条件生成 `response_completed`。[runModelStep](../../packages/agent/src/model-step.ts) 只检查是否接收到事件，未要求存在有效完成事件。

2026-09-09 的最小复现已经确认以下行为；`e544bae` 相比当时基线仅新增规划文档，相关实现未变化。

| 输入 | 当前结果 | 目标结果 |
|---|---|---|
| 空 body 流 | `response_completed(stop)` | `empty_response` |
| 一个 text delta 后直接 EOF，无 finish reason | 部分文字 + 完成 | `provider_stream_incomplete`，不提交成功回答 |
| `data: {"error":{"message":"upstream error"}}` 后结束 | 完成 | `provider_stream_error` |
| tool arguments 被截断后 EOF | 可能组装工具并完成 | 不发布完整工具调用，不执行工具 |

本期首先保证传输和模型步骤的完成判定正确。带明确合法 finish reason 的空内容响应，与“空流”不同：第一版保留其协议完成语义，避免破坏现有 scripted provider 和兼容测试；是否满足用户任务属于更上层的结果质量判断。

不在本期实现跨进程模型流续传、部分文字后的自动重试、供应商自动切换或新的模型协议。

## 2. 不变量与职责

1. 一次公开 `ModelProvider.stream()` 至多产生一个 `response_completed` 或 `response_failed`；调用者取消时沿用抛出 `AbortError` 的约定。
2. 没有协议认可的结束事实，不允许通过 EOF 推导成功。
3. 工具调用只有在本次响应完整性确认后才能发布为 `tool_call_completed`；工具参数的业务 Schema 校验仍由既有工具层承担。
4. `runModelStep` 在完整响应返回前只收集调用，不执行调用。失败时不会返回可执行的半组工具。
5. 公开增量事件一旦发布，第一版不再自动重试该次请求；重试不覆盖或拼接新的回答。
6. Provider 不负责重放 Runtime 的历史工具。后续模型步骤失败，也不能从用户输入重跑整个 Run。

| 位置 | 责任 |
|---|---|
| SSE reader | 正确分帧、取消 reader、报告读取异常；不判断业务完成 |
| Chat Completions parser | JSON / envelope 校验、终止信号、工具组装与完整性 |
| OpenAICompatibleProvider | HTTP 状态、超时、attempt 重试、将内部错误转为一个公开失败事件 |
| runModelStep | 再次验证通用 ModelEvent 序列，保护第三方 Provider 接入 |
| Runtime / Agent loop | 将失败持久化并停止此次模型步骤之后的工具执行 |

## 3. Parser 状态与结束策略

### 3.1 内部状态

以下是建议的内部结构，不加入跨进程协议：

```ts
type StreamProgress = {
  sawChoice: boolean;
  sawContent: boolean; // 非空文字或工具增量，usage/心跳不算
  finishReason?: string;
  sawDone: boolean;
  failed: boolean;
  calls: Map<number, PendingToolCall>;
};

type CompletionPolicy = {
  // 默认必须有 finish_reason；只有通过专门测试的兼容配置才允许 done_only。
  mode: 'finish_reason' | 'done_only';
  allowedFinishReasons: readonly string[];
};

class ProviderStreamError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
```

不允许模型输出设置 `CompletionPolicy`。第一版使用代码内默认策略；新增供应商例外必须有对应协议样本和测试，不能退回“任意 EOF 均成功”。

### 3.2 处理顺序

1. SSE 注释与空 keepalive 不进入 JSON 解析；未知 `event:` 字段按 reader 既有分帧约定处理。
2. 对 `[DONE]` 执行终止校验并结束 reader，不能继续无限等待连接关闭。
3. 非空 `data:` 必须为合法 JSON object；损坏 JSON 立即抛出 `provider_protocol_error`，不吞掉后继续执行。
4. 优先检查错误 envelope，再处理 usage 和 choice。错误详情做长度限制，不包含完整请求或认证 Header。
5. 本实现仍只处理一个 completion choice；在请求侧保持单 choice 约束，不在本次优化中扩展多候选执行。
6. 先合并当前 chunk 的 text / tool delta，再记录同一个 chunk 的 finish reason。
7. finish reason 到达后只允许 usage、空 choice 和明确的附加元数据；再次收到内容增量或冲突 finish reason 判为协议错误。
8. 满足终止策略后，按 index 排序发布完整工具调用，最后发布一次 `response_completed`。

### 3.3 判定表

| 情况 | 默认行为 |
|---|---|
| `finish_reason=stop`，随后 `[DONE]` 或 EOF | 成功，保留 `stop` |
| `finish_reason=tool_calls`，工具 delta 组装完成 | 成功，发布工具，再发布完成 |
| `finish_reason=length` 且没有工具调用 | 成功结束本次模型请求并保留 `length`，由现有循环处理有限续写 |
| `length` 且存在工具调用 | 失败，不执行可能不完整的工具批次 |
| `content_filter` | 明确失败并给出可解释原因，不发布工具调用 |
| 未识别 finish reason | 失败；待供应商适配明确后再扩展映射 |
| 只有 usage / 空 choice / 心跳 | `empty_response` |
| 有内容但没有 finish reason，直接 EOF | `provider_stream_incomplete` |
| 只有 `[DONE]`，无 finish reason | 默认失败；受信任 `done_only` 策略须额外检查已有有效响应 |
| finish reason 后收到错误 envelope | 在完成事件发布前判为失败 |
| 合法 finish-only 响应，无正文和工具 | 协议完成；不与完全空流混淆 |

已完整结束的工具响应中，参数 JSON 不合法可以保留现有 `_invalidJson` 路径，让工具输入校验产生确定性错误。没有传输完成事实时不能用该路径把截断误当作正常工具参数错误。工具 ID / name 缺失、ID 冲突或无法确定同一调用身份属于协议错误。

### 3.4 完成后的 usage 尾部

finish reason 已足够证明内容结束，但 usage 可能在后续 chunk 中到达。建议增加短时尾部读取窗口：遇到 `[DONE]` / EOF 即结束；达到尾部窗口上限时取消 reader，使用已确认的 finish reason 完成，未收到的 usage 标为未知。

建议初始尾部窗口为 2 秒，作为可调适配器参数并用假时钟测试，不视为性能承诺。尾部 reader 取消与用户取消必须区分；用户取消和请求总期限优先于正常尾部收尾。显式错误 envelope 或损坏数据仍判失败，不能被尾部容错掩盖。有效 finish reason 之后仅 transport 断连可按完成收尾。

## 4. 错误如何穿过 Provider 边界

建议新增 `packages/providers/src/provider-errors.ts`。Parser 抛内部结构化错误；Adapter 统一处理并只产生一个 `response_failed`。避免 parser 先发布失败、adapter 又把同一错误包装成 `network` 再发布一次。

保留 [ModelEvent](../../packages/contracts/src/model.ts) 现有联合类型；其 `code` 已为 string，本期不需要新增跨进程事件类别。

| 错误码 | 触发 | 是否自动重试 |
|---|---|---|
| `empty_response` | 没有有效响应的空流 | 否，先暴露协议问题 |
| `provider_stream_incomplete` | 内容没有合法结束事实 | 否 |
| `provider_protocol_error` | JSON / 身份 / 事件顺序错误 | 否 |
| `provider_stream_error` | SSE 中明确的服务端错误 | 第一版否，HTTP 错误另行分类 |
| `provider_content_filtered` | 明确的过滤结束原因 | 否 |
| `authentication` / `provider_request` / `model_tools_unsupported` | 既有 HTTP 分类 | 否 |
| `rate_limit` / `provider_unavailable` | 429 或选定的 5xx | 满足第 6 节条件时允许 |
| `network` | 完成前网络失败 | 未发布公开事件且属于允许的瞬时错误时允许 |
| `timeout` | 任一请求期限到达 | 第一版不自动重试；诊断记录具体超时阶段 |

错误码需在 Runtime 持久化、Desktop 错误展示、HTTP Run 查询中保留，不被统一改写成 `runtime_internal`。不要把未经限制的服务端错误正文直接写入日志。

## 5. runModelStep 的二次校验

第三方 Provider 可能不经过上述 parser，因此通用层仍需检查事件序列。

```ts
// 伪代码：示意验证，不是可直接粘贴的完整实现。
let completed = false;
let receivedEvent = false;
for await (const event of provider.stream(request)) {
  throwIfAborted(signal);
  receivedEvent = true;
  if (event.type === 'response_failed') throw asAgentError(event);
  if (completed && event.type !== 'usage') throw invalidEventSequence();
  if (event.type === 'response_completed') {
    completed = true;
    stopReason = event.stopReason;
  } else {
    collectOrEmit(event); // 只收集调用，不执行
  }
}
throwIfAborted(signal);
if (!receivedEvent) throw emptyResponse();
if (!completed) throw incompleteResponse();
return { text, calls, stopReason };
```

正常 EOF 后必须再次检查取消状态，防止调用者取消与最后一个 chunk 同时到达却返回成功。第二个完成事件、完成后文字 / 工具、完成后失败都不能返回成功结果；为通用 Provider 保留完成后 usage 的兼容路径。

`runModelStep` 抛出后，[Runtime runner](../../packages/agent-runtime/src/harness/runner.ts) 使用现有失败路径，不进入该响应的 assistant durable message 与 tool planning。验证 [普通 Agent loop](../../packages/agent/src/run-agent-turn.ts) 也遵循同样顺序。

本期不新建部分响应持久化协议。当前 Desktop 在失败后会重新加载会话，流式文字可能消失；错误提示明确为“响应中断，本次输出未作为完成结果保存”。不得宣称本期支持重新打开失败任务后查看全部部分输出。该能力如需要，另行设计带 attempt 标识的失败草稿记录。

## 6. 超时与重试实现

### 6.1 选项与兼容

建议扩展 [OpenAIProviderOptions](../../packages/providers/src/types.ts)，以下均为内部 TypeScript 配置；P0 不增加 Settings 页面配置。

```ts
type RequestPolicy = {
  totalTimeoutMs: number;
  responseHeadersTimeoutMs: number;
  firstContentTimeoutMs: number;
  idleTimeoutMs: number;
  finishDrainTimeoutMs: number;
  maxAttempts: number; // 包含第一次请求及文本兼容降级请求
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
};
```

保留 `timeoutMs`：旧调用的该值映射为总期限；未指定时仍保留当前 90 秒默认值，避免本次修复悄悄放大任务耗时。细分期限都被剩余总期限截断。初始建议 headers 30 秒、first content 60 秒、idle 30 秒、finish drain 2 秒；低于这些值的旧 `timeoutMs` 仍然有效。后续提高总期限需单独配置与验证。

fetch 的 headers 期限覆盖 DNS / 连接 / 等待响应头，不把它误称为能单独测量 TCP 建连的精确计时。first content 期限从响应头到达起计算；有效 text / tool delta 才完成该阶段，role-only、usage 和心跳不能无限续期。idle 期限由有效内容进度刷新，总期限始终不刷新。finish reason 到达后切换尾部读取状态。

用一个请求总 controller 和每个 attempt 的子 controller 分离生命周期。超时原因由内部判别值标记，避免把请求超时误映射成用户取消；所有退出路径释放 timer、listener、response body 和 reader。

### 6.2 重试策略

第一版最大 3 次 HTTP 尝试，基础等待 500 ms、上限 5 秒并加入 jitter；这些是建议默认值，不是既有配置。只对 429、500、502、503、504 以及可识别的瞬时网络断连开放重试。认证、普通 4xx、证书错误、协议错误和任何公开事件发布后的错误不重试。

`Retry-After` 支持秒数与合法日期，取服务端最短等待要求与本地退避的较大值；若超过剩余总期限，直接失败，不能把它截短后提前请求。随机数、时钟和等待函数可注入以获得确定性测试。

当前 rich request 被特定 400 拒绝后转为 text-only 的逻辑保留，但每个逻辑请求最多降级一次，所有 HTTP 尝试共用 `maxAttempts` 和同一总期限。先单独提交完成判定修复，再启用重试，避免问题被重试掩盖。

`listModels` 保留独立的发现请求行为，本期不扩大到 Embedding 重试；如抽取公共等待工具，也不得改变这些路径的默认策略。

### 6.3 防止重复与计量失真

- Adapter 在向外 yield 任意 ModelEvent 前设置 `published = true`，usage 也算；纯内部 keepalive 不算。
- 中间可重试失败不发布 `response_failed`；只有耗尽或不可重试时发布最终失败。
- 开始下一次尝试前，取消上次读取并重建 parser 状态，不能沿用 tool map 或已拼接文字。
- 记录 attempt 次数及等待时长，但不把重试的中间错误写成多个 Run 终态。
- 网络失败后供应商可能已经消耗 Token；没有 usage 的 attempt 计量未知，不能承诺零费用或供应商端 exactly-once。
- 即使之前模型步骤已有工具执行，本步骤重试也只能重发本次固定上下文，不能重新执行历史工具。

## 7. 文件级改动清单

| 文件 | 改动 |
|---|---|
| [chat-completions-stream.ts](../../packages/providers/src/chat-completions-stream.ts) | 终止状态机、error envelope、错误分类、工具延迟提交 |
| [sse.ts](../../packages/providers/src/sse.ts) | 保留分帧语义，提供可取消的尾部收尾；增加事件大小边界时单独定义预算 |
| `packages/providers/src/provider-errors.ts`（拟新增） | 内部错误类型、HTTP 可重试分类 |
| `packages/providers/src/request-policy.ts`（拟新增） | 期限、退避、可取消等待、尝试次数 |
| [openai-compatible-provider.ts](../../packages/providers/src/openai-compatible-provider.ts) | attempt 执行、一次性失败出口、兼容降级预算 |
| [types.ts](../../packages/providers/src/types.ts) | 可选 request policy 与旧 timeoutMs 映射 |
| [model-step.ts](../../packages/agent/src/model-step.ts) | 通用完成事件验证、结束前取消检查 |
| [Renderer main.tsx](../../apps/desktop/src/renderer/main.tsx) | 如需补错误文案，保持现有事件形状，说明未保存部分输出 |

严格 Schema 的 IPC / REST 不需要因本期内部错误类而增加新事件。若实现中发现必须新增诊断字段，单独检查 Contracts、Preload、Worker 与 SDK 兼容，不能直接向现有严格 Schema 塞字段。

## 8. 测试矩阵

| 编号 | 场景 | 必须断言 |
|---|---|---|
| S01 | 空流、只有 usage、只有心跳 | 失败，无完成事件 |
| S02 | text delta 后无终止 EOF | 失败；工具执行次数为 0 |
| S03 | tool arguments 只到一半 | 无 tool_call_completed，无副作用 |
| S04 | SSE error、损坏 JSON | 保留分类，不被改写成 network |
| S05 | CRLF、跨 UTF-8 chunk、多行 data、尾部无换行 | 分帧行为正确 |
| S06 | 合法 stop / tool_calls / length | 原终止语义与续写兼容 |
| S07 | 完成后 usage / 内容 / 第二次完成 | usage 兼容，其余违反约定时报错 |
| S08 | 缺 ID、重复 ID、完整但无效参数 JSON | 协议错误与既有参数校验路径可区分 |
| S09 | done-only 与默认策略 | 只有显式兼容策略可接受且不能接受空流 |
| T01 | headers、首内容、idle、total 各自超时 | 阶段正确、timer 与 reader 释放 |
| T02 | 持续心跳但无内容 | 不能逃过首内容或总期限 |
| T03 | 合法 finish 后连接不关闭 | 有界尾部收尾，usage 缺失为未知 |
| R01 | 429 后成功、503 持续失败 | HTTP 次数、退避、最终失败次数准确 |
| R02 | 首 delta 后断流 | 只有一次尝试，不拼接第二份回答 |
| R03 | Retry-After 超过剩余预算 | 不提前重试 |
| R04 | rich 降级后再遇到 429 | 单次降级、总尝试次数与期限不重置 |
| C01 | 等待重试、最后 chunk 或尾部收尾时取消 | AbortError，无晚到完成事件 |
| I01 | 自定义 Provider 只发 delta 然后结束 | runModelStep 拒绝，不依赖特定 parser |
| I02 | 先前工具已完成、下一模型请求失败或重试 | 前一工具只执行一次，当前 Run 终态正确 |

优先扩展 [providers.test.ts](../../packages/providers/test/providers.test.ts)，并新增 `packages/agent/test/model-step.test.ts` 聚焦通用事件约束。现有“无效参数 JSON”与“finish-only 响应”用例应保留，避免不相关的语义回归。

实施时执行针对性测试，再运行 `pnpm typecheck`、`pnpm lint` 和全量 `pnpm test`。至少一个 Runtime 集成测试检查持久 Run 错误码、后续工具零执行和 Lane 最终可用。若改了用户错误展示，再补真实 Electron scripted-provider 场景。

## 9. PR 顺序与完成定义

1. **PR-01A：完成判定。** 新增失败样本，修改 parser 与 model-step；先不启用新重试。
2. **PR-01B：期限与资源释放。** 细分期限和尾部窗口，保留 timeoutMs 兼容，假时钟覆盖竞争条件。
3. **PR-01C：有界重试。** 共享 attempt 预算、rich 降级限制、计量与取消测试。

完成条件：所有异常样本均不会误报成功，所有合法基线样本保持兼容，失败步骤不会执行工具，重试不会重放历史效果，事件与持久 Run 终态一致。

上线后首先观察流不完整错误、协议错误、attempt 次数和请求耗时。允许关闭新增重试或调整期限；不能回退到无条件 EOF 成功。本文只输出实施方案，不表示上述测试和修复已经完成。

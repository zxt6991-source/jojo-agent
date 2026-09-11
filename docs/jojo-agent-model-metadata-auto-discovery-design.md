# Jojo Agent 模型能力自动发现与 Token 预算管理技术方案

> 适用项目：`zxt6991-source/jojo-agent`  
> 基于分支：`main`  
> 方案版本：v1.0  
> 目标配置版本：Desktop `config.json` Schema v4  
> 日期：2026-09-11

---

## 1. 背景

Jojo Agent 当前已经实现模型上下文预算管理，并且以下两个参数已经进入真实运行链路：

- `contextWindowTokens`
- `maxOutputTokens`

当前实现中：

- `ProviderConfig` 保存 `contextWindowTokens` 和 `maxOutputTokens`；
- Renderer「设置 → 模型」允许用户手动填写；
- Worker 将它们传给 Runtime / Agent Core；
- `prepareModelContext()` 使用它们决定何时压缩上下文；
- Provider 将 `maxOutputTokens` 转换为 `max_completion_tokens`；
- DeepSeek 兼容逻辑会将其转换为 `max_tokens`；
- 模型因输出长度达到上限返回 `length` / `max_tokens` 时，Agent Core 支持最多两次自动续写。

相关现有文件：

```text
packages/contracts/src/persistence.ts
packages/contracts/src/model.ts
packages/contracts/src/desktop.ts

packages/agent/src/context-manager.ts
packages/agent/src/model-step.ts
packages/agent/src/run-agent-turn.ts

packages/providers/src/chat-completions-request.ts
packages/providers/src/openai-compatible-provider.ts
packages/providers/src/registry.ts

apps/desktop/src/renderer/main.tsx
apps/desktop/src/worker/worker.ts

packages/storage/src/index.ts
docs/technical-implementation/context-management.md
docs/phase-2-multi-provider-context.md
```

当前默认值为：

```text
contextWindowTokens = 128000
maxOutputTokens     = 8192
```

Context Manager 当前核心预算公式为：

```text
targetTokens =
    max(
        1024,
        floor(contextWindowTokens × 0.82)
        - maxOutputTokens
    )
```

因此这两个参数不是 UI 装饰，而是 Jojo 长会话、Tool Calling、MCP、Skill 和历史压缩机制的核心输入。

---

# 2. 当前问题

## 2.1 Token 限制错误地挂在 Provider 级

当前结构：

```ts
type ProviderConfig = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;

  model: string;
  models: string[];

  contextWindowTokens: number;
  maxOutputTokens: number;

  hasApiKey: boolean;
};
```

一个 Provider 可以包含多个模型：

```text
Provider
 ├─ model-a
 ├─ model-b
 ├─ model-c
 └─ model-d
```

但当前只保存一组：

```text
contextWindowTokens
maxOutputTokens
```

这意味着：

```text
切换模型
   ↓
Model ID 发生变化
   ↓
Context Window / Max Output 不发生变化
```

这是模型能力边界上的结构性错误。

例如同一个 OpenAI-compatible Provider 下可能同时存在：

```text
Model A -> 64K context
Model B -> 128K context
Model C -> 1M context
```

当前 Jojo 无法准确区分。

---

## 2.2 配置过大会导致请求被 Provider 拒绝

假设真实模型：

```text
context = 64K
```

但 Jojo 配置：

```text
contextWindowTokens = 128K
```

Context Manager 会认为还有容量，因此不会及时 compact：

```text
历史越来越大
    ↓
Jojo 判断仍然可发送
    ↓
Provider 实际窗口已经超限
    ↓
context_length_exceeded / 400
```

---

## 2.3 配置过小会导致过早压缩

反过来：

```text
模型真实窗口 = 1M
Jojo 配置     = 128K
```

Jojo 会在远未达到真实模型窗口前进行：

```text
Tool Result reclaim
History Compaction
Summary
```

这可能导致：

- 更早丢失代码上下文；
- 更早丢失历史 Tool Result；
- 摘要模型增加额外成本；
- 摘要错误或遗漏的概率上升；
- Coding Agent 长任务性能下降。

---

## 2.4 `maxOutputTokens` 当前混合了两个不同概念

当前字段：

```ts
maxOutputTokens
```

同时表示：

1. 模型自身支持的最大输出能力；
2. Jojo 本次实际申请的最大输出预算。

二者不应该等价。

例如：

```text
模型最大输出能力：128K
```

不意味着 Jojo 每次都应该发送：

```json
{
  "max_completion_tokens": 128000
}
```

否则 Context Manager 也会按照 128K 为输出预留空间，从而极大压缩输入预算。

正确语义应拆成：

```text
模型硬能力：
maxOutputTokens

Jojo 默认单次请求预算：
defaultOutputTokens
```

运行时再得到：

```text
requestMaxOutputTokens
```

---

# 3. 设计目标

本方案目标：

1. Token 能力从 Provider 级下沉到 Model 级；
2. 用户正常情况下无需手工填写 Context Window；
3. 用户正常情况下无需手工填写模型 Max Output；
4. 优先使用 Provider 返回的模型元数据；
5. Provider 不返回时使用 Jojo 内置模型元数据；
6. 无法识别模型时使用保守 fallback；
7. 高级用户仍可手动覆盖；
8. 每个字段都能记录数据来源；
9. Provider 信息变化后可以重新自动刷新；
10. Runtime 永远使用当前选中 Model 的限制；
11. 保持当前 Context Manager 基本算法不变；
12. 保持 OpenAI-compatible Provider 的兼容性；
13. 不通过“大请求撞限制”的方式主动探测模型窗口；
14. 对 Desktop、Headless Server、Scheduler、Sub-Agent、Workflow 使用统一解析逻辑；
15. 保证旧配置自动迁移，无需用户重新配置 Provider。

---

# 4. 非目标

本阶段不做：

- 精确 tokenizer；
- 根据实际任务动态预测最佳上下文长度；
- 通过二分大请求探测模型 context limit；
- 自动修改模型官方能力；
- Provider 故障转移；
- 模型价格自动同步；
- 自动选择“最聪明”的模型；
- Responses / Anthropic Messages 等新协议迁移；
- 完全依赖远端模型目录作为唯一真相。

这些能力可在后续阶段独立演进。

---

# 5. 术语

## 5.1 Provider

负责协议和请求传输：

```text
Base URL
API Key
Protocol
Model Discovery
HTTP
SSE
```

例如：

```text
OpenAI-compatible Provider
OpenRouter-compatible endpoint
DeepSeek-compatible endpoint
企业内部 OpenAI-compatible gateway
```

---

## 5.2 Model

Provider 下实际执行推理的模型：

```text
Provider
   └─ Model
```

模型拥有：

```text
Context Window
Max Output
Tools
Vision
Reasoning
Structured Output
...
```

---

## 5.3 Context Window

单次推理可接受的总上下文能力。

Jojo 使用它决定：

```text
什么时候需要回收 Tool Result
什么时候需要 compact
多少输入可以进入本次模型请求
```

---

## 5.4 Model Max Output

模型协议/路由允许的最大输出 token：

```text
model.maxOutputTokens
```

这是能力上限，不等于每次实际申请的值。

---

## 5.5 Default Output Tokens

Jojo 默认一次模型调用准备申请的输出 token：

```text
model.defaultOutputTokens
```

例如：

```text
model.maxOutputTokens     = 128000
model.defaultOutputTokens = 8192
```

---

## 5.6 Request Max Output

最终本次请求实际使用：

```text
requestMaxOutputTokens
```

计算：

```ts
const requestMaxOutputTokens = Math.min(
  runOverride ?? model.defaultOutputTokens,
  model.maxOutputTokens
);
```

Context Manager 和 Provider 必须使用同一个最终值。

---

# 6. 总体架构

```text
                     ┌───────────────────────┐
                     │ Provider /models      │
                     │ 或 Provider 扩展字段  │
                     └──────────┬────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │ Model Discovery Adapter │
                    └──────────┬──────────────┘
                               │
                               ▼
          ┌────────────────────────────────────────┐
          │ Model Metadata Resolver                │
          │                                        │
          │ user override                          │
          │       > provider metadata              │
          │       > builtin registry               │
          │       > conservative fallback          │
          └──────────────────┬─────────────────────┘
                             │
                             ▼
                   ┌──────────────────────┐
                   │ EffectiveModelConfig │
                   └─────────┬────────────┘
                             │
             ┌───────────────┼────────────────┐
             ▼               ▼                ▼
       Context Manager   ModelRequest      UI / Diagnostics
             │               │
             ▼               ▼
       Compaction       max_completion_tokens
```

核心原则：

> Provider 决定“怎么调用”；Model 决定“模型有什么能力”。

---

# 7. 推荐数据模型

## 7.1 不再使用 `models: string[]` 作为长期结构

当前：

```ts
models: string[];
```

目标：

```ts
models: ModelConfig[];
```

---

## 7.2 Metadata Source

建议：

```ts
export const ModelMetadataSourceSchema = z.enum([
  'provider',
  'builtin',
  'fallback',
  'user'
]);

export type ModelMetadataSource =
  z.infer<typeof ModelMetadataSourceSchema>;
```

---

## 7.3 带来源的值

由于不同字段可能来自不同来源，不建议给整个模型只保存一个 `source`。

例如：

```text
contextWindowTokens -> provider
maxOutputTokens     -> builtin
vision              -> provider
defaultOutputTokens -> Jojo default
```

因此建议：

```ts
export type SourcedValue<T> = {
  value: T;
  source: ModelMetadataSource;

  updatedAt?: string;
};
```

Zod：

```ts
const sourcedPositiveInt = z.object({
  value: z.number().int().positive(),
  source: ModelMetadataSourceSchema,
  updatedAt: z.string().datetime().optional()
}).strict();
```

---

# 8. ModelConfig

推荐目标结构：

```ts
export const ModelConfigSchema = z.object({
  id: z.string().trim().min(1),

  limits: z.object({
    contextWindowTokens: sourcedPositiveInt,
    maxOutputTokens: sourcedPositiveInt,

    defaultOutputTokens: z.object({
      value: z.number().int().positive(),
      source: z.enum(['builtin', 'fallback', 'user'])
    }).strict()
  }).strict(),

  capabilities: z.object({
    toolCalls: sourcedBoolean.optional(),
    vision: sourcedBoolean.optional(),
    reasoning: sourcedBoolean.optional(),
    promptCaching: sourcedBoolean.optional(),
    structuredOutput: sourcedBoolean.optional(),
    parallelToolCalls: sourcedBoolean.optional()
  }).strict(),

  metadata: z.object({
    discoveredAt: z.string().datetime().optional(),
    providerRawRevision: z.string().optional()
  }).strict().optional()
}).strict();
```

概念结构：

```text
ModelConfig
 ├─ id
 │
 ├─ limits
 │   ├─ contextWindowTokens
 │   │      value
 │   │      source
 │   │
 │   ├─ maxOutputTokens
 │   │      value
 │   │      source
 │   │
 │   └─ defaultOutputTokens
 │          value
 │          source
 │
 └─ capabilities
     ├─ toolCalls
     ├─ vision
     ├─ reasoning
     ├─ promptCaching
     ├─ structuredOutput
     └─ parallelToolCalls
```

---

# 9. ProviderConfig v4

目标：

```ts
export const ProviderConfigSchema = z.object({
  id: z.string().min(1),

  name: z.string().trim().min(1),

  protocol: ProviderProtocolSchema,

  baseUrl: z.string().url(),

  // 默认模型 ID
  model: z.string().trim().min(1),

  // 由 string[] 升级为 ModelConfig[]
  models: z.array(ModelConfigSchema).min(1),

  hasApiKey: z.boolean().default(false)
}).strict();
```

约束：

```ts
.superRefine((provider, ctx) => {
  if (!provider.models.some(
    model => model.id === provider.model
  )) {
    ctx.addIssue({
      code: 'custom',
      message: `Default model is missing from provider ${provider.id}.`
    });
  }

  for (const model of provider.models) {
    const context =
      model.limits.contextWindowTokens.value;

    const maxOutput =
      model.limits.maxOutputTokens.value;

    const defaultOutput =
      model.limits.defaultOutputTokens.value;

    if (maxOutput >= context) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Max output must be smaller than context window for ${model.id}.`
      });
    }

    if (defaultOutput > maxOutput) {
      ctx.addIssue({
        code: 'custom',
        message:
          `Default output exceeds model max output for ${model.id}.`
      });
    }
  }
});
```

---

# 10. DiscoveredModel

Provider 层不应该直接创建最终 `ModelConfig`。

Provider 只负责报告：

> “我从远端看到什么”。

新增：

```ts
export type DiscoveredModel = {
  id: string;

  contextWindowTokens?: number;

  maxOutputTokens?: number;

  capabilities?: {
    toolCalls?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    promptCaching?: boolean;
    structuredOutput?: boolean;
    parallelToolCalls?: boolean;
  };

  raw?: unknown;
};
```

Provider API：

当前：

```ts
listModels(): Promise<string[]>;
```

改为：

```ts
listModels(): Promise<DiscoveredModel[]>;
```

或者为了兼容性采用分阶段方案：

```ts
listModels(): Promise<string[]>;

discoverModels?(): Promise<DiscoveredModel[]>;
```

推荐直接升级统一接口，避免长期维护两个模型发现 API。

---

# 11. 自动发现优先级

最终每个字段使用：

```text
User Override
      ↓
Provider Metadata
      ↓
Builtin Model Registry
      ↓
Conservative Fallback
```

即：

```text
user > provider > builtin > fallback
```

注意：

> 优先级必须按“字段”处理，而不是按“整个模型”处理。

---

# 12. 字段级 Merge 示例

远端：

```ts
{
  id: 'example-model',
  contextWindowTokens: 200_000,
  capabilities: {
    toolCalls: true
  }
}
```

内置：

```ts
{
  id: 'example-model',
  contextWindowTokens: 128_000,
  maxOutputTokens: 32_000,
  capabilities: {
    toolCalls: true,
    vision: true
  }
}
```

用户：

```ts
{
  maxOutputTokens: 16_000
}
```

最终：

```text
contextWindowTokens
= 200000
source = provider

maxOutputTokens
= 16000
source = user

toolCalls
= true
source = provider

vision
= true
source = builtin
```

---

# 13. Model Metadata Resolver

建议新增包内模块：

```text
packages/providers/src/model-metadata/
  types.ts
  resolver.ts
  builtin-registry.ts
  fallback.ts
  provider-normalizer.ts
```

或者如果希望 Provider 与 Model Registry 更彻底解耦：

```text
packages/model-registry/
```

从当前仓库规模看，第一阶段放在：

```text
packages/providers/src/model-metadata/
```

改动更小。

---

# 14. Resolver API

```ts
export type ModelOverride = {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultOutputTokens?: number;

  capabilities?: Partial<{
    toolCalls: boolean;
    vision: boolean;
    reasoning: boolean;
    promptCaching: boolean;
    structuredOutput: boolean;
    parallelToolCalls: boolean;
  }>;
};

export function resolveModelMetadata(input: {
  discovered: DiscoveredModel;
  builtin?: BuiltinModelMetadata;
  override?: ModelOverride;
}): ModelConfig;
```

逻辑：

```ts
resolveField({
  user,
  provider,
  builtin,
  fallback
});
```

---

# 15. 通用字段解析函数

建议：

```ts
function resolveValue<T>(
  values: {
    user?: T;
    provider?: T;
    builtin?: T;
    fallback: T;
  }
): SourcedValue<T> {
  if (values.user !== undefined) {
    return {
      value: values.user,
      source: 'user'
    };
  }

  if (values.provider !== undefined) {
    return {
      value: values.provider,
      source: 'provider'
    };
  }

  if (values.builtin !== undefined) {
    return {
      value: values.builtin,
      source: 'builtin'
    };
  }

  return {
    value: values.fallback,
    source: 'fallback'
  };
}
```

避免在多个 Provider adapter 中重复优先级判断。

---

# 16. Builtin Model Registry

Provider 不一定返回 Context Window 和 Max Output，因此需要 Jojo 自带一份已知模型元数据。

建议：

```text
packages/providers/src/model-metadata/builtin-registry.ts
```

结构：

```ts
export type BuiltinModelMetadata = {
  contextWindowTokens?: number;
  maxOutputTokens?: number;

  capabilities?: {
    toolCalls?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    promptCaching?: boolean;
    structuredOutput?: boolean;
    parallelToolCalls?: boolean;
  };
};
```

Registry：

```ts
const BUILTIN_MODEL_REGISTRY:
  Record<string, BuiltinModelMetadata> = {
    // exact IDs
  };
```

---

# 17. Registry 支持 Exact + Pattern

只支持 exact model ID 会很快过时。

推荐支持：

```ts
type ModelMetadataRule =
  | {
      type: 'exact';
      id: string;
      metadata: BuiltinModelMetadata;
    }
  | {
      type: 'prefix';
      prefix: string;
      metadata: BuiltinModelMetadata;
    }
  | {
      type: 'regex';
      pattern: RegExp;
      metadata: BuiltinModelMetadata;
    };
```

优先级：

```text
exact
  >
prefix
  >
regex
```

但需要限制 regex 数量，避免 Model 刷新时大量匹配影响 UI。

---

# 18. Builtin Registry 的定位

Builtin Registry 只是：

```text
Provider Metadata 的 fallback
```

不能成为唯一真相。

原因：

- 模型能力可能变化；
- 同模型在不同网关下可用上限可能不同；
- OpenRouter 等路由可能有 endpoint 级约束；
- 企业内部 Provider 可能人为限制窗口；
- 用户代理服务可能裁剪上下文。

因此：

```text
Provider 报告值 > Jojo 内置值
```

默认是正确选择。

---

# 19. Provider-specific Discovery

统一接口：

```ts
listModels(): Promise<DiscoveredModel[]>;
```

Provider adapter 负责把不同响应格式归一化。

例如：

```text
Remote Provider JSON
        ↓
OpenAICompatibleProvider
        ↓
DiscoveredModel[]
```

---

# 20. OpenAI-compatible 通用模式

标准模型列表常见最低信息：

```json
{
  "data": [
    {
      "id": "model-id"
    }
  ]
}
```

对于只返回 `id` 的服务：

```ts
{
  id: model.id
}
```

随后由 Model Metadata Resolver 自动补充：

```text
Builtin
   ↓
Fallback
```

因此即使远端没有能力字段，也不会影响兼容性。

---

# 21. OpenRouter 类型服务

如果远端模型列表包含额外字段，例如：

```text
context length
max completion tokens
supported parameters
architecture / modality
```

Provider adapter 应直接归一化为：

```ts
{
  id,
  contextWindowTokens,
  maxOutputTokens,
  capabilities
}
```

不要让 Renderer 解析 Provider-specific JSON。

---

# 22. DeepSeek 类型服务

当前代码已经针对：

```text
api.deepseek.com
```

做了：

```text
max_completion_tokens
      ↓
max_tokens
```

模型发现仍按统一 `DiscoveredModel` 输出。

如果其 `/models` 不提供限制：

```text
Provider
  ↓
id only
  ↓
Builtin Registry
  ↓
Fallback
```

不需要用真实大请求探测。

---

# 23. 不使用主动撞限制探测

明确禁止类似：

```text
发 128K
失败

发 64K
成功

猜测窗口约 64K
```

原因：

1. 浪费 token；
2. 可能产生实际费用；
3. 速度慢；
4. 容易触发 Rate Limit；
5. 不同 tokenizer 会造成误差；
6. Reasoning Token 会改变输出行为；
7. 网关和模型自身限制可能不一致；
8. 路由 Provider 可能动态选择不同后端；
9. 不能保证探测结果长期稳定；
10. 对生产账号不友好。

允许的自动发现只能基于：

```text
Metadata
Registry
Fallback
```

---

# 24. Conservative Fallback

当：

```text
Provider 没返回
Builtin 不认识
User 没 override
```

需要一个保守值。

当前 Jojo 已经使用：

```text
128000 / 8192
```

为了兼容旧行为，v4 第一阶段建议继续：

```ts
const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;
const FALLBACK_MODEL_MAX_OUTPUT_TOKENS = 8_192;
const FALLBACK_DEFAULT_OUTPUT_TOKENS = 8_192;
```

但这三个值必须语义明确：

```text
context = 假设窗口
model max output = 未知情况下的保守上限
default output = Jojo 默认申请
```

后续可调整为更保守的：

```text
64K / 8K / 8K
```

但不建议和 v4 migration 同时改变默认行为，以降低回归风险。

---

# 25. Default Output Tokens

新增：

```ts
defaultOutputTokens
```

推荐默认算法：

```ts
function deriveDefaultOutputTokens(
  maxOutputTokens: number
): number {
  return Math.min(
    maxOutputTokens,
    8_192
  );
}
```

第一阶段不要过度智能化。

---

# 26. 未来可选：按任务动态输出预算

后续可以支持：

```text
标题生成
   128 / 256

Memory Candidate
   1024

历史摘要
   1024

普通 Agent
   8192

Architecture Review
   16384

大型 Synthesis
   16384 / 32768
```

但这属于 Runtime Policy，不属于 Model Capability。

因此必须分开：

```text
Model capability
      ≠
Runtime request policy
```

---

# 27. Runtime EffectiveModelLimits

建议新增统一解析类型：

```ts
export type EffectiveModelLimits = {
  contextWindowTokens: number;
  modelMaxOutputTokens: number;
  requestMaxOutputTokens: number;
};
```

函数：

```ts
export function resolveEffectiveModelLimits(
  model: ModelConfig,
  requestOverride?: {
    maxOutputTokens?: number;
  }
): EffectiveModelLimits {
  const contextWindowTokens =
    model.limits.contextWindowTokens.value;

  const modelMaxOutputTokens =
    model.limits.maxOutputTokens.value;

  const defaultOutputTokens =
    model.limits.defaultOutputTokens.value;

  const requestMaxOutputTokens =
    Math.min(
      requestOverride?.maxOutputTokens ??
        defaultOutputTokens,
      modelMaxOutputTokens
    );

  return {
    contextWindowTokens,
    modelMaxOutputTokens,
    requestMaxOutputTokens
  };
}
```

---

# 28. Context Manager 改造

当前输入：

```ts
{
  contextWindowTokens,
  maxOutputTokens
}
```

可以暂时保持 API 不变。

但调用方传入：

```text
contextWindowTokens
      =
model.contextWindowTokens

maxOutputTokens
      =
requestMaxOutputTokens
```

非常重要：

> Context Manager 应使用“本次实际输出预算”，而不是模型理论最大输出。

否则一个支持 128K 输出的模型会导致 Jojo 每次都提前预留 128K。

---

# 29. ModelRequest 改造

当前：

```ts
export type ModelRequest = {
  ...
  maxOutputTokens?: number;
};
```

这个字段语义继续保持：

```text
本次请求实际最大输出
```

不要改成：

```text
模型能力上限
```

最终：

```ts
provider.stream({
  model,
  messages,
  tools,
  signal,

  maxOutputTokens:
    limits.requestMaxOutputTokens
});
```

---

# 30. Provider Request

现有逻辑继续有效：

```text
ModelRequest.maxOutputTokens
        ↓
max_completion_tokens
```

DeepSeek：

```text
ModelRequest.maxOutputTokens
        ↓
max_tokens
```

因此 Provider 请求层无需知道：

```text
modelMaxOutputTokens
```

它只需要收到已经解析后的：

```text
requestMaxOutputTokens
```

---

# 31. Worker 改造

当前类似：

```ts
contextWindowTokens:
  providerConfig.contextWindowTokens,

maxOutputTokens:
  providerConfig.maxOutputTokens
```

改为：

```ts
const modelConfig =
  providerConfig.models.find(
    item => item.id === model
  );

if (!modelConfig) {
  throw new Error(
    `Model ${model} is missing from provider ${providerId}.`
  );
}

const limits =
  resolveEffectiveModelLimits(modelConfig);
```

然后：

```ts
budget: {
  contextWindowTokens:
    limits.contextWindowTokens,

  maxOutputTokens:
    limits.requestMaxOutputTokens
}
```

---

# 32. Scheduler / Workflow / Sub-Agent

任何地方不能再直接读取：

```ts
providerConfig.contextWindowTokens
providerConfig.maxOutputTokens
```

统一调用：

```ts
resolveEffectiveModelLimits()
```

涉及：

```text
Main Agent
Sub-Agent
Workflow Agent Step
Persistent Team Member
Scheduler Agent
Channel-triggered Agent
Headless Server Run
Utility Model
Memory extraction
Browser heal
```

避免不同执行入口出现预算不一致。

---

# 33. Utility Model

当前：

```ts
utilityModel: {
  providerId,
  model
}
```

继续保留。

执行标题/摘要时：

```text
utilityModel
   ↓
找到 Provider
   ↓
找到 ModelConfig
   ↓
resolveEffectiveModelLimits
```

然后 Utility 请求可以自己指定更小输出：

```ts
requestMaxOutputTokens =
  Math.min(
    utilityTaskLimit,
    model.maxOutputTokens
  );
```

例如摘要：

```text
1024
```

不应该使用默认 Agent 的 8192。

---

# 34. UI 目标

正常用户看到：

```text
模型
┌─────────────────────────────┐
│ model-x                  ▼  │
└─────────────────────────────┘

上下文窗口
400,000 tokens
✓ 自动检测

模型最大输出
128,000 tokens
✓ 自动检测

默认输出预算
8,192 tokens
✓ Jojo 默认

高级设置
▶ 覆盖模型限制
```

---

# 35. UI Source 展示

推荐：

```text
✓ Provider
✓ Jojo 已知模型
△ 默认值
✎ 手动覆盖
```

例如：

```text
上下文窗口
400,000
Provider 自动检测

最大输出
128,000
Jojo 模型库

默认输出预算
8,192
Jojo 默认
```

这样用户可以判断可靠性。

---

# 36. Advanced Override

默认折叠。

展开：

```text
高级模型参数

[ ] 手动覆盖自动检测值

Context Window
[ 400000 ]

Model Max Output
[ 128000 ]

Default Output Budget
[ 8192 ]
```

如果用户修改：

```text
source = user
```

---

# 37. Reset Override

必须提供：

```text
恢复自动检测
```

行为：

```text
删除 user override
      ↓
重新执行 Resolver
      ↓
Provider > Builtin > Fallback
```

不要把当前自动值直接复制成新的 user override。

---

# 38. 模型刷新流程

当前：

```text
刷新模型
   ↓
GET /models
   ↓
string[]
```

目标：

```text
刷新模型
   ↓
discoverModels()
   ↓
DiscoveredModel[]
   ↓
Model Metadata Resolver
   ↓
ModelConfig[]
   ↓
保留已有 user override
   ↓
更新 ProviderConfig
   ↓
保存
```

---

# 39. 自动刷新策略

推荐四个触发点。

## A. Base URL 变化

```text
Provider Base URL 改变
       ↓
旧 metadata 标为 stale
```

保存时重新获取。

---

## B. API Key 变化

新 Key 可能获得不同模型权限：

```text
API Key changed
      ↓
refresh models
```

---

## C. 设置页打开

如果：

```text
metadataAge > 24h
```

可以后台刷新。

要求：

- 不阻塞设置页打开；
- 刷新失败继续使用缓存；
- 不删除原有可用模型。

---

## D. 用户手动刷新

保留：

```text
刷新模型
```

作为明确的强制刷新入口。

---

# 40. Metadata TTL

推荐：

```ts
const MODEL_METADATA_TTL_MS =
  24 * 60 * 60 * 1000;
```

这是“是否后台刷新”的阈值，不代表过期 metadata 不能使用。

原则：

```text
stale metadata
   ≠
invalid metadata
```

离线状态仍使用上次缓存。

---

# 41. 刷新失败策略

模型刷新失败时：

```text
保留旧 ModelConfig[]
        ↓
显示：
“模型元数据刷新失败，继续使用缓存”
```

禁止：

```text
刷新失败
   ↓
清空模型列表
```

否则网络抖动会破坏用户现有配置。

---

# 42. Provider 返回模型消失

如果远端新列表没有当前默认模型：

不要立即删除。

建议：

```text
current selected model
     ↓
remote missing
     ↓
mark unavailable / stale
```

UI：

```text
model-x
⚠ 当前 Provider 未返回该模型
```

用户切走后再允许清理。

这比保存时突然把默认模型改掉更安全。

---

# 43. 新模型加入

远端出现新模型：

```text
Provider metadata
       ↓
Builtin metadata
       ↓
Fallback
       ↓
新增 ModelConfig
```

不影响当前模型。

---

# 44. User Override 的持久化

Provider metadata 刷新时：

```text
不能覆盖 user override
```

例如：

```text
Provider:
context = 128K

User Override:
context = 64K
```

刷新后仍：

```text
effective context = 64K
```

直到用户：

```text
恢复自动检测
```

---

# 45. 更推荐的持久化方式

为了避免“刷新后不知道哪些值是用户改的”，可以将：

```text
发现值
覆盖值
```

分开持久化。

例如：

```ts
type ModelConfig = {
  id: string;

  discovered?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    capabilities?: ModelCapabilities;
    source: 'provider' | 'builtin' | 'fallback';
    updatedAt?: string;
  };

  override?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    defaultOutputTokens?: number;
    capabilities?: Partial<ModelCapabilities>;
  };
};
```

然后 Runtime 生成：

```text
EffectiveModelConfig
```

这种设计比直接保存 `SourcedValue<T>` 更适合长期维护。

---

# 46. 推荐最终持久化模型

综合考虑刷新、override 和 migration，推荐采用：

```ts
export type PersistedModelConfig = {
  id: string;

  discovered: {
    contextWindowTokens: number;
    maxOutputTokens: number;

    capabilities?: ModelCapabilities;

    sources: {
      contextWindowTokens:
        'provider' | 'builtin' | 'fallback';

      maxOutputTokens:
        'provider' | 'builtin' | 'fallback';
    };

    discoveredAt?: string;
  };

  override?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    defaultOutputTokens?: number;

    capabilities?:
      Partial<ModelCapabilities>;
  };

  defaults: {
    outputTokens: number;
  };
};
```

Runtime：

```ts
effective.contextWindowTokens =
  override.contextWindowTokens
  ?? discovered.contextWindowTokens;

effective.maxOutputTokens =
  override.maxOutputTokens
  ?? discovered.maxOutputTokens;

effective.defaultOutputTokens =
  override.defaultOutputTokens
  ?? defaults.outputTokens;
```

这种方式：

- Provider refresh 可直接更新 `discovered`；
- User override 永远独立；
- UI 很容易显示来源；
- Reset 自动值只需要删 override；
- 不需要猜某个值是不是用户填写。

---

# 47. 配置 Schema v4

当前 Storage：

```text
schemaVersion = 3
```

v4：

```ts
const StoredConfigV4Schema = z.object({
  schemaVersion: z.literal(4),

  activeProviderId: z.string().min(1),

  providers: z.array(
    StoredProviderV4Schema
  ).min(1),

  utilityModel: ModelSelectionSchema,

  permissions: z.unknown().optional(),
  memory: z.unknown().optional(),
  extensions: z.unknown().optional()
});
```

---

# 48. v3 → v4 Migration

当前 v3：

```json
{
  "id": "openai",
  "model": "model-a",
  "models": [
    "model-a",
    "model-b"
  ],
  "contextWindowTokens": 128000,
  "maxOutputTokens": 8192
}
```

迁移为：

```json
{
  "id": "openai",
  "model": "model-a",
  "models": [
    {
      "id": "model-a",
      "discovered": {
        "contextWindowTokens": 128000,
        "maxOutputTokens": 8192,
        "sources": {
          "contextWindowTokens": "fallback",
          "maxOutputTokens": "fallback"
        }
      },
      "defaults": {
        "outputTokens": 8192
      }
    },
    {
      "id": "model-b",
      "discovered": {
        "contextWindowTokens": 128000,
        "maxOutputTokens": 8192,
        "sources": {
          "contextWindowTokens": "fallback",
          "maxOutputTokens": "fallback"
        }
      },
      "defaults": {
        "outputTokens": 8192
      }
    }
  ]
}
```

关键原则：

> v3 只有 Provider 级值，无法知道具体 Model 的真实能力，因此 migration 不应假装这是官方精确数据。

所以标记：

```text
source = fallback
```

迁移完成后，下一次 model refresh 再自动替换 discovered metadata。

---

# 49. Migration 不应该创建 User Override

旧配置：

```text
128000 / 8192
```

不能迁移成：

```text
user override
```

否则以后 Provider 自动发现永远无法接管。

正确：

```text
legacy value
   ↓
fallback / legacy migrated discovery
```

---

# 50. Config Save

当前：

```text
schemaVersion: 3
```

升级：

```text
schemaVersion: 4
```

保存时：

```text
hasApiKey
```

继续不写入普通 JSON。

API Key 的安全存储逻辑不变。

---

# 51. Desktop IPC

当前 `SaveSettingsInputSchema` 包含：

```text
provider.contextWindowTokens
provider.maxOutputTokens
```

v4 删除 Provider 级字段，改为：

```ts
provider: {
  id,
  name,
  protocol,
  baseUrl,
  model,
  models: [...]
}
```

需要新增独立模型更新 API 时，推荐：

```text
refreshProviderModels()
updateModelOverride()
resetModelOverride()
```

而不是每次修改一个数字都提交整个 Provider。

---

# 52. 建议的 Desktop API

```ts
refreshProviderModels(input: {
  providerId: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<ProviderConfig>;
```

```ts
updateModelOverride(input: {
  providerId: string;
  model: string;

  override: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    defaultOutputTokens?: number;
  };
}): Promise<ProviderSettings>;
```

```ts
resetModelOverride(input: {
  providerId: string;
  model: string;
}): Promise<ProviderSettings>;
```

---

# 53. 不建议 Renderer 做 Merge

Renderer 只负责：

```text
展示
输入
触发动作
```

以下逻辑：

```text
Provider > Builtin > Fallback
Preserve Override
Validation
Migration
```

应该放在 Core / Provider Metadata 层。

避免 Desktop 和 Headless Server 两套逻辑。

---

# 54. Headless CLI

当前 CLI Provider schema 主要包含：

```text
type
name
baseUrl
apiKey
models
```

Desktop 的 Model metadata 机制后续应向 Headless 统一。

推荐最终 CLI：

```yaml
provider:
  defaultProviderId: openai
  defaultModel: model-x

  providers:
    openai:
      type: openai-compatible
      baseUrl: ...
      apiKey:
        env: OPENAI_API_KEY

      models:
        - id: model-x

          override:
            contextWindowTokens: 400000
            defaultOutputTokens: 8192
```

但第一阶段可以保持 CLI 兼容旧：

```yaml
models:
  - model-x
```

Loader 自动转换。

---

# 55. Headless Runtime 自动发现

Headless 场景不应依赖 Renderer。

推荐：

```text
启动
 ↓
加载缓存
 ↓
可以立即服务
 ↓
Provider metadata stale?
 ↓
后台刷新
```

刷新失败不影响已经缓存模型的运行。

---

# 56. Provider Capabilities 与 Model Capabilities

当前 `ProviderCapabilitiesSchema` 已包含：

```ts
maxContextTokens
maxOutputTokens
```

长期建议重新明确语义。

Provider Capability：

```text
这个 adapter / endpoint 支持什么协议能力
```

Model Capability：

```text
这个具体 Model 支持什么推理能力
```

例如：

```text
Provider supports tool calling protocol
       ≠
Every Model supports tool calling
```

因此：

```ts
ProviderCapabilities
```

应主要保留 protocol/adapter 级能力。

模型限制迁入：

```ts
ModelCapabilities
ModelLimits
```

---

# 57. 推荐新增 ModelCapabilities

```ts
export const ModelCapabilitiesSchema = z.object({
  toolCalls: z.boolean().optional(),
  vision: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  promptCaching: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  parallelToolCalls: z.boolean().optional()
}).strict();
```

Model Limits：

```ts
export const ModelLimitsSchema = z.object({
  contextWindowTokens:
    z.number().int().positive(),

  maxOutputTokens:
    z.number().int().positive(),

  defaultOutputTokens:
    z.number().int().positive()
}).strict();
```

---

# 58. Tool Discovery 联动

Jojo 当前 Tool Definition 本身也占 Context。

未来可以根据：

```text
model.toolCalls
```

决定：

```text
是否暴露工具
```

如果：

```text
toolCalls = false
```

则在 Agent Run 前直接失败：

```text
model_tools_unsupported
```

而不是先发请求再等 Provider 400。

---

# 59. Vision 联动

当前 Provider 对图片输入有兼容降级。

Model metadata 增加：

```text
vision
```

后可以：

```text
vision = false
   ↓
请求发送前直接进行 text-only projection
```

减少一次失败后重试。

不过第一阶段可只保存 capability，不改变当前降级行为，降低改造风险。

---

# 60. Context Window 误差保护

即使自动发现，也不能假设数值 100% 精确。

当前：

```text
0.82 target ratio
```

应该保留。

即：

```text
Provider metadata
    ≠
Jojo 直接用满 100%
```

仍然：

```ts
target =
  floor(contextWindowTokens * 0.82)
  - requestMaxOutputTokens;
```

原因：

- token 估算不是精确 tokenizer；
- Tool Definition 有协议包装开销；
- Chat message framing 有开销；
- 兼容 Provider 可能有自己的系统指令；
- 路由层可能额外增加内容。

---

# 61. Context Overflow Error

当前 Context Manager 已能报告：

```text
固定指令与工具定义占用过大
```

v4 错误信息应增加模型来源信息。

例如：

```text
模型：model-x
上下文窗口：64,000
来源：Provider 自动检测
固定工具/指令：58,200
输出预留：8,192
最小消息预算不足
```

这样更容易诊断 MCP 工具过多的问题。

---

# 62. Runtime Diagnostics

建议在现有：

```text
context.updated
```

之外扩展：

```ts
modelLimits?: {
  model: string;

  contextWindowTokens: number;
  modelMaxOutputTokens: number;
  requestMaxOutputTokens: number;

  contextSource:
    'provider' | 'builtin' | 'fallback' | 'user';

  maxOutputSource:
    'provider' | 'builtin' | 'fallback' | 'user';
}
```

可以只用于 diagnostics，不一定全部展示。

---

# 63. UI Context 状态

输入框附近可以显示：

```text
Context 23K / 400K
Output Budget 8K
```

Tooltip：

```text
Model: xxx
Context: 400,000 (Provider)
Max output: 128,000 (Builtin)
Current request budget: 8,192
```

---

# 64. Error Handling

## 64.1 Provider Metadata 非法

例如：

```text
contextWindowTokens <= 0
maxOutputTokens <= 0
NaN
超大异常值
```

直接忽略该字段：

```text
invalid provider metadata
        ↓
builtin
        ↓
fallback
```

不要让整个模型列表刷新失败。

---

## 64.2 `maxOutput >= contextWindow`

如果远端返回：

```text
maxOutputTokens >= contextWindowTokens
```

视为冲突 metadata。

处理：

```text
记录 diagnostic
   ↓
忽略 maxOutput 或 clamp
```

推荐：

```text
忽略异常 maxOutput
重新走 builtin/fallback
```

不要静默修改官方值。

---

## 64.3 Default Output 超过 Model Max

自动：

```ts
defaultOutput =
  Math.min(
    configuredDefault,
    modelMaxOutput
  );
```

用户保存时仍应提示。

---

## 64.4 Provider 运行时返回 Context Overflow

即使 metadata 自动发现，也可能发生。

发生后：

```text
context_length_exceeded
```

建议：

1. 不自动进行大规模重试；
2. 标记 metadata 可能 stale；
3. UI 显示「模型上下文限制可能已变化」；
4. 提供「刷新模型能力」；
5. 可选做一次更保守的 local compaction retry，但必须有明确次数上限。

第一阶段建议只提示刷新，不自动改变模型 metadata。

---

# 65. Model ID Alias

需要考虑：

```text
gpt-x
gpt-x-latest
vendor/gpt-x
deployment-name
```

Builtin Registry 可以通过：

```text
exact
prefix
regex
```

匹配。

但 Provider 返回的值始终保存原始：

```text
model.id
```

不要替换用户实际请求用的 Model ID。

---

# 66. Provider Gateway 场景

企业 Gateway 可能：

```text
model ID 相同
但 context 限制更小
```

因此：

```text
Provider Metadata > Builtin Registry
```

非常重要。

Builtin 只是厂商模型能力参考，Provider 才是当前真实 endpoint 的直接信息源。

---

# 67. Security

Model metadata 不属于密钥。

可以保存：

```text
model ID
context limit
output limit
capabilities
timestamps
```

不能保存：

```text
Authorization Header
API Key
Provider 原始敏感响应
```

如果保留：

```ts
raw?: unknown
```

只能用于内存诊断。

默认不要持久化整个 Provider `/models` 原始 JSON。

---

# 68. Logging

允许记录：

```text
providerId
modelId
metadata source
context limit
output limit
refresh success/failure
elapsed time
```

禁止记录：

```text
API Key
Authorization
完整私有 Provider 响应
```

---

# 69. 代码改造清单

## contracts

### `packages/contracts/src/model.ts`

新增：

```text
ModelCapabilities
ModelLimits
DiscoveredModel
EffectiveModelLimits
```

重新明确：

```text
ProviderCapabilities
```

语义。

---

### `packages/contracts/src/persistence.ts`

修改：

```text
ProviderConfig.models
string[]
   ↓
ModelConfig[]
```

删除 Provider 级：

```text
contextWindowTokens
maxOutputTokens
```

新增：

```text
ModelConfigSchema
ModelOverrideSchema
ModelDiscoveredMetadataSchema
```

---

### `packages/contracts/src/desktop.ts`

修改：

```text
SaveSettingsInputSchema
```

新增：

```text
RefreshProviderModelsInputSchema
UpdateModelOverrideInputSchema
ResetModelOverrideInputSchema
```

---

# 70. providers

### `packages/providers/src/openai-compatible-provider.ts`

当前：

```ts
listModels(): Promise<string[]>
```

改：

```ts
listModels(): Promise<DiscoveredModel[]>
```

职责：

```text
解析远端模型信息
Provider-specific normalization
忽略非法 optional metadata
```

---

### `packages/providers/src/registry.ts`

`DiscoverableModelProvider`：

```ts
export type DiscoverableModelProvider =
  ModelProvider & {
    listModels():
      Promise<DiscoveredModel[]>;
  };
```

---

### 新增

```text
packages/providers/src/model-metadata/
  resolver.ts
  builtin-registry.ts
  fallback.ts
  types.ts
```

---

# 71. Agent

### `packages/agent/src/context-manager.ts`

核心算法基本不改。

确保参数语义：

```text
maxOutputTokens =
本次 request output budget
```

不是：

```text
模型理论最大输出
```

---

### `packages/agent/src/run-agent-turn.ts`

保持：

```text
contextWindowTokens
maxOutputTokens
```

Agent Core 不需要知道 metadata 来源。

这是正确的抽象边界。

---

# 72. Desktop Worker

### `apps/desktop/src/worker/worker.ts`

新增统一：

```ts
resolveModelForRun(
  providerId,
  model
)
```

返回：

```ts
{
  provider,
  modelConfig,
  limits
}
```

所有 Agent 入口复用。

删除直接访问：

```text
providerConfig.contextWindowTokens
providerConfig.maxOutputTokens
```

---

# 73. Renderer

### `apps/desktop/src/renderer/main.tsx`

当前：

```text
contextWindowInput
maxOutputInput
```

从 Provider 级 state 调整为：

```text
selectedModelConfig
```

默认只读展示自动值。

高级模式才允许 override。

新增：

```text
来源 badge
metadata stale 状态
reset override
刷新时间
```

---

# 74. Storage

### `packages/storage/src/index.ts`

当前已有：

```text
V1
V2
V3
```

新增：

```text
StoredConfigV4Schema
```

`JsonConfigStore.get()`：

```text
V1 -> normalized v4
V2 -> normalized v4
V3 -> migrate to v4
V4 -> parse
```

`save()`：

```text
schemaVersion: 4
```

---

# 75. CLI

### `apps/cli/src/config/schema.ts`

第一阶段保持：

```text
models: string[]
```

也可以兼容：

```yaml
models:
  - model-a
```

内部 Composition 转成 ModelConfig。

第二阶段再开放：

```yaml
models:
  - id: model-a
    override:
      ...
```

避免 Desktop v4 被 CLI 改造阻塞。

---

# 76. Runtime Composition

建议统一增加：

```ts
resolveModelRuntimeConfig({
  providerId,
  model
});
```

供：

```text
Desktop
Server
Scheduler
Workflow
Team
Sub-Agent
Channel
```

使用。

禁止每个 Host 各自算一次。

---

# 77. 请求完整链路

```text
用户选择 Model
       ↓
ProviderConfig.models 查找 ModelConfig
       ↓
resolve effective metadata
       ↓
resolve request output budget
       ↓
EffectiveModelLimits
       │
       ├─ contextWindowTokens
       │
       └─ requestMaxOutputTokens
       ↓
runAgentTurn
       ↓
prepareModelContext
       ↓
ModelRequest
       ↓
Provider adapter
       ↓
max_completion_tokens / max_tokens
```

---

# 78. 自动刷新完整链路

```text
打开设置 / Provider 变化 / 手动刷新
                 ↓
          Provider.listModels()
                 ↓
           DiscoveredModel[]
                 ↓
       Builtin Registry lookup
                 ↓
       Preserve User Override
                 ↓
         resolve ModelConfig[]
                 ↓
         validate metadata
                 ↓
           save config v4
                 ↓
             push config
                 ↓
             Worker 生效
```

---

# 79. 测试方案

## 79.1 Resolver 单元测试

新增：

```text
packages/providers/test/model-metadata.test.ts
```

覆盖：

### Provider 优先

```text
provider > builtin
```

### User 优先

```text
user > provider
```

### Builtin fallback

```text
provider missing -> builtin
```

### Full fallback

```text
provider missing
builtin missing
-> fallback
```

### 字段独立 merge

```text
context from provider
output from builtin
vision from provider
```

---

# 80. Provider Discovery 测试

现有：

```text
packages/providers/test/providers.test.ts
```

新增：

- id-only model；
- context metadata；
- max output metadata；
- tool capability；
- 非法 metadata；
- 重复 Model ID；
- Provider optional fields 缺失；
- OpenRouter-like extended response；
- 普通 OpenAI-compatible response。

---

# 81. Context Manager 回归

现有：

```text
packages/agent/test/context-manager.test.ts
```

新增：

### 模型最大输出大、实际预算小

```text
modelMax = 128K
request  = 8K
```

确保 Context Manager 按：

```text
8K
```

预留，而不是 128K。

---

# 82. Worker 测试

验证：

```text
同 Provider
切 model-a -> model-b
```

对应：

```text
contextWindowTokens
```

立即变化。

例如：

```text
model-a 64K
model-b 1M
```

运行时事件：

```text
context.updated.window
```

必须不同。

---

# 83. Storage Migration 测试

现有：

```text
packages/storage/test/session.test.ts
```

或新增：

```text
packages/storage/test/config-migration.test.ts
```

覆盖：

```text
v1 -> v4
v2 -> v4
v3 -> v4
v4 -> v4
```

重点：

- API Key 状态不丢；
- default Provider 不丢；
- utility model 不丢；
- permission/memory/extensions 不丢；
- v3 Provider limits 不被误标为 user override；
- active model 仍存在。

---

# 84. Renderer 测试

覆盖：

- 自动值展示；
- Provider source badge；
- Builtin source badge；
- Fallback warning；
- 修改 override；
- reset override；
- refresh failure 保留旧模型；
- 当前 model 从 Provider 列表消失；
- metadata stale。

---

# 85. E2E

真实 Electron 离线 E2E 使用 Scripted Provider 增加：

```text
model-a:
context 64K

model-b:
context 1M
```

场景：

1. 启动；
2. Model A 发送消息；
3. 查看 Context Window；
4. 切换 Model B；
5. 再发送；
6. Context Window 必须切换；
7. 重启应用；
8. 元数据仍正确。

---

# 86. 真实 Provider 联调

不放默认 CI。

手工验证：

```text
OpenAI-compatible
OpenRouter-like
DeepSeek
第三方代理
无 metadata 的自建接口
```

验证：

```text
模型发现
Tool Calling
Context
Output Limit
Usage
Compaction
Refresh
Fallback
```

---

# 87. 性能要求

模型列表可能较大。

要求：

```text
metadata merge = O(n)
```

Builtin Registry：

```text
exact Map lookup = O(1)
```

Pattern rules 数量保持较小。

不要：

```text
每渲染一行模型都重新请求 Provider
```

---

# 88. Refresh 并发

同一 Provider 同时只能存在一个 refresh。

推荐：

```ts
Map<providerId, Promise<RefreshResult>>
```

后续调用复用同一个 Promise。

避免：

```text
Settings open
+ user click refresh
+ API key update
```

产生三次 `/models`。

---

# 89. Request Cancellation

模型刷新应支持 AbortSignal。

用户关闭 Settings 或切换 Provider 时：

```text
取消旧 Provider refresh
```

但已经缓存的数据不能被取消操作清空。

---

# 90. Telemetry / Diagnostics

不要求远程 telemetry。

本地 diagnostics 可以记录：

```text
providerId
models discovered count
provider metadata coverage
builtin coverage
fallback count
refresh duration
refresh error category
```

例如：

```text
models=120
context.provider=93
context.builtin=18
context.fallback=9
```

非常有利于后续优化 Registry。

---

# 91. 兼容性原则

## 91.1 旧 Provider

只返回 ID：

```text
仍然可用
```

---

## 91.2 自建 Provider

不认识：

```text
fallback
```

---

## 91.3 用户过去手填参数

v3 migration 后：

```text
不会丢
```

但不锁死自动发现。

---

## 91.4 Runtime

Agent Core API 尽量不改。

这能显著降低回归范围。

---

# 92. 分阶段实施

## Phase 1：数据模型

完成：

```text
ModelConfig
DiscoveredModel
ModelCapabilities
EffectiveModelLimits
Metadata Resolver
Builtin Registry
Fallback
```

测试 Resolver。

---

## Phase 2：Provider Discovery

修改：

```text
listModels(): string[]
        ↓
DiscoveredModel[]
```

保留普通 id-only Provider 兼容。

---

## Phase 3：Storage v4

完成：

```text
v1/v2/v3 -> v4 migration
v4 save/load
```

---

## Phase 4：Runtime

完成：

```text
Provider-level limit
        ↓
Model-level effective limit
```

替换 Worker / Scheduler / Runtime Composition 中所有直接读取。

---

## Phase 5：UI

实现：

```text
自动值
来源
高级 override
reset
refresh
stale
```

---

## Phase 6：自动刷新

加入：

```text
TTL
background refresh
refresh dedupe
failure cache
```

---

## Phase 7：能力联动

可选：

```text
toolCalls
vision
reasoning
structured output
```

真正参与模型路由和请求 validation。

---

# 93. 推荐第一版最小可用范围

如果希望尽快完成，不必一次实现全部能力字段。

第一版只做：

```text
ModelConfig
 ├─ id
 ├─ contextWindowTokens
 ├─ maxOutputTokens
 ├─ defaultOutputTokens
 ├─ metadataSource
 └─ override
```

先解决：

```text
不同模型不同 Context
不同模型不同 Max Output
自动发现
手工 fallback
```

Tool/Vision/Reasoning Capability 第二版再扩展。

---

# 94. 第一版推荐 Schema

为了控制复杂度，MVP 可以采用：

```ts
export const ModelConfigSchema = z.object({
  id: z.string().trim().min(1),

  discovered: z.object({
    contextWindowTokens:
      z.number().int().min(8_192).max(2_000_000),

    maxOutputTokens:
      z.number().int().min(256).max(128_000),

    contextSource:
      z.enum(['provider', 'builtin', 'fallback']),

    maxOutputSource:
      z.enum(['provider', 'builtin', 'fallback']),

    discoveredAt:
      z.string().datetime().optional()
  }).strict(),

  override: z.object({
    contextWindowTokens:
      z.number().int().min(8_192).max(2_000_000).optional(),

    maxOutputTokens:
      z.number().int().min(256).max(128_000).optional(),

    defaultOutputTokens:
      z.number().int().min(256).max(128_000).optional()
  }).strict().optional(),

  defaultOutputTokens:
    z.number().int().min(256).max(128_000)
}).strict();
```

这是我最推荐先落地的一版。

---

# 95. MVP Effective 计算

```ts
export function effectiveModelLimits(
  model: ModelConfig
) {
  const contextWindowTokens =
    model.override?.contextWindowTokens
    ?? model.discovered.contextWindowTokens;

  const modelMaxOutputTokens =
    model.override?.maxOutputTokens
    ?? model.discovered.maxOutputTokens;

  const configuredDefault =
    model.override?.defaultOutputTokens
    ?? model.defaultOutputTokens;

  const requestMaxOutputTokens =
    Math.min(
      configuredDefault,
      modelMaxOutputTokens
    );

  if (
    modelMaxOutputTokens >=
    contextWindowTokens
  ) {
    throw new Error(
      'Invalid model token limits.'
    );
  }

  return {
    contextWindowTokens,
    modelMaxOutputTokens,
    requestMaxOutputTokens
  };
}
```

---

# 96. MVP Discovery

```ts
async function discoverProviderModels(
  provider: DiscoverableModelProvider
): Promise<ModelConfig[]> {
  const remote =
    await provider.listModels();

  return remote.map(item => {
    const builtin =
      lookupBuiltinModel(item.id);

    const context =
      item.contextWindowTokens
      ?? builtin?.contextWindowTokens
      ?? 128_000;

    const maxOutput =
      item.maxOutputTokens
      ?? builtin?.maxOutputTokens
      ?? 8_192;

    return {
      id: item.id,

      discovered: {
        contextWindowTokens: context,
        maxOutputTokens: maxOutput,

        contextSource:
          item.contextWindowTokens
            ? 'provider'
            : builtin?.contextWindowTokens
              ? 'builtin'
              : 'fallback',

        maxOutputSource:
          item.maxOutputTokens
            ? 'provider'
            : builtin?.maxOutputTokens
              ? 'builtin'
              : 'fallback',

        discoveredAt:
          new Date().toISOString()
      },

      defaultOutputTokens:
        Math.min(8_192, maxOutput)
    };
  });
}
```

实际代码不要用 truthy 判断数值，应使用：

```ts
!== undefined
```

上面只用于说明流程。

---

# 97. 保留 Override 的 Refresh

```ts
function mergeRefreshedModels(
  previous: ModelConfig[],
  refreshed: ModelConfig[]
): ModelConfig[] {
  const previousById =
    new Map(
      previous.map(item => [item.id, item])
    );

  return refreshed.map(next => {
    const old =
      previousById.get(next.id);

    return {
      ...next,

      ...(old?.override
        ? { override: old.override }
        : {})
    };
  });
}
```

当前默认模型如果远端消失，需要单独保留为 unavailable，不应直接被此函数删除。

---

# 98. 验收标准

功能验收：

- [ ] 一个 Provider 下不同模型可以保存不同 Context Window；
- [ ] 切模型后下一轮立即使用新 Context Window；
- [ ] 不再要求普通用户手工填写 Context；
- [ ] Provider 提供 metadata 时自动使用；
- [ ] Provider 不提供时自动使用 Builtin；
- [ ] Builtin 不认识时自动使用 fallback；
- [ ] 用户可以 override；
- [ ] refresh 不覆盖 override；
- [ ] reset override 恢复自动值；
- [ ] `max_completion_tokens` 使用 request budget；
- [ ] Context Manager 也使用相同 request budget；
- [ ] model max output 不会被错误当成本次输出预算；
- [ ] v3 配置无损迁移到 v4；
- [ ] metadata refresh 失败不破坏旧配置；
- [ ] API Key 不进入 config.json；
- [ ] Headless 和 Desktop 使用相同 Effective Limits 解析。

---

# 99. 回归验收

必须通过：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:runtime-smoke
pnpm test:e2e:electron
```

并增加针对：

```text
Model metadata
Config v4
Model switching
Output budget
```

的定向测试。

---

# 100. 最终推荐结构

```text
Provider
│
├─ id
├─ protocol
├─ baseUrl
├─ apiKey -> secure storage
│
└─ Models
    │
    ├─ Model A
    │   ├─ discovered
    │   │   ├─ contextWindowTokens
    │   │   ├─ maxOutputTokens
    │   │   └─ source
    │   │
    │   ├─ override
    │   │   ├─ contextWindowTokens?
    │   │   ├─ maxOutputTokens?
    │   │   └─ defaultOutputTokens?
    │   │
    │   └─ defaultOutputTokens
    │
    └─ Model B
        └─ ...
```

运行时：

```text
ModelConfig
     ↓
EffectiveModelLimits
     │
     ├─ contextWindowTokens
     ├─ modelMaxOutputTokens
     └─ requestMaxOutputTokens
              │
              ├─ Context Manager
              └─ Provider Request
```

---

# 101. 最终结论

Jojo 当前已经具备：

```text
Context Manager
Token Budget
Tool Result Reclaim
History Compaction
max_completion_tokens
Output Continuation
Usage Tracking
```

因此不需要重新设计上下文系统。

真正缺失的是：

```text
Model Metadata Discovery
        +
Per-Model Limits
        +
Automatic Resolution
```

推荐最终形成：

```text
远端 Provider Metadata
          ↓
Jojo Builtin Model Registry
          ↓
Conservative Fallback
          ↓
User Override
          ↓
Effective Model Limits
          ↓
Context Manager + Provider
```

其中优先级为：

```text
User Override
    >
Provider Metadata
    >
Builtin Registry
    >
Fallback
```

并将现有：

```text
Provider
 ├─ models: string[]
 ├─ contextWindowTokens
 └─ maxOutputTokens
```

升级为：

```text
Provider
 └─ ModelConfig[]
      ├─ contextWindowTokens
      ├─ modelMaxOutputTokens
      ├─ defaultOutputTokens
      ├─ metadata source
      └─ user override
```

这是与 Jojo 当前架构最兼容、改动边界最清晰，同时也最适合后续扩展 Tool/Vision/Reasoning 能力自动发现的方案。

---

# 102. 推荐实施顺序摘要

```text
1. contracts 增加 ModelConfig / DiscoveredModel
                ↓
2. providers.listModels() 返回 DiscoveredModel[]
                ↓
3. 实现 Model Metadata Resolver
                ↓
4. 实现 Builtin Registry + Fallback
                ↓
5. Storage Schema v3 -> v4
                ↓
6. Worker 按选中 Model 解析 Effective Limits
                ↓
7. Context Manager 使用 requestMaxOutputTokens
                ↓
8. Renderer 改成自动展示 + Advanced Override
                ↓
9. 增加 TTL / Background Refresh
                ↓
10. 后续扩展 Tool / Vision / Reasoning Capability
```

这条路径能把核心改造拆开，每一阶段都可以单独测试和回滚。

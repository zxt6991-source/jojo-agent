# jojo-agent Agent Loop 防无限循环与安全预算最终优化方案

> 状态：Final Design  
> 适用项目：`zxt6991-source/jojo-agent`  
> 参考项目：`open-octo/octo-agent`、`earendil-works/pi`  
> 目标：在不明显削弱 Agent 自主完成复杂任务能力的前提下，防止无限循环、重复工具调用、无进展探索、上下文与资源失控。

---

## 1. 背景

Agent Loop 的典型执行过程如下：

```text
User
  │
  ▼
LLM
  │
  ├─ final response ───────────────► END
  │
  └─ tool calls
        │
        ▼
      Tools
        │
        ▼
     Tool Results
        │
        └──────────────────────────► LLM
```

只要模型持续产生 Tool Call，Agent 就可能不断进入下一轮。

典型失控模式包括：

1. 同一个工具、同一组参数反复调用；
2. 不同工具之间形成 `A → B → A → B` 周期；
3. 查询参数略有变化，但结果信息实际上完全相同；
4. 工具持续报错，模型不断重试；
5. Agent 有少量进展，但持续探索而不收尾；
6. 用户或调用方把 `maxIterations` 配置成极大值；
7. 背景任务轮询被误判成死循环；
8. 上下文窗口、Token、时间或费用持续增长；
9. Agent 达到限制后直接报错，导致已经完成的部分成果无法正常交付。

因此，仅增加一个：

```ts
maxIterations = 20
```

并不能很好地解决 Agent Loop 安全问题。

最终设计应同时解决：

- **绝对不会无限运行**
- **正常复杂任务不会过早被截断**
- **能够识别“无进展”而不是只计算轮数**
- **达到预算后优雅收尾**
- **策略可扩展**
- **不同 Agent / Workflow 可以使用不同预算**
- **工具轮询等合法重复不会被误判**

---

# 2. 三个项目的设计结论

## 2.1 octo-agent

`octo-agent` 当前采用的是：

```text
MaxTurns
+
Repeated Tool Batch Detector
+
Context cancellation
```

核心特点：

### MaxTurns

默认：

```go
const defaultMaxTurns = 1000
```

其意义不是让 Agent 正常执行 1000 轮，而是：

> 作为最后一道 runaway safety fuse，确保 Agent 不会永久循环。

### Stuck Detector

octo-agent 会对 Tool Call 生成 fingerprint：

```text
tool name
+
hash(JSON(args))
```

并记录最近多轮 Tool Batch。

如果连续出现相同 Tool Batch，则返回：

```text
StopReasonStuck
```

因此其实际保护结构是：

```text
                    Agent Loop
                        │
             ┌──────────┴──────────┐
             │                     │
        MaxTurns=1000         Stuck Detector
          最终保险丝          更早发现死循环
             │                     │
             └──────────┬──────────┘
                        ▼
                       STOP
```

octo-agent 还把：

```text
terminal_output
workflow_status
```

等 observation / polling 工具排除在普通重复检测之外，避免正常等待后台任务时被误杀。

### 可借鉴点

jojo-agent 应借鉴：

1. **Absolute Safety Fuse**
2. **跨 iteration 的 Tool Batch Fingerprint**
3. **Polling Tool Exemption**
4. **明确 StopReason**

但不建议直接采用默认 `1000` 作为普通任务预算。

---

## 2.2 pi

pi 的 low-level `agent-loop.ts` 更接近一个：

> 可扩展 Agent Loop kernel

其核心 Loop 本身没有固定 `maxTurns`：

```ts
while (true) {
  while (hasMoreToolCalls || pendingMessages.length > 0) {
    ...
  }

  if (followUpMessages.length > 0) {
    continue;
  }

  break;
}
```

主要通过：

```ts
AbortSignal
shouldStopAfterTurn(...)
tool terminate
prepareNextTurn(...)
```

向上层开放控制能力。

它的思想是：

```text
Agent Loop
   │
   ├─ AbortSignal
   ├─ shouldStopAfterTurn
   ├─ prepareNextTurn
   └─ Harness Policy
```

### 可借鉴点

jojo-agent 最应该借鉴 pi 的不是某个具体轮数，而是：

> **把 Loop 退出策略抽象成 policy seam。**

即不要让所有策略逐渐堆进一个巨大 `runner.ts`：

```ts
if (iteration ...)
if (timeout ...)
if (token ...)
if (cost ...)
if (noProgress ...)
if (cycle ...)
```

而应形成统一的 Guard / Policy 层。

---

## 2.3 jojo-agent 当前状态

当前 jojo-agent 已经实现：

```text
packages/agent/src/iteration-budget.ts
packages/agent/src/tool-execution.ts
packages/agent-runtime/src/harness/runner.ts
```

并具备以下能力：

### 动态 iteration budget

当前默认范围：

```ts
MIN_INITIAL_ITERATIONS = 8
MAX_INITIAL_ITERATIONS = 16

MIN_HARD_ITERATIONS = 32
MAX_HARD_ITERATIONS = 64
```

默认根据：

```text
contextWindowTokens - maxOutputTokens
```

计算 initial budget。

例如：

```text
contextWindowTokens = 128000
maxOutputTokens     =   8192

usableInputTokens   = 119808

119808 / 8192 ≈ 14
```

因此得到：

```text
initial = 14
hard    = 56
step    = 7
```

形成：

```text
14
 ↓ progress
21
 ↓ progress
28
 ↓
35
 ↓
42
 ↓
49
 ↓
56
```

这比固定：

```ts
maxIterations = 20
```

更加适合通用 Agent。

---

### Exact Tool Call 重复检测

当前：

```ts
const MAX_IDENTICAL_TOOL_CALLS = 2;
```

对：

```text
toolName + canonicalJson(input)
```

计数。

第三次相同调用会产生：

```text
code = "no_progress"
```

这是正确方向。

---

### Observation 重复检测

对于：

```text
glob
grep
list_files
load_skill
mcp_tool_manifest
mcp_tool_describe
mcp_list_resources
mcp_list_prompts
read_file
web_fetch
web_search
```

等信息型工具，jojo-agent 已经对返回内容计算 digest。

若同样的信息再次出现，则返回：

```text
no_progress
```

说明 jojo-agent 已经从：

```text
“重复 Tool Call”
```

升级为：

```text
“重复 Observation / 没有信息增益”
```

这比单纯 MaxIterations 更合理。

---

# 3. 当前设计最需要修复的问题

## 3.1 `hardLimit` 还不是 Absolute Safety Limit

当前：

```ts
if (options.maxIterations !== undefined) {
  return {
    dynamic: false,
    currentLimit: options.maxIterations,
    hardLimit: options.maxIterations,
    extensionStep: 0
  };
}
```

意味着调用方可以：

```ts
maxIterations: 1000000
```

最后得到：

```text
currentLimit = 1000000
hardLimit    = 1000000
```

因此：

```ts
MAX_HARD_ITERATIONS = 64
```

并不是真正的安全上限，只是：

> 默认动态预算计算时使用的默认上限。

这是当前最需要修复的问题。

---

# 4. 最终目标架构

推荐 jojo-agent 最终形成四层保护：

```text
┌──────────────────────────────────────────────────────────────┐
│                    Agent Loop Safety                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1  Dynamic Task Budget                                │
│           允许正常 Agent 自主工作                            │
│           initial → progress-based extension                 │
│                                                              │
│  Layer 2  Progress / Cycle Guard                             │
│           exact repeat / observation repeat / A-B cycle      │
│                                                              │
│  Layer 3  Resource Guard                                     │
│           time / token / cost / context                      │
│                                                              │
│  Layer 4  Absolute Safety Fuse                               │
│           不可被普通配置绕过                                 │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

核心原则：

> **正常限制用于调度，绝对限制用于安全。两者必须彻底分开。**

---

# 5. Layer 1：Dynamic Task Budget

继续保留当前动态预算设计。

建议默认参数：

```ts
const DEFAULT_MIN_INITIAL_ITERATIONS = 8;
const DEFAULT_MAX_INITIAL_ITERATIONS = 16;

const DEFAULT_MIN_RUN_LIMIT = 32;
const DEFAULT_MAX_RUN_LIMIT = 64;
```

计算：

```ts
usableInputTokens =
  contextWindowTokens - maxOutputTokens;

initialLimit = clamp(
  Math.floor(usableInputTokens / 8192),
  8,
  16
);

runLimit = clamp(
  initialLimit * 4,
  32,
  64
);

extensionStep =
  Math.max(4, Math.floor(initialLimit / 2));
```

---

## 5.1 为什么保留动态扩展

复杂 Agent 任务可能出现：

```text
read
→ search
→ inspect
→ modify
→ test
→ fix
→ test
→ summarize
```

如果简单设置：

```text
maxIterations = 20
```

会造成两个问题：

1. 简单任务给太多预算；
2. 复杂任务又可能不够。

动态预算可以做到：

```text
没有进展
   ↓
不扩容

持续有真实进展
   ↓
逐步扩容
```

这是比固定 MaxTurns 更合理的设计。

---

# 6. Layer 2：Progress Guard

Progress Guard 应成为 jojo-agent 防循环的主要机制。

最终应覆盖四种模式。

---

## 6.1 Exact Tool Call Repeat

保留当前实现：

```text
toolName
+
canonicalJson(input)
```

建议：

```ts
MAX_IDENTICAL_TOOL_CALLS = 2;
```

行为：

```text
第 1 次：执行
第 2 次：执行
第 3 次：拒绝执行 → no_progress
```

返回：

```ts
{
  ok: false,
  code: "no_progress",
  content:
    "This exact tool call has already run twice in this turn. " +
    "Reuse the existing result, change approach, or explain the limitation."
}
```

---

## 6.2 Duplicate Observation

继续保留：

```text
hash(tool result)
```

但建议逐步从：

```text
hash(raw content)
```

扩展为：

```text
normalized observation fingerprint
```

例如先做：

```ts
normalizeWhitespace
removeTimestampNoise
removeRequestId
removePaginationMetadata
hash(normalizedContent)
```

否则下面内容：

```text
result at 10:01
result at 10:02
```

即使语义完全相同，也会被误认为不同。

---

## 6.3 Tool Batch Repeat

新增 octo-agent 风格的 iteration-level fingerprint。

定义：

```ts
type ToolCallFingerprint = {
  name: string;
  argsHash: string;
};

type IterationFingerprint = {
  tools: ToolCallFingerprint[];
};
```

生成：

```ts
function fingerprintToolCall(call: ToolCall): ToolCallFingerprint {
  return {
    name: call.name,
    argsHash: sha256(canonicalJson(call.input))
  };
}
```

保存：

```ts
recentIterationFingerprints
```

建议最大保存：

```text
12 ~ 16 iterations
```

即可，无需保存完整历史。

---

## 6.4 Cycle Detection

不仅检测：

```text
A A A A
```

还应检测：

```text
A B A B A B
```

以及：

```text
A B C A B C A B C
```

建议支持：

```ts
maxCyclePeriod = 3;
requiredCycleRepeats = 3;
```

即：

```text
周期 1：
A A A

周期 2：
A B A B A B

周期 3：
A B C A B C A B C
```

均视为：

```text
loop_detected
```

---

## 6.5 Polling / Observation Exemption

不能简单把所有重复调用都当成 Loop。

例如：

```text
start_process
terminal_output
terminal_output
terminal_output
```

可能是正常等待后台任务。

因此 Tool Definition 建议增加：

```ts
type ToolRepeatPolicy =
  | "normal"
  | "polling"
  | "idempotent-observation";
```

例如：

```ts
{
  name: "terminal_output",
  repeatPolicy: "polling"
}
```

对于 polling：

- 不参与普通 exact repeat hard reject；
- 不参与普通 batch cycle；
- 但需要自己的 polling budget。

例如：

```ts
maxPollsPerCall = 20;
minPollIntervalMs = 500;
maxPollDurationMs = 120_000;
```

避免：

```text
polling exempt
```

变成另一条无限循环路径。

---

# 7. Progress 的正式定义

当前动态扩容依赖：

```text
lastToolRoundMadeProgress
```

因此必须明确什么叫 Progress。

建议：

```ts
type ProgressSignal =
  | "new_information"
  | "state_changed"
  | "artifact_changed"
  | "task_advanced"
  | "recovery_succeeded"
  | "none";
```

---

## 7.1 可认为有进展

### 新信息

```text
search A → 找到新的文档
read B → 获取之前未见内容
```

### 外部状态改变

```text
git checkout
file write
database mutation
HTTP POST 成功
```

### Artifact 发生变化

```text
代码被修改
文档生成
测试修复
```

### Task 状态推进

```text
todo:
pending → in_progress → completed
```

### Recovery 成功

```text
第一次 build 失败
修改后 build 成功
```

---

## 7.2 不应认为有进展

```text
同样的 read_file
同样的 grep
同样的 web result
同样的错误
相同 build failure
相同 HTTP error
无状态变化的重试
```

---

# 8. Layer 3：Resource Guard

只依赖 iteration 并不足够。

未来建议统一加入：

```text
time
tokens
cost
context
```

四类资源预算。

---

## 8.1 Time Budget

配置：

```ts
maxWallTimeMs?: number;
```

建议默认：

```text
interactive agent: 10 min
background agent:  30~60 min
```

达到后：

```text
stopReason = "time_budget"
```

但 Tool 本身仍应尊重：

```ts
AbortSignal
```

---

## 8.2 Token Budget

建议统计：

```text
input tokens
output tokens
cache read
cache write
```

配置：

```ts
maxTotalTokens?: number;
```

可以防止：

```text
Loop 次数不多
但每轮上下文巨大
```

造成严重资源消耗。

---

## 8.3 Cost Budget

如果 Provider 能返回价格：

```ts
maxCostUsd?: number;
```

特别适合：

```text
background agent
research agent
sub-agent
```

避免失控。

---

## 8.4 Context Budget

已有 Context Manager 应继续负责：

```text
compact
truncate
resume
```

但需要和 Loop Guard 协同。

不要出现：

```text
context overflow
→ compact
→ retry
→ overflow
→ compact
→ retry
→ ...
```

建议额外限制：

```ts
maxCompactionsPerTurn = 3;
```

或：

```text
连续 compaction 没有明显降低 context
→ context_no_progress
```

---

# 9. Layer 4：Absolute Safety Fuse

这是最终方案里必须新增的明确概念。

建议：

```ts
const ABSOLUTE_MAX_ITERATIONS = 128;
```

这个值应该是：

> runtime-level absolute safety limit

普通业务配置不能突破。

---

## 9.1 三种限制必须区分

最终建议不要继续只有：

```ts
maxIterations?: number;
```

而应区分：

```ts
initialIterationLimit
runIterationLimit
absoluteIterationLimit
```

语义：

### initialIterationLimit

Agent 正常获得的首段预算。

例如：

```text
14
```

### runIterationLimit

本任务最多允许动态扩展到。

例如：

```text
64
```

### absoluteIterationLimit

系统安全保险丝。

例如：

```text
128
```

---

## 9.2 安全上限不可直接由普通调用方覆盖

例如：

```ts
requestedMaxIterations = 999999;
```

计算：

```ts
effectiveRunLimit =
  Math.min(
    requestedMaxIterations,
    ABSOLUTE_MAX_ITERATIONS
  );
```

结果：

```text
128
```

而不是：

```text
999999
```

---

## 9.3 真正需要 unlimited 怎么办

不建议：

```ts
maxIterations: -1
```

直接变成 unlimited。

如果未来真的存在：

```text
server-controlled workflow
trusted background runner
evaluation harness
```

需要突破普通安全值，应使用显式能力：

```ts
safetyPolicy: {
  allowExtendedRun: true,
  absoluteMaxIterations: 512
}
```

并且只能从：

```text
trusted runtime configuration
```

注入，而不能来自：

```text
LLM
user prompt
skill
普通 plugin
普通 workflow input
```

---

# 10. 配置模型最终建议

建议重构为：

```ts
export type AgentLoopBudgetOptions = {
  /**
   * Initial model iterations before requiring either progress-based
   * extension or finalization.
   */
  initialIterations?: number;

  /**
   * Maximum normal task budget.
   * Dynamic progress extension cannot exceed this value.
   */
  runMaxIterations?: number;

  /**
   * Whether progress may extend the current budget.
   */
  dynamic?: boolean;

  /**
   * Number of iterations added after meaningful progress.
   */
  extensionStep?: number;

  /**
   * Optional wall-clock budget.
   */
  maxWallTimeMs?: number;

  /**
   * Optional cumulative token budget.
   */
  maxTotalTokens?: number;

  /**
   * Optional provider cost budget.
   */
  maxCostUsd?: number;
};
```

Runtime 另外持有：

```ts
export type AgentLoopSafetyPolicy = {
  absoluteMaxIterations: number;
  maxCyclePeriod: number;
  requiredCycleRepeats: number;
  maxIdenticalToolCalls: number;
  maxCompactionsPerTurn: number;
};
```

默认：

```ts
export const DEFAULT_AGENT_LOOP_SAFETY: AgentLoopSafetyPolicy = {
  absoluteMaxIterations: 128,
  maxCyclePeriod: 3,
  requiredCycleRepeats: 3,
  maxIdenticalToolCalls: 2,
  maxCompactionsPerTurn: 3
};
```

这样：

```text
Budget = 产品策略
Safety = Runtime 安全策略
```

职责清晰。

---

# 11. 引入统一 LoopGuard

这是从 pi 最值得借鉴的部分。

建议：

```ts
export type LoopGuardDecision =
  | {
      action: "continue";
    }
  | {
      action: "extend";
      newLimit: number;
      reason: string;
    }
  | {
      action: "finalize";
      reason: AgentStopReason;
      instruction?: string;
    }
  | {
      action: "stop";
      reason: AgentStopReason;
    };
```

Guard Context：

```ts
export type LoopGuardContext = {
  iteration: number;
  currentLimit: number;
  runLimit: number;
  absoluteLimit: number;

  elapsedMs: number;

  progress: ProgressState;

  recentToolCalls: ToolCallFingerprint[][];
  recentObservations: ObservationFingerprint[];

  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };

  context: {
    estimatedTokens: number;
    compactions: number;
  };
};
```

接口：

```ts
export interface LoopGuard {
  readonly name: string;

  check(
    context: LoopGuardContext
  ): LoopGuardDecision | Promise<LoopGuardDecision>;
}
```

---

# 12. 默认 Guard 组成

```ts
const guards: LoopGuard[] = [
  abortGuard,
  absoluteIterationGuard,
  resourceBudgetGuard,
  noProgressGuard,
  cycleGuard,
  iterationBudgetGuard
];
```

执行顺序建议：

```text
1. abort
2. absolute safety
3. resource safety
4. stuck/no-progress
5. cycle
6. dynamic iteration budget
```

理由：

> Safety Guard 必须优先于普通调度策略。

---

# 13. Guard 决策流程

```text
                 iteration completed
                         │
                         ▼
                  collect metrics
                         │
                         ▼
                    AbortGuard
                         │
              aborted ───┴─── no
               │
               ▼
              STOP
                         │
                         ▼
             AbsoluteIterationGuard
                         │
             exceeded ───┴─── no
               │
               ▼
             FINALIZE
                         │
                         ▼
               ResourceBudgetGuard
                         │
             exceeded ───┴─── no
               │
               ▼
             FINALIZE
                         │
                         ▼
                 NoProgressGuard
                         │
               stuck ────┴─── no
               │
               ▼
             FINALIZE
                         │
                         ▼
                    CycleGuard
                         │
               cycle ────┴─── no
               │
               ▼
             FINALIZE
                         │
                         ▼
              IterationBudgetGuard
                  │             │
             progress         budget
                  │             │
                extend       finalize
                  │             │
                  └──────┬──────┘
                         ▼
                   next iteration
```

---

# 14. 不要直接 Error，应优先进入 Final Response

Agent 达到预算时，不建议：

```text
throw MaxIterationsError
```

因为用户可能已经得到：

```text
90% 完成的调查
已修改的代码
部分生成的文档
测试结果
```

更合理的是：

```text
disable tools
+
inject finalization instruction
+
再允许一次 model response
```

即：

```text
tool-capable loop
      │
      ▼
budget reached
      │
      ▼
tools = []
      │
      ▼
mandatory final response
      │
      ▼
END
```

这和 jojo-agent 当前：

```text
finalResponseOnly
```

方向一致，应正式固化为设计规范。

---

# 15. Finalization Instruction

建议统一内部提示：

```text
The agent loop budget has been reached.

Do not call additional tools.

Provide the best possible final response using the information
and artifacts already produced.

Clearly state:
1. what was completed;
2. what remains incomplete;
3. any important uncertainty or limitation.

Do not claim unfinished work is complete.
```

如果是 loop detected：

```text
Repeated actions are no longer producing meaningful progress.

Do not call additional tools.

Use existing observations and results to produce the best possible
final response. Explain the limitation if the original task cannot
be fully completed.
```

---

# 16. StopReason 统一定义

建议统一为：

```ts
export type AgentStopReason =
  | "completed"
  | "aborted"
  | "max_iterations"
  | "absolute_iteration_limit"
  | "no_progress"
  | "loop_detected"
  | "time_budget"
  | "token_budget"
  | "cost_budget"
  | "context_budget"
  | "provider_error"
  | "tool_error";
```

其中：

```text
max_iterations
```

表示正常 Task Budget 达到。

```text
absolute_iteration_limit
```

表示 Safety Fuse 被触发。

两者必须区别。

---

# 17. Iteration 与 Tool Call 不应混为一个预算

一次 LLM iteration 可能产生：

```text
5 个并行 Tool Calls
```

因此：

```text
iterations = 10
```

并不代表：

```text
tool calls = 10
```

建议未来增加：

```ts
maxToolCalls?: number;
```

例如：

```text
runMaxIterations = 64
maxToolCalls      = 256
```

避免模型每一轮疯狂批量调用工具。

---

# 18. Sub-Agent / Workflow Budget

jojo-agent 未来存在 orchestration / sub-agent 时，应避免：

```text
Parent 64
 ├─ Child A 64
 ├─ Child B 64
 ├─ Child C 64
 └─ Child D 64
```

导致实际：

```text
64 × N
```

失控。

建议引入 Shared Budget：

```ts
type SharedRunBudget = {
  maxModelIterations: number;
  maxToolCalls: number;
  maxTokens?: number;
  maxCostUsd?: number;
};
```

Parent 和 Child 从同一个 pool 消耗。

例如：

```text
Workflow total = 128

Parent   20
Child A  30
Child B  15
Child C  25
----------------
used     90
remain   38
```

而不是每个 Agent 都重新获得完整预算。

---

# 19. 推荐默认 Profile

可以按运行类型提供：

| Profile | Initial | Run Max | Absolute | 说明 |
|---|---:|---:|---:|---|
| `quick` | 8 | 24 | 64 | 简单助手 |
| `default` | 8~16 | 64 | 128 | 通用 Agent |
| `research` | 16 | 96 | 192 | 深度调查 |
| `background` | 16 | 128 | 256 | 受信后台任务 |
| `sub_agent` | 8 | 32 | 64 | 子 Agent |

注意：

> `absolute` 应由 Runtime Profile 提供，而不是模型自行选择。

jojo-agent 默认推荐：

```text
default
```

即：

```text
initial = dynamic 8~16
runMax  = 64
absolute = 128
```

---

# 20. Telemetry

每个 Turn 建议记录：

```ts
{
  operationId,
  iteration,

  currentIterationLimit,
  runIterationLimit,
  absoluteIterationLimit,

  toolCalls,
  repeatedToolCalls,
  duplicateObservations,

  progress,

  elapsedMs,

  contextTokens,
  inputTokens,
  outputTokens,

  stopReason
}
```

这样 UI / 导出轨迹可以显示：

```text
Agent Loop: 37 / 42
Run max: 64
Absolute max: 128

Progress:
  new_information

Loop health:
  repeated calls: 0
  repeated observations: 1
```

---

# 21. Harness 层职责

最终建议：

```text
packages/agent
```

负责：

```text
Agent Loop 基础原语
Tool repeat detection
Iteration budget calculation
LoopGuard interfaces
StopReason
Progress model
```

而：

```text
packages/agent-runtime
```

负责：

```text
Guard composition
Runtime safety policy
Durable state
Resume
Context compaction
Hooks
Workflow / lane integration
Telemetry
```

也就是说：

```text
agent
  = mechanism

agent-runtime
  = policy + durable execution
```

这与 jojo-agent 当前拆分方向是一致的。

---

# 22. 推荐目录结构

```text
packages/
├── agent/
│   └── src/
│       ├── loop/
│       │   ├── budget.ts
│       │   ├── progress.ts
│       │   ├── fingerprint.ts
│       │   ├── cycle-detector.ts
│       │   ├── stop-reason.ts
│       │   └── guards/
│       │       ├── types.ts
│       │       ├── iteration-guard.ts
│       │       ├── no-progress-guard.ts
│       │       └── cycle-guard.ts
│       │
│       ├── tool-execution.ts
│       └── ...
│
└── agent-runtime/
    └── src/
        ├── harness/
        │   ├── runner.ts
        │   ├── loop-policy.ts
        │   └── ...
        │
        └── ...
```

不建议继续把所有 Loop Safety 代码塞进：

```text
runner.ts
```

---

# 23. 第一阶段改造：必须做

## M1：真正安全硬上限

目标：

```text
任何普通 maxIterations 配置都无法突破 runtime absolute limit
```

新增：

```ts
const ABSOLUTE_MAX_ITERATIONS = 128;
```

修复：

```ts
if (options.maxIterations !== undefined)
```

绕过默认 hard limit 的问题。

验收：

```ts
maxIterations = 1_000_000
```

最终：

```text
effective <= 128
```

---

## M2：Tool Batch Fingerprint

新增：

```text
recentIterationFingerprints
```

检测：

```text
A A A
```

和：

```text
A B A B A B
```

---

## M3：Polling Policy

Tool Definition 增加：

```ts
repeatPolicy
```

至少：

```text
normal
polling
```

Polling Tool 自己控制：

```text
max polls
poll interval
poll duration
```

---

# 24. 第二阶段改造：推荐做

## M4：统一 LoopGuard

把：

```text
iteration
progress
cycle
timeout
token
cost
```

逐步迁移到统一 Guard。

---

## M5：Resource Budget

增加：

```text
maxWallTime
maxTokens
maxCost
maxToolCalls
```

---

## M6：Shared Workflow Budget

Parent / Child Agent 使用统一资源池。

---

# 25. 第三阶段改造：增强项

## M7：Semantic Progress

当前：

```text
hash result
```

只能发现完全相同内容。

未来可以引入：

```text
semantic observation similarity
```

但不建议第一阶段就使用 embedding。

先使用：

```text
normalize
+
stable digest
+
state transition
```

已经足够。

---

## M8：Adaptive Budget

未来可以根据：

```text
task complexity
tool count
workflow type
model
context window
```

调整：

```text
initial budget
extension step
run max
```

但：

```text
absolute safety fuse
```

仍必须独立存在。

---

# 26. 必须补的测试

## 26.1 Absolute Limit

```text
maxIterations = 999999
```

期望：

```text
不会突破 absolute limit
```

---

## 26.2 Exact Repeat

```text
read_file(a)
read_file(a)
read_file(a)
```

期望：

```text
第三次 no_progress
```

---

## 26.3 Period-1 Loop

```text
A
A
A
```

期望：

```text
loop_detected
```

---

## 26.4 Period-2 Loop

```text
A B A B A B
```

期望：

```text
loop_detected
```

---

## 26.5 Period-3 Loop

```text
A B C A B C A B C
```

期望：

```text
loop_detected
```

---

## 26.6 Polling

```text
start process
poll
poll
poll
```

期望：

```text
不被 ordinary cycle detector 错误停止
```

但超过：

```text
polling budget
```

应停止。

---

## 26.7 Progress Extension

```text
initial = 8
```

每轮均有真实 progress。

期望：

```text
8 → 12 → 16 ...
```

但：

```text
<= runMax
```

---

## 26.8 Final Response

达到：

```text
max_iterations
```

期望：

```text
工具关闭
模型再执行一次 tool-free final response
```

而不是直接抛异常。

---

## 26.9 Abort

任意阶段：

```text
AbortSignal.abort()
```

期望：

```text
LLM / Tool / Loop 尽快终止
```

---

## 26.10 Resume

如果 Operation 已持久化：

```text
iteration
current limit
run limit
progress state
```

Resume 后不得：

```text
重新获得完整预算
```

否则可以通过 crash/resume 绕过限制。

---

# 27. Resume 安全语义

这一点非常重要。

持久化 Operation 必须保存：

```ts
{
  iteration,
  currentIterationLimit,
  runIterationLimit,
  absoluteIterationLimit,

  toolCallCounts,
  recentIterationFingerprints,

  resourceUsage
}
```

至少 Safety Budget 不应在 Resume 后重置。

否则：

```text
运行到 120
crash
resume
重新从 0 开始
```

就可以绕过：

```text
absolute = 128
```

正确语义：

```text
resume
=
继续原 operation budget
```

而不是：

```text
new run
```

---

# 28. 最终推荐参数

jojo-agent 默认建议：

```ts
const DEFAULT_LOOP_POLICY = {
  initialIterations: "dynamic: 8~16",

  runMaxIterations: 64,

  absoluteMaxIterations: 128,

  extensionStep: "dynamic: >=4",

  maxIdenticalToolCalls: 2,

  maxCyclePeriod: 3,

  requiredCycleRepeats: 3,

  maxCompactionsPerTurn: 3
};
```

另外逐步增加：

```ts
maxToolCalls: 256
maxWallTimeMs: 10 * 60 * 1000
```

Token / Cost 可作为可选配置。

---

# 29. 与三个项目的最终关系

最终 jojo-agent 不应完全复制任何一个项目。

推荐组合：

```text
                         jojo-agent
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
        pi                  octo               jojo
         │                   │                   │
 Policy seam           stuck detector      dynamic budget
 AbortSignal           batch fingerprint   observation dedupe
 Harness design        safety fuse          no-progress
         │                   │                   │
         └───────────────────┼───────────────────┘
                             ▼
                    Unified Loop Guard
```

---

# 30. 最终结论

jojo-agent 当前方向是正确的，而且已经比简单 `MaxTurns` 方案更先进。

当前已有：

```text
动态 iteration budget
progress extension
exact tool repeat detection
duplicate observation detection
mandatory final response
AbortSignal
context control
```

因此不需要推翻现有实现。

最终优化重点应是：

### 第一优先级

```text
把普通 maxIterations
与
runtime absolute safety limit
彻底分离
```

---

### 第二优先级

增加：

```text
iteration-level tool batch fingerprint
+
A-B / A-B-C cycle detection
```

解决目前 exact Tool Call 检测覆盖不到的循环。

---

### 第三优先级

将：

```text
iteration
progress
cycle
timeout
token
cost
context
```

逐步抽象到：

```text
LoopGuard
```

形成和 pi 类似的 policy seam。

---

### 第四优先级

为：

```text
polling tools
sub-agent
workflow
resume
```

定义单独的预算语义，防止绕过主 Loop 限制。

最终推荐模型：

```text
Dynamic Task Budget
        +
Progress Guard
        +
Cycle Detector
        +
Resource Guard
        +
Absolute Safety Fuse
        +
Tool-free Finalization
```

这套结构既能保证：

> **Agent 不会无限循环**

又能避免：

> **复杂任务因为一个过小的固定 MaxTurns 被粗暴截断**

更适合 jojo-agent 作为通用 Agent Runtime 的长期架构。

---

# 31. 参考实现

- jojo-agent  
  https://github.com/zxt6991-source/jojo-agent

- octo-agent  
  https://github.com/open-octo/octo-agent

- pi  
  https://github.com/earendil-works/pi

重点参考路径：

```text
jojo-agent
packages/agent/src/iteration-budget.ts
packages/agent/src/tool-execution.ts
packages/agent-runtime/src/harness/runner.ts

octo-agent
internal/agent/agent.go

pi
packages/agent/src/agent-loop.ts
packages/agent/src/agent.ts
packages/agent/src/harness/
```

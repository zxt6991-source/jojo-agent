# Jojo 通用 Agent Runtime / Harness 最终技术方案

> 文档状态：Final Design  
> 日期：2026-08-20  
> 目标：将 Jojo 从桌面 Coding Agent 演进为可复用的**通用 Agent Framework / Durable Agent Runtime**  
> 参考：`earendil-works/pi` Harness 设计思想 + Jojo 当前 Agent Core / Workflow / Sub-Agent / JSONL Resume 经验  
> 核心结论：**Harness 不应长期放在 `agent-core/src/harness`，应独立为 `packages/agent-runtime`。**

---

# 1. 结论

如果 Jojo 的长期目标是一个**通用 Agent Framework**，而不是只服务于 Coding Agent，那么不建议把 Harness 长期放在：

```text
packages/agent-core/src/harness/
```

推荐最终结构：

```text
packages/
├── contracts/
├── agent/
├── agent-runtime/
├── orchestration/
├── providers/
├── storage/
├── tools-*/
├── extensions/
└── apps/
```

其中：

```text
agent
=
Agent 基础语义与低层执行 primitive

agent-runtime
=
Agent 的 durable execution runtime

orchestration
=
多个 Agent / Workflow 的调度与编排
```

`AgentHarness` 应当是：

```text
@jojo/agent-runtime
```

对外暴露的核心 Facade，而不是单独成为一个 `packages/harness` 顶级库。

长期依赖方向：

```text
contracts
   ↑
 agent
   ↑
agent-runtime
   ↑
orchestration
```

最终目标：

```text
通用 Agent Runtime
      │
      ├── Coding Agent
      ├── Research Agent
      ├── Browser Agent
      ├── Desktop Agent
      ├── Data Agent
      ├── Customer Service Agent
      └── Personal Assistant
```

Runtime 本身不应硬编码：

```text
Git
workingDirectory
terminal
filesystem
browser
Electron
```

这些都属于具体 Tool、Adapter 或 Application。

---

# 2. 为什么需要独立 `agent-runtime`

Jojo 当前 `agent-core` 已经解决：

```text
User
  ↓
Model
  ↓
Assistant Tool Call
  ↓
Permission
  ↓
Tool
  ↓
Tool Result
  ↓
Model
  ↓
...
```

它解决的是：

> Agent 如何进行一次模型调用、工具调用和多轮循环。

而 Harness / Runtime 解决的是另一层问题：

```text
现在执行到哪里？
崩溃后从哪里恢复？
这个 Tool 是否已经执行？
这个 Tool 能不能重放？
当前 Session 在哪个分支？
哪个 Lane 正在运行？
Context 如何从 durable history 构造？
Operation 如何取消？
Usage 如何记录？
```

因此应该拆层。

---

# 3. 包职责

## 3.1 `agent`

`agent` 尽量保持轻量。

负责：

```text
Message
Model
Provider abstraction
Tool
ToolCall
ToolResult
Model Step
Tool execution primitive
Agent Loop primitive
```

可以理解为：

> Agent 的基础语义和低层执行指令集。

不负责：

```text
Session
Lane
Crash Recovery
Durable State
Workflow
SQLite
Electron
```

---

## 3.2 `agent-runtime`

负责：

```text
AgentHarness
Session
Entry Tree
Lane
Operation
Interpreter
Effect
Recovery
Durable State
Compaction
Context Builder
Approval
Events
Hooks
Usage
Queue（后续）
```

可以理解为：

> Agent 的运行时内核。

---

## 3.3 `orchestration`

负责：

```text
Workflow DAG
Multi-Agent
Sub-Agent Supervisor
Scheduler
Dependency
Retry
foreach
condition
Resource Limit
Budget
```

正确关系：

```text
Workflow / Multi-Agent
        ↓
Agent Runtime
        ↓
Agent
```

而不是把 Workflow 也塞进 `AgentHarness`。

---

# 4. 最终包结构

推荐长期演进到：

```text
packages/
│
├── contracts/
│
├── agent/
│   ├── messages/
│   ├── model/
│   ├── tools/
│   ├── loop/
│   └── index.ts
│
├── agent-runtime/
│   ├── harness/
│   ├── operation/
│   ├── session/
│   ├── effects/
│   ├── context/
│   ├── recovery/
│   ├── events/
│   ├── hooks/
│   ├── usage/
│   └── index.ts
│
├── orchestration/
│   ├── workflow/
│   ├── multi-agent/
│   ├── scheduler/
│   └── resources/
│
├── providers/
│   ├── openai/
│   ├── anthropic/
│   ├── gemini/
│   └── ...
│
├── storage/
│   ├── jsonl/
│   ├── sqlite/
│   └── memory/
│
├── tools-node/
├── tools-web/
├── tools-browser/
├── tools-mcp/
│
├── extensions/
│
└── apps/
    ├── desktop/
    ├── cli/
    └── server/
```

第一阶段不需要一次拆完，只需要真正新增：

```text
packages/agent-runtime/
```

---

# 5. 依赖规则

推荐：

```text
agent-runtime
    ↓
agent
```

```text
orchestration
    ↓
agent-runtime
```

具体 Provider、Storage、Tool、UI 都通过接口注入。

禁止：

```text
agent
↓
agent-runtime
```

禁止：

```text
agent-runtime
↓
Electron
```

禁止：

```text
agent-runtime
↓
Git / Filesystem / Terminal / Browser
```

禁止：

```text
agent-runtime
↓
OpenAI SDK
```

禁止：

```text
agent-runtime
↓
SQLite implementation
```

Runtime 只依赖抽象接口。

---

# 6. 通用 Agent Runtime 的最小核心

真正通用的核心不是：

```text
Workspace
Git
Terminal
File
Browser
```

而是：

```text
Session
Entry
Lane
Operation
Action
Effect
Model
Tool
Context
Runtime Store
```

---

# 7. Session

Session 表示：

> 一组持续存在的 Agent conversation 与 runtime state 的逻辑边界。

推荐：

```ts
export type Session = {
  id: string;
  createdAt: number;
  metadata?: Record<string, JsonValue>;
};
```

Coding Agent 可以：

```ts
metadata: {
  workspaceId: 'xxx',
  workingDirectory: '/repo'
}
```

Research Agent 可以：

```ts
metadata: {
  researchProjectId: 'xxx'
}
```

Customer Service Agent 可以：

```ts
metadata: {
  tenantId: 'xxx',
  customerId: 'xxx'
}
```

Runtime 不解释这些字段。

---

# 8. Entry

Entry 是 durable conversation tree 中的不可变节点。

```ts
export interface EntryBase {
  id: string;
  sessionId: string;
  seq: number;
  parentId: string | null;
  createdAt: number;
}
```

建议：

```ts
export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ActiveToolsChangeEntry
  | CustomEntry;
```

---

# 9. Conversation Tree

不再把 Conversation 只理解为：

```text
Message[]
```

而是：

```text
A
│
B
├───────────┐
│           │
C           D
│           │
E           F
```

这样可以天然支持：

```text
Main Agent
Child Agent
Workflow Agent Step
Branch
Retry Branch
Alternative Path
```

并共享共同历史。

---

# 10. Lane

Lane 是：

> Session Tree 上的一个命名游标。

```ts
export type LaneState = {
  sessionId: string;
  name: string;
  leafId: string | null;
  currentOperationId: string | null;
};
```

示例：

```text
main

agent:explore:123

agent:review:456

workflow:wf_1:step_research
```

Runtime 不理解：

```text
explore
review
coding
browser
```

这些只是上层语义。

---

# 11. Operation

Operation 表示：

> 一次已经被 Runtime 接受、能够持久化和恢复的工作。

V1：

```ts
export type OperationKind =
  | 'run'
  | 'compaction';
```

未来可扩展：

```ts
export type OperationKind =
  | 'run'
  | 'compaction'
  | 'navigation';
```

---

# 12. Operation Meta 与 State

建议：

```text
OperationMeta
=
immutable

OperationState
=
mutable durable program counter
```

---

## 12.1 OperationMeta

```ts
export type OperationMeta = {
  id: string;
  sessionId: string;
  lane: string;
  kind: OperationKind;
  createdAt: number;

  providerId: string;
  model: string;

  maxIterations: number;

  config?: Record<string, JsonValue>;
};
```

---

# 13. OperationState

推荐第一版：

```ts
export type OperationState =
  | ReadyState
  | ModelPendingState
  | ToolsState
  | CheckpointState
  | FinalResponseState
  | CompletedState
  | FailedState
  | AbortedState
  | SuspendedState;
```

---

# 14. ReadyState

```ts
export type ReadyState = {
  phase: 'ready';

  operationId: string;
  lane: string;

  iteration: number;
  outputContinuations: number;

  progress: ProgressState;
};
```

---

# 15. ModelPendingState

```ts
export type ModelPendingState = {
  phase: 'model_pending';

  operationId: string;
  lane: string;

  iteration: number;

  responseEntryId: string;
  usageId: string;

  request: {
    providerId: string;
    model: string;
    toolNames: string[];
    maxOutputTokens: number;
  };

  attempt: number;
};
```

关键原则：

```text
responseEntryId
usageId
```

必须在请求 Provider 前生成并 durable。

---

# 16. ToolsState

```ts
export type ToolsState = {
  phase: 'tools';

  operationId: string;
  lane: string;

  iteration: number;

  assistantEntryId: string;

  calls: ToolCallExecutionState[];

  currentIndex: number;
};
```

---

# 17. ToolCallExecutionState

```ts
export type ToolCallExecutionState = {
  toolIndex: number;

  callId: string;
  toolName: string;
  input: JsonValue;

  resultEntryId: string;

  replay: 'safe' | 'never';

  permission:
    | 'not_required'
    | 'pending'
    | 'approved'
    | 'denied';

  status:
    | 'planned'
    | 'effect_pending'
    | 'completed'
    | 'interrupted';

  result?: AgentToolResult;
};
```

---

# 18. CheckpointState

```ts
export type CheckpointState = {
  phase: 'checkpoint';

  operationId: string;
  lane: string;

  iteration: number;
  outputContinuations: number;

  progress: ProgressState;
};
```

含义：

```text
前一个 Model / Tool step 已完整 settle
可以安全决定下一步
```

---

# 19. FinalResponseState

```ts
export type FinalResponseState = {
  phase: 'final_response';

  operationId: string;
  lane: string;

  iteration: number;

  reason:
    | 'no_progress'
    | 'max_iterations'
    | 'tool_disabled';
};
```

进入后：

```text
tools = []
```

只允许模型返回最终文本。

---

# 20. Terminal States

```ts
export type CompletedState = {
  phase: 'completed';

  operationId: string;
  lane: string;

  stopReason: string;
  finalEntryId: string | null;
};
```

```ts
export type FailedState = {
  phase: 'failed';

  operationId: string;
  lane: string;

  error: RuntimeError;
};
```

```ts
export type AbortedState = {
  phase: 'aborted';

  operationId: string;
  lane: string;

  reason: string;
};
```

---

# 21. SuspendedState

通用 Runtime 必须有 suspended。

典型场景：

```text
Provider 丢失
Tool 丢失
Credential 不可用
Plugin 未连接
外部依赖缺失
需要人工决定
```

```ts
export type SuspendedState = {
  phase: 'suspended';

  operationId: string;
  lane: string;

  reason:
    | 'provider_unavailable'
    | 'tool_unavailable'
    | 'credential_required'
    | 'external_dependency_unavailable'
    | 'manual_recovery_required';

  detail?: JsonValue;
};
```

---

# 22. Durable Program Counter

不要依赖：

```text
Message History
```

猜程序执行到了哪里。

真正的 Runtime Program Counter 应该是：

```text
OperationState
```

例如：

```text
phase = tools
currentIndex = 1
call[1].status = effect_pending
replay = never
```

这已经可以明确表达：

> 第二个 Tool 可能已经产生了外部副作用，但尚未 durable settlement。

---

# 23. Interpreter

当前传统实现：

```ts
for (...) {
  runModel();
  runTools();
}
```

长期应改成：

```text
State
  ↓
Interpreter
  ↓
Action
  ↓
Executor
  ↓
New State
```

---

# 24. AgentAction

```ts
export type AgentAction =
  | { type: 'request_model' }

  | { type: 'request_model_without_tools' }

  | {
      type: 'request_approval';
      callId: string;
    }

  | {
      type: 'prepare_tool_effect';
      callId: string;
    }

  | {
      type: 'execute_tool';
      callId: string;
    }

  | {
      type: 'synthesize_interrupted_tool_result';
      callId: string;
    }

  | { type: 'advance_tool' }

  | { type: 'compact_context' }

  | { type: 'finish' };
```

---

# 25. Interpreter 必须尽量纯

```ts
export interface AgentInterpreter {
  peekAction(
    state: OperationState,
    context: InterpreterContext
  ): AgentAction | undefined;
}
```

Interpreter 不负责：

```text
请求 Provider
执行 Tool
读写数据库
等待 UI
修改 Session
```

它只负责：

> 根据当前 durable state 推导下一步 Action。

---

# 26. AgentHarness

Harness 是 Runtime 的对外入口。

```ts
export interface AgentHarness {
  getLane(name: string): AgentLane;

  createLane(
    options: CreateLaneOptions
  ): Promise<AgentLane>;

  resume(
    operationId: string
  ): Promise<AgentRunResult>;

  abort(
    operationId: string
  ): Promise<void>;

  getOperation(
    operationId: string
  ): Promise<OperationState | null>;
}
```

---

# 27. AgentLane

建议把用户主要 API 放在 Lane 上。

```ts
export interface AgentLane {
  readonly name: string;

  prompt(
    input: AgentPromptInput
  ): Promise<AgentRunResult>;

  compact(
    input?: CompactInput
  ): Promise<void>;

  resume(): Promise<AgentRunResult>;

  abort(): Promise<void>;

  getSnapshot(): Promise<LaneSnapshot>;
}
```

未来可增加：

```text
steer
followUp
nextRun
navigate
```

但不作为 V1 必需。

---

# 28. 通用调用示例

```ts
const harness =
  await AgentHarness.create({
    session,
    store,
    registry,
    contextBuilder
  });

const main =
  harness.getLane('main');

const result =
  await main.prompt({
    text: 'Analyze the current market trend.',
    providerId: 'openai',
    model: 'gpt-x',
    tools: [
      'web_search',
      'web_fetch'
    ]
  });
```

这里不出现：

```text
workingDirectory
git
terminal
Electron
```

所以 Runtime 可用于任意 Agent。

---

# 29. Tool 抽象

```ts
export interface AgentTool {
  name: string;

  description: string;

  inputSchema: JsonSchema;

  replay?: 'safe' | 'never';

  execute(
    input: JsonValue,
    context: ToolExecutionContext
  ): Promise<AgentToolResult>;
}
```

---

# 30. ToolExecutionContext

不要固定为：

```text
workingDirectory
```

推荐：

```ts
export type ToolExecutionContext = {
  sessionId: string;
  operationId: string;
  lane: string;

  signal: AbortSignal;

  runtimeContext?: unknown;
};
```

Coding App 可以注入：

```ts
runtimeContext: {
  workingDirectory,
  gitRoot
}
```

CRM Agent 可以注入：

```ts
runtimeContext: {
  tenantId,
  customerId
}
```

Runtime 不解释。

---

# 31. Replay Policy

所有 Tool 都通过 metadata 声明：

```ts
replay: 'safe' | 'never'
```

---

## 31.1 Safe

表示：

> 在崩溃后无法确认前一次执行状态时，重新执行不会造成危险副作用。

常见：

```text
read
query
search
lookup
list
pure computation
```

---

## 31.2 Never

表示：

> effect 状态不确定时，不自动重放。

常见：

```text
send email
delete
create order
submit form
write
post message
payment
mutating browser action
```

Runtime 不根据 Tool 名称写特判。

---

# 32. Effect Sandwich

所有重要外部 Effect 统一使用：

```text
Durable Intent
      ↓
External Effect
      ↓
Durable Settlement
```

这是 Crash Safety 的核心。

---

# 33. Tool Effect Sandwich

```text
persist:

status = effect_pending
replay = ...
resultEntryId = ...

        ↓

tool.execute(...)

        ↓

persist:

tool result entry
status = completed
next OperationState
```

---

# 34. 为什么必须 Intent-first

错误方式：

```text
execute effect
↓
crash
↓
persist result
```

如果崩溃发生在中间：

```text
effect 可能已经发生
但磁盘没有任何程序状态
```

正确方式：

```text
persist effect_pending
↓
execute effect
```

这样重启至少知道：

> 该 effect 可能已经发生。

---

# 35. Tool Crash Recovery

| durable 状态 | replay=safe | replay=never |
|---|---|---|
| `planned` | 正常执行 | 正常执行 |
| `effect_pending` | 自动重放 | 不自动重放 |
| `completed` | 不重放 | 不重放 |

---

# 36. Never-Replay 恢复

当：

```text
effect_pending
+
replay = never
```

恢复时生成 synthetic Tool Result：

```ts
{
  ok: false,

  code: 'interrupted_uncertain_effect',

  content:
    'The previous process stopped while this tool effect was pending. ' +
    'The effect may already have occurred, so the runtime did not replay it automatically.'
}
```

然后由模型通过 read-only Tool 检查外部状态并继续。

---

# 37. Exactly Once 不是目标

Runtime 不应承诺：

```text
exactly-once external effects
```

正确目标：

```text
safe replay where possible

+

at-most-once automatic replay for unsafe tools

+

explicit uncertainty
```

---

# 38. Model 也是 Effect

Provider Request 同样：

```text
intent
↓
request
↓
settlement
```

---

# 39. Model Pending

请求 Provider 前持久化：

```text
phase = model_pending
responseEntryId
usageId
providerId
model
attempt
```

---

# 40. Stream

V1 不做 token-by-token durable。

建议：

```text
Partial stream
=
ephemeral UI state
```

完整 Assistant Response 获得后：

```text
assistant Entry
+
usage
+
next OperationState
```

一起 settlement。

---

# 41. Model Crash Recovery

如果重启时：

```text
phase = model_pending
```

V1：

```text
允许重试 Provider Request
```

但记录：

```text
recovered retry
```

并接受可能产生重复 Provider cost。

未来支持：

```text
request id
idempotency key
deferred response
```

时可增强。

---

# 42. Permission / Approval

通用 Runtime 不应该认识：

```text
terminal approval
file approval
email approval
payment approval
```

而只定义：

```ts
export type PermissionDecision =
  | { type: 'allow' }

  | {
      type: 'deny';
      reason?: string;
    }

  | {
      type: 'ask';
      request: PermissionRequest;
    };
```

---

# 43. PermissionPolicy

```ts
export interface PermissionPolicy {
  evaluate(
    request: ToolPermissionRequest
  ): Promise<PermissionDecision>;
}
```

应用决定：

```text
哪些 Tool 自动允许
哪些 Tool 拒绝
哪些 Tool 必须用户批准
```

---

# 44. Durable Approval

如果：

```text
permission = pending
```

Worker 崩溃，重启后恢复同一个 Approval。

不能重新生成一个新的 Tool Call。

---

# 45. Approval 与 Replay 分离

用户批准：

```text
approved
```

不等于：

```text
effect 肯定没有发生
```

所以：

```text
approved
+
effect_pending
+
replay=never
```

恢复后依然不能自动重放。

---

# 46. Runtime Registry

Runtime 不持久化 JS Object。

只持久化：

```text
providerId
toolName
model
```

恢复后通过 Registry 解析。

---

# 47. Registry

```ts
export interface RuntimeRegistry {
  getProvider(
    id: string
  ): ModelProvider | undefined;

  getTool(
    name: string
  ): AgentTool | undefined;
}
```

---

# 48. Provider / Tool 缺失

恢复时：

```text
provider unavailable
```

或：

```text
tool unavailable
```

Operation 进入：

```text
suspended
```

而不是偷偷换实现或直接重放。

---

# 49. History 与 Context 分离

核心原则：

```text
Durable Conversation History
≠
Provider Context
```

History 保存完整事实。

Provider Context 是动态 projection。

---

# 50. Context 构建

```text
Session Tree
↓
Lane Path
↓
Context Builder
↓
Projection
↓
Compaction
↓
Provider Messages
```

---

# 51. ContextBuilder

```ts
export interface ContextBuilder {
  build(
    input: BuildContextInput
  ): Promise<ModelContext>;
}
```

Runtime 不要求：

```text
Context == 原始 Message[]
```

---

# 52. Durable Compaction

Compaction 应是 Entry。

```ts
export type CompactionEntry = EntryBase & {
  type: 'compaction';

  summary: string;

  retainedTail: AgentMessage[];

  tokensBefore: number;

  usage?: UsageRecord;
};
```

---

# 53. Compaction 语义

例如：

```text
A
B
C
COMP1
D
E
```

Provider Context：

```text
COMP1.summary
+
COMP1.retainedTail
+
D
+
E
```

而不是物理删除：

```text
A
B
C
```

这样 durable history 保持完整。

---

# 54. Custom Entry

为了通用扩展：

```ts
export type CustomEntry = EntryBase & {
  type: 'custom';

  namespace: string;

  payload: JsonValue;
};
```

再由 Entry Projector 决定是否进入模型 Context。

---

# 55. `agent-runtime` 目录

最终推荐：

```text
packages/agent-runtime/src/

├── harness/
│   ├── agent-harness.ts
│   ├── agent-lane.ts
│   ├── factory.ts
│   └── types.ts
│
├── operation/
│   ├── meta.ts
│   ├── state.ts
│   ├── actions.ts
│   ├── interpreter.ts
│   ├── reducer.ts
│   └── invariants.ts
│
├── effects/
│   ├── model-effect.ts
│   ├── tool-effect.ts
│   ├── approval-effect.ts
│   └── types.ts
│
├── session/
│   ├── entries.ts
│   ├── session.ts
│   ├── lane.ts
│   └── tree.ts
│
├── context/
│   ├── builder.ts
│   ├── projection.ts
│   ├── compaction.ts
│   └── tokens.ts
│
├── recovery/
│   ├── recover-operation.ts
│   └── recover-session.ts
│
├── events/
│   ├── event-bus.ts
│   └── types.ts
│
├── hooks/
│   └── types.ts
│
├── usage/
│   └── types.ts
│
├── store.ts
├── registry.ts
└── index.ts
```

---

# 56. 为什么不叫 `packages/harness`

不推荐：

```text
packages/harness/
```

因为 Harness 容易被理解为：

```text
test harness
evaluation harness
integration harness
```

而这里实际承担：

```text
Session
Operation
Recovery
Effects
Context
Durability
```

所以包名应是：

```text
agent-runtime
```

`AgentHarness` 只是 Runtime 的主要 Facade。

---

# 57. `agent` 目录

建议最终把当前 `agent-core` 收敛为：

```text
packages/agent/
```

例如：

```text
packages/agent/src/

├── message.ts
├── tool.ts
├── model.ts
├── provider.ts
├── loop/
│   ├── model-step.ts
│   ├── tool-step.ts
│   └── loop.ts
└── index.ts
```

---

# 58. `agent` 不应该包含

```text
Session
JSONL
SQLite
Crash Recovery
Lane
Workflow
Electron
Git
Working Directory
```

---

# 59. Runtime Store Interface

Runtime 定义接口，不依赖具体 Storage。

```ts
export interface AgentRuntimeStore {
  createSession(
    session: Session
  ): Promise<void>;

  getSession(
    sessionId: string
  ): Promise<Session | null>;

  appendEntry(
    input: AppendEntryInput
  ): Promise<SessionEntry>;

  getEntry(
    id: string
  ): Promise<SessionEntry | null>;

  readPath(
    leafId: string | null
  ): Promise<SessionEntry[]>;

  getLane(
    sessionId: string,
    lane: string
  ): Promise<LaneState | null>;

  saveLane(
    lane: LaneState
  ): Promise<void>;

  startOperation(
    meta: OperationMeta,
    initialState: OperationState
  ): Promise<void>;

  loadOperation(
    operationId: string
  ): Promise<{
    meta: OperationMeta;
    state: OperationState;
  } | null>;

  saveOperationState(
    state: OperationState
  ): Promise<void>;

  appendUsage(
    usage: UsageRecord
  ): Promise<void>;
}
```

---

# 60. Storage Adapter

实现：

```text
MemoryAgentRuntimeStore
JsonlAgentRuntimeStore
SqliteAgentRuntimeStore
```

全部实现同一个接口。

---

# 61. 避免循环依赖

不要：

```text
agent-runtime
↓
storage

storage
↓
agent-runtime
```

更好的方式：

```text
agent-runtime
```

定义：

```text
AgentRuntimeStore
```

然后 `storage` 包实现接口。

Composition Root：

```ts
const store =
  new SqliteAgentRuntimeStore(...);

const harness =
  await AgentHarness.create({
    store,
    ...
  });
```

---

# 62. V1 Storage

第一阶段建议继续 JSONL。

因为 Jojo 当前已有：

```text
JsonlSessionStore
JsonlWorkflowStore
```

并已经具备：

```text
尾部损坏恢复
snapshot
resume
```

经验。

---

# 63. V1 Runtime Journal

可以新增：

```text
runtime/
  <sessionId>.jsonl
```

Record：

```ts
export type RuntimeRecord =
  | {
      schemaVersion: 1;

      type: 'operation.started';

      operationId: string;

      meta: OperationMeta;

      state: OperationState;

      createdAt: number;
    }

  | {
      schemaVersion: 1;

      type: 'operation.state';

      operationId: string;

      state: OperationState;

      createdAt: number;
    }

  | {
      schemaVersion: 1;

      type: 'operation.completed';

      operationId: string;

      state: CompletedState;

      createdAt: number;
    };
```

---

# 64. Snapshot 优先

每个：

```text
operation.state
```

保存：

```text
完整 OperationState
```

而不是只保存 delta。

恢复时只需读取：

```text
最后一条合法 state
```

不需要 replay 全部事件。

---

# 65. Event 与 Durable State

Event：

```text
UI
Telemetry
Observer
Debug
```

State：

```text
Recovery
```

原则：

```text
Store / Runtime Snapshot
=
Source of Truth

Event
=
Notification
```

---

# 66. JSONL → SQLite

当以下语义稳定：

```text
Session Tree
Lane
Operation
Compaction
Usage
```

再迁移 SQLite。

不要一开始先大改数据库。

---

# 67. SQLite 最终模型

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE lanes (
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  leaf_id TEXT,
  current_operation_id TEXT,

  PRIMARY KEY(session_id, name)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation_id TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

---

# 68. Atomic Settlement

SQLite 阶段可以真正做：

```text
BEGIN

insert assistant entry
insert usage
update lane
update operation state

COMMIT
```

或：

```text
BEGIN

insert tool result
update operation state

COMMIT
```

---

# 69. Harness 主循环

```ts
async function runToCompletion(
  operationId: string
): Promise<AgentRunResult> {

  while (true) {
    const operation =
      await store.loadOperation(
        operationId
      );

    if (!operation) {
      throw new Error(
        'operation_not_found'
      );
    }

    const state =
      operation.state;

    if (isTerminal(state)) {
      return resultFromState(state);
    }

    const action =
      interpreter.peekAction(
        state,
        buildInterpreterContext()
      );

    if (!action) {
      throw new Error(
        `No action for ${state.phase}`
      );
    }

    await executeAction(
      operation.meta,
      state,
      action
    );
  }
}
```

核心变化：

```text
for-loop 驱动 Agent

↓

durable state 驱动 Interpreter
```

---

# 70. Recovery

Runtime / Worker 启动：

```text
list lanes
↓
find currentOperationId
↓
load OperationState
↓
recover
```

---

# 71. Recovery Dispatcher

```ts
switch (state.phase) {

  case 'ready':
  case 'checkpoint':
    resumeNormally();
    break;

  case 'model_pending':
    retryModel();
    break;

  case 'tools':
    recoverTools();
    break;

  case 'final_response':
    resumeFinalOnly();
    break;

  case 'suspended':
    waitForExternalResolution();
    break;
}
```

---

# 72. Main / Child Agent / Workflow 的统一方式

Runtime 不理解：

```text
Main Agent
Sub-Agent
Workflow Agent
```

Runtime 只理解：

```text
Lane
```

---

# 73. Main Agent

```text
lane = main
```

---

# 74. Child Agent

创建：

```text
lane = agent:<id>
```

起点：

```text
at parent current leaf
```

---

# 75. Workflow Agent Step

创建：

```text
lane =
workflow:<runId>:<stepId>
```

Workflow Engine 负责：

```text
DAG
dependsOn
retry
timeout
resource group
budget
foreach
condition
```

Agent Runtime 负责：

```text
Model
Tool
Context
Durability
Recovery
```

---

# 76. Multi-Agent

长期可以把 Sub-Agent 抽象成：

```text
AgentSupervisor
```

或：

```text
AgentSpawner
```

本质：

```text
创建 Lane
启动 Operation
收集结果
```

而不是 Coding-specific Profile。

---

# 77. Agent Profile

Profile 放在 Orchestration / Application 层。

```ts
type AgentProfile = {
  model?: string;

  systemPrompt?: string;

  tools?: string[];

  permissions?: string[];

  config?: Record<string, JsonValue>;
};
```

Runtime 不理解：

```text
explore
review
general
coding
research
```

---

# 78. Coding Agent

最终 Coding Agent 是：

```text
@jojo/agent-runtime

+
filesystem tools

+
terminal tools

+
git tools

+
coding permission policy

+
coding prompt

+
workspace metadata
```

而不是 Runtime 内部写死 Coding 逻辑。

---

# 79. Research Agent

```text
Runtime
+
web_search
+
web_fetch
+
research prompt
```

不需要：

```text
filesystem
git
terminal
```

---

# 80. Browser Agent

```text
Runtime
+
browser tools
+
browser permission policy
```

---

# 81. Customer Service Agent

```text
Runtime
+
CRM tools
+
email tools
+
tenant context
```

---

# 82. RuntimeContext

为了适配不同应用：

```ts
export interface RuntimeExecutionContext {
  sessionId: string;

  metadata?: Record<string, JsonValue>;

  appContext?: unknown;
}
```

Tool / Policy Adapter 解释：

```text
appContext
```

Runtime 不解释。

---

# 83. Hooks

V1 不需要复杂 Hook Pipeline。

只建议：

```ts
export interface RuntimeHooks {
  beforeModelRequest?(...): Promise<void>;

  afterModelResponse?(...): Promise<void>;

  beforeTool?(...): Promise<void>;

  afterTool?(...): Promise<void>;

  transformContext?(...): Promise<ModelContext>;
}
```

---

# 84. Hook 副作用

Runtime 不承诺：

```text
Hook exactly once
```

有外部副作用的 Hook 应自行幂等。

---

# 85. Events

```ts
export type AgentRuntimeEvent =
  | {
      type: 'operation.started';
      operationId: string;
    }

  | {
      type: 'operation.state_changed';
      operationId: string;
      phase: string;
    }

  | {
      type: 'model.started';
      operationId: string;
    }

  | {
      type: 'model.completed';
      operationId: string;
    }

  | {
      type: 'tool.started';
      operationId: string;
      callId: string;
    }

  | {
      type: 'tool.completed';
      operationId: string;
      callId: string;
    }

  | {
      type: 'operation.recovered';
      operationId: string;
    }

  | {
      type: 'operation.completed';
      operationId: string;
    };
```

---

# 86. Watch API

后续可实现：

```text
snapshot
+
future events
```

避免 UI 订阅 race。

---

# 87. Usage Ledger

```ts
export type UsageRecord = {
  id: string;

  sessionId: string;

  operationId?: string;

  lane?: string;

  cause:
    | 'model'
    | 'tool'
    | 'compaction'
    | 'recovery';

  providerId?: string;

  model?: string;

  inputTokens?: number;

  outputTokens?: number;

  costUsd?: number;

  durationMs?: number;

  createdAt: number;
};
```

---

# 88. Queue

Pi 的：

```text
steer
followUp
nextRun
```

有价值，但不作为 V1 阻塞项。

优先级：

```text
Durable Run
Tool Recovery
Session/Lane
```

完成后再做 durable queue。

---

# 89. Navigation

```text
navigateTree
branch summary
fork
```

同样在 Session Tree 稳定后实现。

---

# 90. Runtime Error

```ts
export type RuntimeErrorCode =
  | 'provider_unavailable'
  | 'tool_unavailable'
  | 'permission_denied'
  | 'provider_error'
  | 'tool_error'
  | 'interrupted_uncertain_effect'
  | 'context_overflow'
  | 'max_iterations'
  | 'operation_corrupted'
  | 'session_corrupted';
```

---

# 91. Invariants

必须显式保证：

### 91.1 一个 Lane 最多一个 Active Operation

```text
lane.currentOperationId
最多一个
```

### 91.2 Completed Tool 必须有 Result

```text
status = completed
⇒
result exists
```

### 91.3 Pending Effect 必须有 Replay Policy

```text
effect_pending
⇒
replay known
```

### 91.4 Tool Result ID 必须提前预留

```text
effect_pending
⇒
resultEntryId exists
```

### 91.5 Terminal State 不允许继续 Transition

```text
completed
failed
aborted
```

必须 terminal。

### 91.6 Lane Leaf 必须指向有效 Entry

### 91.7 Entry 不可原地修改

```text
append-only
immutable
```

---

# 92. Schema Version

所有 durable payload：

```ts
{
  schemaVersion: 1
}
```

未来：

```text
read old
↓
migrate
↓
write current
```

不能把当前 TypeScript 类型直接当永久存储格式。

---

# 93. ID Generator / Clock

为了测试稳定：

```ts
export interface IdGenerator {
  next(prefix?: string): string;
}
```

```ts
export interface Clock {
  now(): number;
}
```

避免测试完全依赖：

```text
random UUID
real time
```

---

# 94. 测试策略

Agent Runtime 最关键的测试不是：

```text
LLM 能不能回答
```

而是：

```text
任意 durable checkpoint 崩溃后是否能正确恢复
```

---

# 95. Unit Test

核心：

```text
OperationState
↓
Interpreter
↓
AgentAction
```

纯函数测试。

---

# 96. Transition Test

测试：

```text
State + Action Result
↓
New State
```

---

# 97. Store Conformance

所有 Store：

```text
Memory
JSONL
SQLite
```

必须跑同一套：

```text
RuntimeStoreConformanceSuite
```

---

# 98. Fault Injection

必须故意在这些点 crash：

```text
operation start

model intent

model settlement

tool plan

approval

tool intent

tool execution

tool settlement

compaction

operation complete
```

每个点：

```text
throw
↓
restart
↓
resume
↓
verify invariant
```

---

# 99. Crash Matrix

| Crash 点 | 恢复 |
|---|---|
| Prompt 接收后 | Resume model |
| `model_pending` | Retry model |
| Assistant settlement 后 | Continue tools |
| Safe tool `effect_pending` | Replay |
| Never tool `effect_pending` | Synthetic interrupted |
| Tool settlement 后 | Never repeat |
| Approval pending | Restore approval |
| Compaction pending | Resume compaction |
| Terminal state | Do nothing |

---

# 100. No Progress

Jojo 当前已有：

```text
duplicate tool call
observation fingerprint
no-progress recovery
```

这部分行为可以保留。

但状态应进入 Runtime：

```ts
export type ProgressState = {
  toolCallCounts: Record<string, number>;

  observationFingerprints: string[];

  recoveryStepsRemaining: number | null;
};
```

---

# 101. Output Continuation

当前：

```text
length / max_tokens
```

需要 continuation。

因此：

```ts
outputContinuations: number;
```

必须 durable。

---

# 102. Dynamic Tools

Runtime 不保存 JS Tool Object。

只持久化：

```text
Tool identity
Tool config identity
```

恢复时通过 Registry 重新解析。

---

# 103. MCP

MCP 只是 Tool / Resource Provider。

Runtime 不应该存在：

```text
mcp_*
```

特殊逻辑。

MCP Tool 应统一映射成：

```text
AgentTool
```

并携带：

```text
ReplayPolicy
Permission Metadata
```

---

# 104. Browser

Browser 也是 Tool Provider。

Runtime 不区分：

```text
Browser Tool
File Tool
Email Tool
CRM Tool
```

只处理：

```text
Tool Effect
```

---

# 105. Skills

Skill 属于：

```text
Prompt / Resource / Profile
```

不是 Runtime 状态机核心。

---

# 106. Working Directory

通用 Runtime 中：

```text
workingDirectory
```

不能成为必填核心字段。

应从：

```ts
AgentRunOptions {
  workingDirectory: string;
}
```

逐步迁移到：

```ts
runtimeContext?: unknown;
```

或 Session metadata。

---

# 107. Git Worktree

Git Worktree 属于 Coding Agent 的 Isolation Adapter。

可以抽象：

```ts
export interface IsolationProvider {
  prepare(...): Promise<IsolationContext>;

  finish(...): Promise<IsolationResult>;
}
```

Coding App 用 Git Worktree 实现。

Runtime 不认识 Git。

---

# 108. Structured Output

Structured Output 属于：

```text
Run Completion Contract
```

可以放在：

```text
Operation Meta / Prompt Config
```

不是 Coding-specific。

---

# 109. Backward Compatibility

现有：

```text
runAgentTurn()
```

第一阶段继续保留。

内部逐步：

```ts
export async function runAgentTurn(
  options: AgentRunOptions
) {
  return createCompatibilityHarness(
    options
  ).run();
}
```

---

# 110. 现有文件迁移

建议最终映射：

| 当前文件 | 最终去向 |
|---|---|
| `model-step.ts` | `packages/agent/src/loop/model-step.ts` |
| `tool-execution.ts` | 低层执行留 `agent`，Effect orchestration 去 `agent-runtime` |
| `messages.ts` | Agent Message builder / Runtime Entry builder 分离 |
| `context-manager.ts` | token/context primitive 留可复用层，durable compaction 去 runtime |
| `run-agent-turn.ts` | Compatibility facade，主逻辑迁到 runtime |
| `types.ts` | 拆成 Agent types / Runtime types |

---

# 111. 第一阶段不要同时重写所有包

不要一次做：

```text
rename agent-core
+
move all files
+
new runtime
+
new storage
+
new session tree
```

否则 Review 和回归风险太高。

---

# 112. 推荐实施顺序

## PR 1：建立 `packages/agent-runtime`

新增：

```text
packages/agent-runtime/
```

先包含：

```text
operation/state.ts
operation/actions.ts
operation/interpreter.ts
```

暂不持久化。

---

## PR 2：Interpreter 化现有 Run Loop

把：

```text
for-loop
```

改成：

```text
state
↓
peekAction
↓
execute
↓
new state
```

用户可见行为不变。

---

## PR 3：Tool Effect / Replay Policy

引入：

```ts
replay: 'safe' | 'never';
```

Runtime 不根据 Tool 名称特判。

---

## PR 4：RuntimeStore + JSONL Snapshot

新增：

```text
AgentRuntimeStore
JsonlAgentRuntimeStore
```

开始 durable Operation。

---

## PR 5：Crash Resume

实现：

```text
model_pending
effect_pending
approval_pending
```

恢复。

---

## PR 6：Durable Approval

Approval 进入 OperationState。

---

## PR 7：Durable Compaction

将 Context 压缩变成 durable Entry。

---

## PR 8：Session Tree + Main Lane

引入：

```text
parentId
Lane
```

先只给 Main Agent 使用。

---

## PR 9：Child Agent Lane

将 Sub-Agent 逐步转成：

```text
Lane + Operation
```

---

## PR 10：Workflow Agent Step Adapter

将 Workflow Agent Step 适配：

```text
Agent Runtime
```

---

## PR 11：`agent-core` → `agent`

等 Runtime 边界稳定后，再正式拆包 / 重命名。

---

## PR 12：SQLite Runtime Store

最后替换 JSONL Runtime Store。

---

# 113. 为什么不先拆 `agent-core`

现在最需要验证的是：

```text
Runtime abstraction 是否正确
```

不是包名。

如果先大规模：

```text
rename / move
```

会让架构 Review 和文件迁移混在一起。

---

# 114. 当前建议目录

如果现在立即开工：

```text
packages/

├── agent-core/
│
├── agent-runtime/
│   └── src/
│       ├── operation/
│       │   ├── state.ts
│       │   ├── actions.ts
│       │   └── interpreter.ts
│       │
│       ├── harness/
│       │   └── runner.ts
│       │
│       └── index.ts
│
├── orchestration/
├── storage/
...
```

初期：

```text
agent-runtime
↓
agent-core
```

---

# 115. 最终稳定目录

```text
packages/

├── agent/
├── agent-runtime/
├── orchestration/
├── contracts/
├── providers/
├── storage/
├── tools-node/
├── tools-web/
├── tools-browser/
├── tools-mcp/
└── apps/
```

---

# 116. 最终架构

```text
Application
    │
    ├── Provider Adapters
    ├── Tool Registry
    ├── Storage Adapter
    ├── Permission Policy
    └── Profiles
    │
    ▼
Orchestration
    │
    ▼
Agent Runtime
    │
    ├── AgentHarness
    ├── Session
    ├── Lane
    ├── Operation
    ├── Interpreter
    ├── Effects
    ├── Recovery
    ├── Context
    └── Usage
    │
    ▼
Agent
    │
    ├── Message
    ├── Model
    ├── Tool
    ├── ToolCall
    ├── ToolResult
    └── Loop Primitives
```

---

# 117. 对 Coding Agent 的最终定位

Jojo Desktop Coding Agent 最终只是：

```text
Jojo Agent Runtime
+
Coding Agent Profile
+
Node/File Tools
+
Git Tools
+
Terminal Tools
+
Browser Tools
+
MCP
+
Coding Permission Policy
+
Worktree Isolation
+
Electron UI
```

核心 Runtime 本身可以被：

```text
CLI
Server
Research App
Browser Agent
Automation Service
```

复用。

---

# 118. 与 Pi Harness 的关系

推荐借鉴 Pi 的：

```text
Durable Operation
Lane
Session Tree
Effect Sandwich
Replay Policy
Compaction
Recovery
Usage
Harness Facade
```

但不直接复制：

```text
Pi 当前全部代码结构
全部 Queue API
Navigation
完整 Hook Pipeline
具体 Store 实现
```

Jojo 应结合已有：

```text
Workflow Resume
Sub-Agent
Permission Gate
MCP
Desktop Worker
```

形成自己的 Runtime。

---

# 119. 五条架构原则

## 原则 1

> **Agent Message History 不是 Runtime Program Counter。**

History 回答：

```text
Agent 说过什么？
Tool 返回过什么？
```

Operation State 回答：

```text
程序执行到哪里？
哪个 Effect 可能已经发生？
下一步能否安全执行？
```

两者必须分离。

---

## 原则 2

> **任何真实外部副作用都必须位于 Durable Intent 与 Durable Settlement 之间。**

```text
persist intent
↓
effect
↓
persist settlement
```

---

## 原则 3

> **Runtime 不应该知道 Agent 的业务类型。**

Runtime 不知道：

```text
Coding
Research
Browser
Customer Service
Finance
Desktop
```

Runtime 只知道：

```text
Session
Lane
Operation
Model
Tool
Effect
Context
```

---

## 原则 4

> **Orchestration 与 Agent Runtime 分离。**

```text
Workflow
Multi-Agent
Scheduler
```

调用：

```text
Agent Runtime
```

而不是成为 Harness 状态机的一部分。

---

## 原则 5

> **Runtime 只依赖接口，不依赖具体 Provider / Storage / Tool / UI。**

---

# 120. 最终推荐

对于 Jojo 当前工程：

现在就直接新增：

```text
packages/agent-runtime/
```

不要再把新的 Harness 长期写进：

```text
packages/agent-core/src/harness/
```

第一阶段：

```text
agent-runtime
↓
agent-core
```

先复用现有：

```text
model-step
tool execution
context logic
```

后续 Runtime 边界稳定后：

```text
agent-core
↓
agent
```

并将：

```text
durable execution
```

全部放进：

```text
agent-runtime
```

---

# 121. 最终一句话

Jojo 的长期架构应从：

```text
一个能力越来越多的 Coding Agent
```

演进为：

```text
一个通用 Durable Agent Runtime
+
多个可组合 Agent Profile / Tool / Orchestrator / Application
```

而 `AgentHarness` 最合理的位置是：

```text
packages/agent-runtime/src/harness/
```

不是长期放在：

```text
packages/agent-core/src/harness/
```

也不建议单独创建：

```text
packages/harness/
```

因为 Harness 本质上只是：

> **Agent Runtime 的主要入口，而不是整个 Runtime 本身。**

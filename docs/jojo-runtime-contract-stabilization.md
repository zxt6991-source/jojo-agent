# Jojo Runtime Contract 稳定化优化方案

> 文档状态：Proposed Final Contract  
> 日期：2026-08-26  
> 目标仓库：`zxt6991-source/jojo-agent`  
> 适用范围：`packages/agent`、`packages/agent-runtime`、`packages/contracts`、`packages/storage`、`packages/orchestration` 以及所有 Transport/App  
> 核心目标：**停止让 Runtime 的内部状态机结构等价于公共 API；固定一套可长期兼容、Transport-independent、Extension-friendly 的 Runtime Contract。**

---

## 1. 结论

Jojo 当前已经完成了从“进程内 Agent Loop”向 Durable Agent Runtime 的关键迁移：

```text
packages/agent
        ↓
packages/agent-runtime
        ↓
packages/orchestration
```

当前 `agent-runtime` 已具备：

- Session / Entry / Lane；
- Operation Meta / Operation State；
- Interpreter / Reducer；
- Durable Store；
- Context Builder；
- Memory Runtime；
- Hook Runtime 接入；
- Resume；
- Usage；
- Tool replay / permission 状态。

方向正确，**现在不应该再大改概念模型**。

下一阶段的重点应该从：

```text
继续增加 Runtime 功能
```

切换为：

```text
冻结 Runtime Contract
+
隐藏 Runtime 内部实现
+
为 Extension / Transport / Orchestration 提供稳定端口
```

最终应形成：

```text
                    Apps / Transports
             Desktop / CLI / HTTP / Web / IM
                         │
                         ▼
              ┌────────────────────┐
              │ Runtime Public API │
              └─────────┬──────────┘
                        │
             ┌──────────┼───────────┐
             ▼          ▼           ▼
        Session API   Run API   Subscription API
             │          │           │
             └──────────┼───────────┘
                        ▼
                Agent Runtime Kernel
                        │
       ┌────────────────┼────────────────┐
       ▼                ▼                ▼
 Operation Machine   Context Engine   Effect Boundary
       │                │                │
       ▼                ▼                ▼
    Store Port       Memory Port      Tool/Model Port
```

### 必须固定的原则

1. **公共 API 不直接暴露 Reducer、内部 `OperationState` 和持久化表结构。**
2. **Transport 不直接调用 `runner.ts` 内部细节。**
3. **Orchestration 通过 Runtime 公共 API 创建 Lane / Run，而不是复制 Runtime 生命周期。**
4. **Memory / Hooks / Approval / Tool / Provider 都作为 Port 注入 Runtime。**
5. **Runtime Snapshot 是观察接口，不是可随意修改的状态对象。**
6. **Durable State Schema 与 Public API Version 分离。**
7. **内部状态机允许演进，但必须保持已冻结 Contract 的语义兼容。**

---

# 2. 当前需要解决的 Contract 风险

## 2.1 `agent-runtime/index.ts` 暴露面过大

当前公共出口包含：

```text
runAgentTurn
resumeAgentTurn
RuntimeAgentRunOptions
AgentRuntimeStore
MemoryRuntime
ContextBuilder
OperationMeta
OperationState
AgentInterpreter
AgentAction
Reducer functions
Invariant functions
SessionEntry
UsageRecord
...
```

这会造成：

```text
内部实现
=
外部 API
```

后果：

- Reducer 改名可能成为 breaking change；
- `OperationState` 新增 phase 可能影响所有调用方；
- Runtime Store 的 schema 调整难以独立演进；
- App/Workflow 很容易开始依赖内部 reducer；
- Extension 作者会直接读取内部字段；
- 后续无法替换 Runner 实现。

### 优化目标

公共出口必须从“源码文件集合”变成“产品 Contract”。

---

## 2.2 `runAgentTurn()` 仍承担过多 Facade 责任

现在它同时隐含：

```text
创建 operation
构造 context
调用 model
执行 tool
permission
hooks
memory
compaction
settle
resume
events
```

它可以继续作为内部兼容入口，但不应成为长期唯一公共抽象。

长期公共模型应该是：

```ts
runtime.openSession(...)
runtime.getLane(...)
lane.run(...)
runtime.resume(...)
runtime.subscribe(...)
```

---

## 2.3 Durable Schema 与 API Schema 尚未区分

需要明确三种 schema：

```text
Public Contract Schema
        │
        │ 面向 SDK / App / Extension
        ▼

Runtime Durable Schema
        │
        │ 面向 SQLite / Resume
        ▼

Internal Execution Types
        │
        │ Reducer / Interpreter / Runner
        ▼
```

三者不应继续共用同一个 TypeScript 类型。

---

# 3. Runtime Contract 的稳定边界

推荐分为 6 个稳定面。

```text
Runtime Contract
├── 1. Identity Contract
├── 2. Session / Lane Contract
├── 3. Run Contract
├── 4. Event / Snapshot Contract
├── 5. Capability Port Contract
└── 6. Storage Compatibility Contract
```

---

# 4. Stability Level

为所有 Runtime API 标注稳定等级。

```ts
type Stability =
  | 'stable'
  | 'preview'
  | 'internal';
```

## Stable

允许 App、Transport、Plugin 长期依赖：

```text
Runtime
RuntimeSession
RuntimeLane
RunRequest
RunResult
RuntimeEvent
RuntimeSnapshot
RuntimeError
RuntimeCapability
RuntimeVersion
```

## Preview

允许仓库内部使用，但不保证长期兼容：

```text
Branch API
Navigation API
Queue API
Lane Fork
Advanced Compaction Policy
```

## Internal

禁止通过根 `index.ts` 导出：

```text
OperationState
Reducer
Interpreter
EffectPendingState
StoredOperation
Register Key
SQLite row types
runner internal context
```

---

# 5. Public Runtime Facade

推荐新增：

```text
packages/agent-runtime/src/public/
```

结构：

```text
public/
├── runtime.ts
├── session.ts
├── lane.ts
├── run.ts
├── events.ts
├── snapshots.ts
├── errors.ts
├── capabilities.ts
├── versions.ts
└── index.ts
```

根出口只 re-export `public/index.ts`。

---

# 6. `AgentRuntime` Contract

推荐最终公共接口：

```ts
export interface AgentRuntime {
  readonly version: RuntimeVersion;

  openSession(
    request: OpenSessionRequest
  ): Promise<RuntimeSession>;

  getSession(
    sessionId: string
  ): Promise<RuntimeSession | undefined>;

  resume(
    request: ResumeRequest
  ): Promise<RunHandle>;

  subscribe(
    listener: RuntimeEventListener
  ): Unsubscribe;

  getCapabilities(): RuntimeCapabilities;

  close(): Promise<void>;
}
```

### 说明

`AgentRuntime` 不暴露：

```text
SQLite
Reducer
OperationState
Message[]
Provider SDK
Electron
Git
filesystem
```

它只暴露**行为**。

---

# 7. Session Contract

```ts
export interface RuntimeSession {
  readonly id: string;

  getInfo(): Promise<SessionInfo>;

  getLane(
    laneId?: string
  ): Promise<RuntimeLane>;

  createLane(
    request: CreateLaneRequest
  ): Promise<RuntimeLane>;

  listLanes(): Promise<LaneInfo[]>;

  getSnapshot(): Promise<SessionSnapshot>;

  close(): Promise<void>;
}
```

## SessionInfo

```ts
export type SessionInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  metadata: Readonly<Record<string, JsonValue>>;
};
```

### 约束

`metadata`：

- Runtime 保存；
- Runtime 不解释业务字段；
- Workspace / tenant / customer / transport binding 均可放在上层 metadata；
- Runtime 核心不得读取 `workingDirectory` 来决定状态机语义。

---

# 8. Lane Contract

Lane 是 Runtime 的核心并发单位，建议现在正式冻结。

```ts
export interface RuntimeLane {
  readonly sessionId: string;
  readonly id: string;

  getInfo(): Promise<LaneInfo>;

  run(
    request: RunRequest
  ): Promise<RunHandle>;

  cancel(
    request?: CancelRequest
  ): Promise<void>;

  getSnapshot(): Promise<LaneSnapshot>;
}
```

## LaneInfo

```ts
export type LaneInfo = {
  sessionId: string;
  laneId: string;
  leafEntryId: string | null;
  activeRunId: string | null;
  status:
    | 'idle'
    | 'running'
    | 'suspended';
};
```

### 关键限制

公共 API 不应该暴露：

```text
currentOperationId
op.state register key
ToolsState.currentIndex
effect_pending
```

这些是内部 Durable Program Counter。

---

# 9. Run Contract

统一 Main Agent、Sub-Agent、Workflow Agent Step 的执行入口。

```ts
export type RunRequest = {
  input: RuntimeInput;

  model?: ModelSelection;

  context?: RunContextOptions;

  tools?: ToolSelection;

  budget?: RunBudget;

  metadata?: Record<string, JsonValue>;

  signal?: AbortSignal;
};
```

## RuntimeInput

```ts
export type RuntimeInput =
  | {
      type: 'user_message';
      content: RuntimeContent[];
    }
  | {
      type: 'continue';
      content?: RuntimeContent[];
    };
```

未来不要让 Transport 直接传内部 `Message`。

原因：

```text
Runtime Message Model
≠
OpenAI Message
≠
Anthropic Message
≠
UI Message
```

---

# 10. RunHandle

`run()` 不直接只返回最终文本。

推荐：

```ts
export interface RunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly laneId: string;

  result(): Promise<RunResult>;

  cancel(
    reason?: string
  ): Promise<void>;

  snapshot(): Promise<RunSnapshot>;

  subscribe(
    listener: RunEventListener
  ): Unsubscribe;
}
```

这能统一：

```text
Desktop
CLI
HTTP streaming
WebSocket
IM
Workflow
SubAgent
```

---

# 11. RunResult

公共结果建议保持稳定且简单：

```ts
export type RunResult = {
  runId: string;
  sessionId: string;
  laneId: string;

  status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'suspended';

  output: RuntimeContent[];

  usage: UsageSummary;

  stopReason?: string;

  error?: PublicRuntimeError;

  suspended?: SuspensionInfo;
};
```

不要把：

```text
CompletedState
FailedState
AbortedState
SuspendedState
```

直接作为公共结果。

---

# 12. Snapshot Contract

## 原则

Snapshot：

```text
用于观察
≠
用于修改
```

推荐：

```ts
export type RuntimeSnapshot = {
  runtimeVersion: string;
  session: SessionSnapshot;
  lanes: LaneSnapshot[];
  activeRuns: RunSnapshot[];
};
```

所有 Snapshot：

```ts
Readonly<...>
```

Transport / UI 不应通过修改 Snapshot 控制 Runtime。

控制必须走 Command API：

```text
run()
cancel()
resume()
approve()
...
```

---

# 13. Runtime Event Contract

Runtime Event 是未来多 Transport 的关键。

推荐公共事件只保留稳定、业务可理解事件：

```ts
export type RuntimeEvent =
  | RunStartedEvent
  | AssistantDeltaEvent
  | AssistantCompletedEvent
  | ToolRequestedEvent
  | ToolApprovalRequiredEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | RunSuspendedEvent
  | RunResumedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | UsageUpdatedEvent;
```

不要直接广播：

```text
reducer action
register write
state transition implementation detail
```

---

# 14. Event Envelope

```ts
export type RuntimeEventEnvelope<T extends RuntimeEvent> = {
  schemaVersion: 1;

  eventId: string;
  sequence: number;
  timestamp: string;

  sessionId: string;
  laneId: string;
  runId?: string;

  event: T;
};
```

### `sequence`

必须保证同一 Session 内：

```text
monotonic
```

这样 Web / Desktop / HTTP Client 可以：

- 重建 UI；
- 去重；
- Resume streaming；
- 排序。

---

# 15. Runtime Command 与 Runtime Event 必须分离

错误模式：

```text
UI 修改 runtime object
```

正确模式：

```text
Command
   ↓
Runtime
   ↓
Durable Transition
   ↓
Event
```

例如：

```text
ApproveToolCommand
      ↓
Runtime
      ↓
Permission settle
      ↓
ToolApprovalResolvedEvent
```

---

# 16. Approval Port

Permission 不应由 Electron 实现绑死。

推荐稳定 Port：

```ts
export interface ApprovalPort {
  request(
    request: ApprovalRequest
  ): Promise<ApprovalDecision>;
}
```

## ApprovalRequest

```ts
export type ApprovalRequest = {
  approvalId: string;

  sessionId: string;
  laneId: string;
  runId: string;

  capability: string;

  summary: string;

  preview?: JsonValue;

  risk:
    | 'low'
    | 'medium'
    | 'high';

  signal: AbortSignal;
};
```

Desktop：

```text
ApprovalPort
  ↓
Dialog
```

CLI：

```text
ApprovalPort
  ↓
stdin confirm
```

HTTP：

```text
ApprovalPort
  ↓
suspend + external approval endpoint
```

---

# 17. Tool Port

Runtime 只依赖 Tool Contract：

```ts
export interface RuntimeTool {
  readonly descriptor: ToolDescriptor;

  execute(
    call: ToolInvocation,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}
```

## ToolDescriptor

稳定字段：

```ts
export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: JsonSchema;

  replay:
    | 'safe'
    | 'never';

  risk:
    | 'read'
    | 'write'
    | 'external_side_effect';

  capabilities?: string[];
};
```

### Replay Policy 是 Contract

不能让 Runtime 通过 Tool 名字猜：

```ts
if (name === 'read_file') safe
```

必须由 Tool 自己声明。

---

# 18. Provider Port

Provider 不应继续被理解为：

```text
OpenAI Compatible BaseURL
```

Runtime Contract 应定义协议无关 Provider：

```ts
export interface ModelProvider {
  readonly descriptor: ProviderDescriptor;

  createResponse(
    request: ModelRequest,
    context: ModelExecutionContext
  ): AsyncIterable<ModelEvent>;
}
```

内部 Adapter：

```text
OpenAIAdapter
AnthropicAdapter
GeminiAdapter
OpenAICompatibleAdapter
```

全部转换成统一：

```text
ModelEvent
```

---

# 19. Provider Capability Contract

```ts
export type ProviderCapabilities = {
  toolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  promptCaching: boolean;
  structuredOutput: boolean;
  parallelToolCalls: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
};
```

Runtime 只根据 Capability 工作。

不得：

```ts
if (providerId.includes('openai'))
```

---

# 20. Context Port

Context Builder 应保留独立 Contract：

```ts
export interface ContextProvider {
  build(
    request: BuildContextRequest
  ): Promise<ModelContext>;
}
```

最终 Context 来源可组合：

```text
Conversation Projection
Memory
Skills
System Policy
Hook Injection
App Context
Extension Context
```

推荐内部增加：

```ts
export interface ContextContributor {
  readonly id: string;
  readonly priority: number;

  contribute(
    input: ContextContributionInput
  ): Promise<ContextContribution>;
}
```

但 `ContextContributor` 第一阶段可作为 Preview Contract。

---

# 21. Memory Port

Memory 是横切能力，不允许继续和 Runner 紧耦合。

建议稳定为：

```ts
export interface MemoryPort {
  snapshot(
    request: MemorySnapshotRequest
  ): Promise<MemoryContextSnapshot>;

  recall(
    request: MemoryRecallRequest
  ): Promise<MemoryRecallResult>;

  onCompaction(
    request: MemoryCompactionRequest
  ): Promise<MemoryCompactionResult>;

  onRunSettled(
    request: MemoryRunSettledRequest
  ): Promise<void>;
}
```

### 重要

Runtime 不知道：

```text
Markdown
FTS
Embedding
RRF
Candidate
```

这些属于 Memory implementation。

---

# 22. Hook Port

Runtime 只知道：

```ts
export interface HookPort {
  dispatch<E extends StableHookEvent>(
    event: E,
    context: HookDispatchContext
  ): Promise<HookDispatchResult<E>>;
}
```

具体：

```text
Shell Hook
In-process Hook
Extension Hook
```

都在 Runtime 外实现。

---

# 23. Runtime Capability Registry

避免未来 Runner 构造参数无限增长：

```ts
runAgentTurn({
  hooks,
  memoryRuntime,
  runtimeStore,
  ...
})
```

建议引入：

```ts
export interface RuntimeEnvironment {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  memory?: MemoryPort;
  hooks?: HookPort;
  approval?: ApprovalPort;
  telemetry?: TelemetryPort;
  clock?: Clock;
}
```

然后：

```ts
createAgentRuntime({
  store,
  environment
});
```

---

# 24. Durable Program Counter 保持内部

以下设计非常重要，应继续保留：

```text
OperationMeta
OperationState
Effect Pending
Replay Policy
Intent
Effect
Settlement
```

但它们全部归类：

```text
@desktop-agent/agent-runtime/internal
```

而不是 stable public API。

---

# 25. 内部 Operation State 建议继续演进

内部仍可：

```ts
type OperationState =
  | ReadyState
  | ModelPendingState
  | ToolsState
  | CheckpointState
  | FinalResponseState
  | SuspendedState
  | ...
```

未来可以新增：

```text
ContextPreparingState
ApprovalPendingState
CompactPendingState
```

而不会破坏 Runtime API。

这正是 Contract Freeze 的价值。

---

# 26. Effect Sandwich 必须成为 Runtime Invariant

模型调用：

```text
TX: model intent
      ↓
provider request
      ↓
TX: model settlement
```

Tool：

```text
TX: tool intent
      ↓
tool effect
      ↓
TX: tool settlement
```

Extension Side Effect：

```text
TX: extension invocation intent
      ↓
extension
      ↓
TX: extension settlement
```

这些是内部 invariant，不是 UI 行为。

---

# 27. Replay Contract

定义统一：

```ts
export type ReplayPolicy =
  | 'safe'
  | 'never';
```

未来可扩：

```text
idempotent_with_key
manual
```

但 V1 只冻结：

```text
safe
never
```

### `safe`

例如：

```text
read_file
grep
web_search
list
```

Crash：

```text
允许重新执行
```

### `never`

例如：

```text
write
delete
terminal
send_message
payment
external mutation
```

Crash 在 effect pending：

```text
不得自动重复
```

而是：

```text
synthetic interrupted result
或 suspended/manual recovery
```

---

# 28. Runtime Error Contract

不要把任意 JS Error 直接传给 Client。

推荐：

```ts
export type RuntimeErrorCode =
  | 'provider_unavailable'
  | 'provider_failed'
  | 'tool_unavailable'
  | 'tool_failed'
  | 'permission_denied'
  | 'approval_cancelled'
  | 'runtime_corrupt'
  | 'runtime_busy'
  | 'budget_exceeded'
  | 'cancelled'
  | 'recovery_required'
  | 'internal_error';
```

```ts
export type PublicRuntimeError = {
  code: RuntimeErrorCode;
  message: string;
  retryable: boolean;
  detail?: JsonValue;
};
```

---

# 29. Suspended Contract

Suspended 是通用 Agent 必须稳定的一级语义。

原因：

```text
Desktop
```

可以直接弹窗解决。

但：

```text
HTTP / IM / Server
```

经常必须：

```text
暂停
等待外部条件
再 Resume
```

推荐：

```ts
export type SuspensionInfo = {
  reason:
    | 'approval_required'
    | 'credential_required'
    | 'provider_unavailable'
    | 'tool_unavailable'
    | 'external_dependency'
    | 'manual_recovery';

  resumeToken?: string;
  detail?: JsonValue;
};
```

---

# 30. Store Contract

## Public 层不暴露 `AgentRuntimeStore`

`AgentRuntimeStore` 应从 public 根出口移除。

改成：

```text
internal/store
```

或单独的：

```text
@desktop-agent/agent-runtime/storage
```

仅供 storage adapter 使用。

### 原因

如果 App 直接：

```ts
runtimeStore.setRegister(...)
```

它就可以绕过：

```text
Reducer
Invariant
Recovery
Event
```

这会破坏整个 Durable Runtime。

---

# 31. Storage Adapter Contract

如果需要第三方 Storage，实现独立 SPI：

```ts
export interface RuntimeStorageAdapter {
  transaction<T>(
    fn: RuntimeStorageTransaction<T>
  ): Promise<T>;

  loadSession(
    sessionId: string
  ): Promise<StoredSessionBundle>;

  acquireLease(
    sessionId: string
  ): Promise<SessionLease>;
}
```

这个 API：

```text
Preview
```

而不是 Stable。

直到 SQLite + Memory 两个实现通过 conformance suite 后再冻结。

---

# 32. Public Export 重新设计

当前：

```ts
export * from operation...
export * from reducer...
```

建议改成：

```ts
// packages/agent-runtime/src/index.ts

export {
  createAgentRuntime
} from './public/runtime.js';

export type {
  AgentRuntime,
  RuntimeSession,
  RuntimeLane,
  RunHandle,
  RunRequest,
  RunResult,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeCapabilities,
  RuntimeVersion,
  PublicRuntimeError
} from './public/index.js';
```

内部：

```json
{
  "exports": {
    ".": "./src/public/index.ts",
    "./testing": "./src/testing/index.ts",
    "./storage": "./src/storage-api/index.ts"
  }
}
```

不要提供：

```text
./internal
```

给外部包。

---

# 33. Testing Contract

允许测试依赖一组稳定测试工具：

```text
@desktop-agent/agent-runtime/testing
```

包括：

```ts
createInMemoryRuntime()
createScriptedProvider()
createFakeTool()
collectRuntimeEvents()
crashRuntimeAt()
resumeRuntime()
```

不要让测试因此依赖 reducer 私有函数。

---

# 34. Contract Conformance Suite

所有 Runtime 实现必须通过：

```text
Runtime Contract Tests
├── session lifecycle
├── lane lifecycle
├── run lifecycle
├── event ordering
├── cancellation
├── suspension/resume
├── provider failure
├── tool safe replay
├── tool never replay
├── crash before effect
├── crash during effect
├── crash after settlement
├── context compaction
├── usage accounting
└── store migration
```

---

# 35. Runtime Event Conformance

测试必须验证：

```text
run.started
    ↓
assistant.delta*
    ↓
tool.requested?
    ↓
approval.required?
    ↓
tool.started
    ↓
tool.completed
    ↓
...
    ↓
run.completed
```

并保证：

```text
同一 run 最多一个 terminal event
```

terminal：

```text
completed
failed
cancelled
suspended
```

---

# 36. Dependency Rule

最终：

```text
contracts
   ↑
 agent
   ↑
agent-runtime
   ↑
orchestration
```

具体 Adapter：

```text
providers ───────────┐
tools-* ─────────────┤
hooks ───────────────┤
memory implementation├──> App composition root
storage ─────────────┤
extensions ──────────┘
```

Runtime 不应该反向 import：

```text
providers
tools-node
hooks implementation
extensions implementation
Electron
Browser
Git
```

---

# 37. App Composition Root

Electron Worker 未来只做装配：

```ts
const runtime = createAgentRuntime({
  storage: sqliteRuntimeStorage,
  environment: {
    providers,
    tools,
    memory,
    hooks,
    approval,
    telemetry
  }
});
```

然后：

```text
IPC
 ↓
Runtime Public API
```

而不是：

```text
IPC
 ↓
runner internals
```

---

# 38. Orchestration 与 Runtime 的稳定边界

Workflow/Sub-Agent 不得：

```text
直接执行 Agent Loop
直接操作 OperationState
直接写 Runtime Store
```

只允许：

```ts
const lane = await session.createLane(...);

const run = await lane.run(...);

const result = await run.result();
```

Workflow 自己负责：

```text
DAG
dependency
retry
foreach
condition
budget aggregation
resource semaphore
worktree lifecycle
```

Runtime 负责：

```text
单 Lane Agent execution
durability
resume
tool/model effect
```

---

# 39. Memory 与 Orchestration

Sub-Agent / Workflow 使用 Memory 时，不再直接传内部 snapshot object。

建议：

```ts
type MemoryBindingRef = {
  scope: 'inherit' | 'minimal' | 'none';
  snapshotVersion?: string;
};
```

真正 Memory Snapshot 内容由 Runtime/Memory Port 解析。

这样以后 Memory implementation 可以换。

---

# 40. Versioning

必须同时存在三个版本：

```text
Runtime API Version
Runtime Durable Schema Version
Event Schema Version
```

示例：

```ts
RuntimeVersion {
  api: '1.0';
  storage: 4;
  events: 1;
}
```

不要用：

```text
package.json version
```

替代协议版本。

---

# 41. SemVer 规则

## Patch

允许：

```text
bug fix
新增 optional event field
新增 optional capability
性能优化
```

## Minor

允许：

```text
新增 API method
新增 event type
新增 suspension reason
新增 optional request field
```

## Major

需要：

```text
删除 stable API
改变 stable API 语义
改变 event ordering invariant
改变 durable recovery semantic
```

---

# 42. Event Forward Compatibility

所有 Client 必须：

```ts
switch (event.type) {
  ...
  default:
    // ignore unknown event
}
```

因此新增 Event 不必是 breaking change。

---

# 43. Durable Migration

Storage Schema 必须 migrate-on-open：

```text
schema v1
  ↓
migration
  ↓
schema v2
```

规则：

1. migration 必须幂等；
2. migration 失败不得部分提交；
3. migration 之后 invariant test 必须通过；
4. Runtime API version 与 storage version 解耦；
5. 禁止 App 自己修改 runtime tables。

---

# 44. Contract Freeze Checklist

## Public API

- [ ] `AgentRuntime`
- [ ] `RuntimeSession`
- [ ] `RuntimeLane`
- [ ] `RunHandle`
- [ ] `RunRequest`
- [ ] `RunResult`
- [ ] `RuntimeEvent`
- [ ] `RuntimeSnapshot`
- [ ] `RuntimeError`
- [ ] `RuntimeCapabilities`

## Ports

- [ ] Provider Port
- [ ] Tool Port
- [ ] Approval Port
- [ ] Memory Port
- [ ] Hook Port
- [ ] Telemetry Port

## Internal

- [ ] Operation State 标记 internal
- [ ] Reducer 标记 internal
- [ ] Interpreter 标记 internal
- [ ] Store register API 标记 internal
- [ ] SQLite schema 标记 internal

---

# 45. 迁移计划

## R0 — Freeze Baseline

目标：

```text
不改行为，只确认当前 contract surface
```

工作：

- 为当前 `agent-runtime/index.ts` 导出项分类；
- 标记 Stable / Preview / Internal；
- 建立 `docs/contracts/runtime-api-v1.md`；
- 创建 contract test。

验收：

```text
所有现有测试保持通过
```

---

## R1 — Public Facade

新增：

```text
public/runtime.ts
public/session.ts
public/lane.ts
public/run.ts
public/events.ts
```

现有：

```text
runAgentTurn
resumeAgentTurn
```

保留为 compatibility adapter。

验收：

Desktop 能只使用 Public Facade 完成：

```text
start
stream
approval
cancel
resume
```

---

## R2 — Internal Export 收口

根 `index.ts` 移除：

```text
Reducer
Interpreter
OperationState
Runtime Store mutation
```

仓库内部调用迁移到：

```text
internal import
```

但只允许：

```text
agent-runtime 自身
```

使用。

Orchestration 必须改用 Public Facade。

---

## R3 — Environment / Port 收口

把 Runner 构造参数收敛到：

```ts
RuntimeEnvironment
```

完成：

```text
Provider Registry
Tool Registry
Memory Port
Hook Port
Approval Port
Telemetry Port
```

---

## R4 — Transport Independence Gate

增加 CI 架构测试。

禁止：

```text
agent-runtime -> electron
agent-runtime -> tools-node
agent-runtime -> browser
agent-runtime -> hooks implementation
agent-runtime -> providers concrete
```

---

## R5 — v1 Freeze

条件：

- Desktop 使用 Public Runtime API；
- Workflow/Sub-Agent 不调用 reducer；
- CLI smoke app 可复用同一 Runtime；
- crash resume conformance 全通过；
- API 文档与类型定义同步；
- 无 Internal 类型从根包泄漏。

然后标记：

```text
Runtime Contract v1
```

---

# 46. 建议的最终目录

```text
packages/agent-runtime/
├── src/
│   ├── public/
│   │   ├── runtime.ts
│   │   ├── session.ts
│   │   ├── lane.ts
│   │   ├── run.ts
│   │   ├── events.ts
│   │   ├── snapshots.ts
│   │   ├── errors.ts
│   │   └── index.ts
│   │
│   ├── kernel/
│   │   ├── runner.ts
│   │   ├── reducer.ts
│   │   ├── interpreter.ts
│   │   ├── invariants.ts
│   │   └── effects/
│   │
│   ├── session/
│   ├── context/
│   ├── memory/
│   ├── usage/
│   │
│   ├── ports/
│   │   ├── provider.ts
│   │   ├── tools.ts
│   │   ├── memory.ts
│   │   ├── hooks.ts
│   │   ├── approval.ts
│   │   └── telemetry.ts
│   │
│   ├── storage-api/
│   ├── testing/
│   └── index.ts
```

---

# 47. 不建议做的事情

## 不要拆成 `packages/harness`

`agent-runtime` 已经是正确边界。

## 不要把 Workflow 合入 Runtime Kernel

Workflow 是 orchestration。

## 不要让 Memory 实现进入 Runtime Kernel

Runtime 只依赖 Memory Port。

## 不要让 Hooks implementation 进入 Runtime Kernel

Runtime 只依赖 Hook Port。

## 不要让 Provider Adapter 进入 Runtime

Provider 是可替换能力。

## 不要直接把 Pi 的全部 Public Surface 照搬

Jojo 应吸收：

```text
Session
Lane
Operation
Durability
Effect Sandwich
```

但对外 API 应按 Jojo 的 Desktop/Server/Workflow 场景重新收敛。

---

# 48. 最终架构

```text
                   ┌────────────────────┐
                   │    Transports      │
                   │ Desktop CLI HTTP IM│
                   └─────────┬──────────┘
                             │
                             ▼
                  ┌─────────────────────┐
                  │ Runtime Contract v1 │
                  └──────────┬──────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
       Session API        Run API          Event API
           │                 │                 │
           └─────────────────┼─────────────────┘
                             ▼
                    Runtime Kernel
                             │
       ┌──────────────┬──────┼──────┬───────────────┐
       ▼              ▼             ▼               ▼
  Operation         Context       Effect          Recovery
       │              │             │               │
       └──────────────┼─────────────┼───────────────┘
                      │             │
                      ▼             ▼
                   Storage        Ports
                                  │
                  ┌───────────────┼────────────────┐
                  ▼               ▼                ▼
              Provider          Tools        Memory/Hooks
```

---

# 49. 最终决策

Jojo Runtime 当前最需要的不是重构概念，而是**冻结语义、缩小公共面**。

最终要做到：

```text
内部可以继续快速演进
        │
        ▼
Reducer / State / Storage 可改
        │
        ▼
Runtime Contract v1 不动
        │
        ▼
Desktop / CLI / HTTP / Workflow / Extension
无需跟着 Runtime 内部重写
```

一句话：

> **把 `agent-runtime` 从“实现代码包”升级成“真正有版本承诺的 Runtime Platform Contract”。**

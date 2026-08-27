# Jojo Runtime Contract 稳定化优化方案 v2（Code-Aligned）

> 校准日期：2026-08-26  
> 代码基线：`zxt6991-source/jojo-agent@93cbdbfcde828f0f227dfe2cf9594e575dbf5f1e`  
> 前一版 Contract 文档提交：`ede0a1072c88116386076b1da2868a14728785cd`

## 1. 结论

前一版 Runtime Contract **方向正确，不需要推翻**。需要修改的是“贴代码程度”。

继续保留：

- `agent / agent-runtime / orchestration` 三层；
- Session / Lane / Operation durable model；
- Effect Sandwich；
- Replay Policy；
- Runtime Public Facade；
- Transport Independence。

需要修改：

1. 不再重新定义 Tool / Provider / Hook Contract；
2. `workingDirectory` 从“立即移除”改成渐进式 `ExecutionScope`；
3. 不直接用一套新 `RuntimeEvent` 替掉现有 `AgentEvent`；
4. `LeafAgentRunner` 保留为 Orchestration 到 Runtime 的过渡 Adapter；
5. Memory 在 Runner 中的 Tool 名字特判提升为高优先级整改；
6. `packages/contracts`、`browser-automation` 等包也要一起做 Public Export 收口。

---

## 2. 当前代码基线

当前 `packages/agent-runtime/src`：

```text
context/
harness/
memory/
operation/
session/
usage/
memory-store.ts
store.ts
index.ts
```

这个包边界是正确的。

当前最大问题仍是 `agent-runtime/src/index.ts` 直接导出：

```text
runAgentTurn / resumeAgentTurn
AgentRuntimeStore
MemoryRuntime
OperationMeta / OperationState
AgentInterpreter / AgentAction
Reducer functions
Invariant functions
```

也就是：

```text
内部状态机 = 公共 API
```

这一点前一版判断完全正确，仍然是 P0/P1。

---

## 3. Runtime Contract 改为三层

### 3.1 Wire / Serializable Contract

放在：

```text
packages/contracts
```

负责：

```text
SessionInfo
LaneInfo
RunResult DTO
RuntimeEvent DTO
RuntimeError DTO
Zod Schema
HTTP / IPC 可序列化结构
```

### 3.2 Runtime Behavior API

放在：

```text
packages/agent-runtime/src/public
```

负责：

```text
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
```

### 3.3 Internal Kernel

放在：

```text
agent-runtime/kernel
agent-runtime/operation
```

包括：

```text
OperationState
Reducer
Interpreter
Effect intent
StoredOperation
Recovery internals
```

禁止从根出口导出。

---

## 4. 不再新建第二套 Provider Contract

当前 Jojo 已有：

```ts
interface ModelProvider {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

因此不建议再创建：

```text
RuntimeModelProvider
ProviderPort
ExtensionModelProvider
```

下一步真正应该补的是：

```ts
type ProviderCapabilities = {
  toolCalls?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  promptCaching?: boolean;
  structuredOutput?: boolean;
  parallelToolCalls?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
};
```

Provider Adapter 全部继续实现同一个 `ModelProvider`。

---

## 5. 不再新建第二套 Tool Contract

当前已经有：

```text
Tool
ToolDefinition
ToolContext
ToolResult
replay
repeatPolicy
polling
```

Runtime Contract v2 直接复用。

建议仅兼容新增 Runtime metadata：

```ts
type ToolRisk = 'read' | 'write' | 'external_side_effect';

interface Tool {
  definition: ToolDefinition;
  replay?: 'safe' | 'never';
  repeatPolicy?: ToolRepeatPolicy;
  polling?: ToolPollingPolicy;

  risk?: ToolRisk;
  effects?: string[];

  execute(...): Promise<ToolResult>;
}
```

原则：

```text
ToolDefinition = 给模型看的
risk/effects/replay = 给 Runtime / Permission / Recovery 看的
```

---

## 6. Memory Special Case 提升优先级

当前 `runner.ts` 仍通过：

```text
memory_write
memory_forget
memory_restore
```

这些 Tool name 判断 Memory 行为。

这说明 `MemoryRuntime` 已经抽出来了，但 Memory semantic 仍泄漏进 Harness。

建议改成：

```text
Tool.effects
    ↓
memory.write / memory.forget / memory.restore
    ↓
MemoryRuntime
```

最终 Runner 不再：

```ts
if (toolName === 'memory_write')
```

---

## 7. 继续使用现有 `MemoryRuntime`

不要再新建一套 `MemoryPort`。

当前：

```text
MemoryRuntime
NoopMemoryRuntime
snapshot
recallTriggered
beforeCompact
onTurnSettled
```

就是当前 Memory Port v0。

后续直接版本化 / 泛化这个接口即可。

---

## 8. Hook 直接复用现有 Contract

当前已有：

```text
HookRuntime
HookPayloadMap
HookHandler
HookContext
HookInvocationStore
HookRegistry
DefaultHookRuntime
```

因此不再创建一套 `HookPort`。

正式链路：

```text
Extension / Shell
      ↓
HookRegistry
      ↓
DefaultHookRuntime
      ↓
HookRuntime
      ↓
Agent Runtime
```

---

## 9. `workingDirectory` 改为渐进迁移

长期目标仍然是：

```text
General Agent Runtime 不依赖 Workspace
```

但当前：

```text
ToolContext
PermissionGate
HookEnvelope
HookContext
SubAgentStartRequest
LeafAgentRunRequest
Browser
```

都还真实依赖 `workingDirectory`。

因此新增：

```ts
type ExecutionScope =
  | { kind: 'workspace'; workingDirectory: string }
  | { kind: 'none' }
  | { kind: 'custom'; type: string; data: JsonValue };
```

迁移：

```text
Phase A
workingDirectory + ExecutionScope 并存

Phase B
Runtime 只看 ExecutionScope
Tool/Hook Adapter 提取 workingDirectory

Phase C
General Agent 可以 scope = none
```

不要一次性删除 `workingDirectory`。

---

## 10. Public Runtime API

```ts
interface AgentRuntime {
  openSession(req: OpenSessionRequest): Promise<RuntimeSession>;
  getSession(id: string): Promise<RuntimeSession | undefined>;

  // 只表示 crash recovery
  resumeOperation(req: ResumeOperationRequest): Promise<RunHandle>;

  subscribe(listener: RuntimeEventListener): () => void;
  close(): Promise<void>;
}
```

```ts
interface RuntimeSession {
  getLane(id?: string): Promise<RuntimeLane>;
  createLane(req: CreateLaneRequest): Promise<RuntimeLane>;
  listLanes(): Promise<LaneInfo[]>;
  getSnapshot(): Promise<SessionSnapshot>;
}
```

```ts
interface RuntimeLane {
  run(req: RunRequest): Promise<RunHandle>;
  cancelActiveRun(reason?: string): Promise<void>;
  getSnapshot(): Promise<LaneSnapshot>;
}
```

---

## 11. Conversation Continuation 与 Crash Resume 分开

当前 Sub-Agent 有 `continuationId`。

长期 Runtime 公共语义应该是：

```text
Session
  └─ Lane
      ├─ Run 1
      ├─ Run 2
      └─ Run 3
```

继续对话：

```text
lane.run(...)
```

崩溃恢复：

```text
runtime.resumeOperation(...)
```

不要把两种 `resume/continue` 混在一起。

---

## 12. `LeafAgentRunner` 不立即删除

当前 Orchestration 已经有：

```text
SubAgentManager
    ↓
LeafAgentRunner
```

且 `LeafAgentRunRequest` 已包含：

```text
runtimeLane
memoryBinding
hooks
```

说明它本身就是一个很好的防腐层。

正确迁移：

```text
SubAgentManager
    ↓
LeafAgentRunner
    ↓ compatibility adapter
RuntimeSession / RuntimeLane
```

而不是直接让 SubAgentManager 重写一遍 Runtime 生命周期。

最终 `continuationId` 可内部映射成：

```text
sessionId + laneId
```

再逐步消失。

---

## 13. Event Contract 不直接双轨

当前已经有 `AgentEvent`：

```text
turn.started
text.delta
tool.started
tool.finished
approval.required
usage
context.updated
turn.completed
memory.*
hook.*
```

如果马上再建一整套 RuntimeEvent，会产生双轨。

建议分层：

```text
Kernel Transition Event  -> internal
Runtime Lifecycle Event   -> stable
Diagnostic Event          -> memory/hook/browser 等观察事件
AgentEvent                 -> 当前 Desktop/IPC compatibility projection
```

稳定 Runtime Event 只先冻结：

```text
run.started
assistant.delta
tool.requested
approval.required
tool.started
tool.completed
run.suspended
run.resumed
run.completed
run.failed
run.cancelled
usage.updated
```

Memory/Hook 细节放 Diagnostic Event。

---

## 14. Runtime Event Envelope

```ts
type RuntimeEventEnvelope<T> = {
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

其中 `sequence` 应保证 Session 内单调。

---

## 15. Permission / Approval 不重建第二套系统

当前已有：

```text
PermissionGate
PermissionDecision
ApprovalRequest
```

继续保留。

目标结构：

```text
PreToolUse Hook
     ↓
PermissionGate
     ↓
ask?
     ↓
ApprovalBroker
     ↓
Desktop UI / CLI / HTTP suspend
```

`ApprovalBroker` 是 Transport Adapter，不替代 PermissionGate。

---

## 16. RuntimeEnvironment

```ts
interface RuntimeEnvironment {
  providers: ModelProviderResolver;
  tools: ToolResolver;

  memory?: MemoryRuntime;
  hooks?: HookRuntime;
  permissions?: PermissionGate;

  approval?: ApprovalBroker;
  telemetry?: TelemetrySink;
}
```

重点是复用现有 Contract。

---

## 17. 最新 Browser 重构应加入正式架构原则

最新代码已经出现：

```text
packages/browser-automation/
├── ports/browser-driver
├── ports/browser-healing-port
├── ports/browser-permission-port
├── ports/browser-recording-store
├── ports/browser-replay-journal
├── drivers/chrome-cdp
└── headless
```

说明 Jojo 应正式采用：

```text
Capability Package Pattern
```

即：

```text
能力包定义 Port/Core
App 提供 concrete Host
Runtime 通过 Tool/Capability Adapter 使用
```

以后 Browser、Memory、Hooks、Provider 都应遵循这个模式。

---

## 18. 新增：所有核心包都要做 Export Hygiene

不仅 `agent-runtime`。

当前：

```text
contracts/src/index.ts
browser-automation/src/index.ts
```

也大量 `export *`。

建议：

```text
@desktop-agent/contracts/runtime
@desktop-agent/contracts/tools
@desktop-agent/contracts/model
@desktop-agent/contracts/hooks
```

以及：

```text
@desktop-agent/browser-automation
@desktop-agent/browser-automation/driver
@desktop-agent/browser-automation/recording
@desktop-agent/browser-automation/testing
```

Root Export 暂时保留兼容，新代码优先 subpath import。

---

## 19. Stability Level

### Stable

```text
Session / Lane / Run 语义
Tool 基础 Contract
ModelProvider 基础 Contract
HookRuntime
RunResult / RuntimeError
Runtime lifecycle event
```

### Preview

```text
ContextContributor
ExecutionScope custom variant
ProviderCapabilities
Storage SPI
Branch/Navigation
```

### Internal

```text
OperationState
Reducer
Interpreter
StoredOperation
SQLite row
Effect pending state
Memory handoff internals
```

---

## 20. 修订后的迁移顺序

### R0 — Public Surface Inventory

对：

```text
contracts
agent
agent-runtime
orchestration
providers
hooks
browser-automation
extensions
```

分类 Stable / Preview / Internal / Legacy。

### R1 — Import Boundary

CI 禁止：

```text
apps -> agent-runtime/operation
orchestration -> agent-runtime/operation
extensions -> agent-runtime/store
```

### R2 — Contracts Subpath Export

新增：

```text
contracts/model
contracts/tools
contracts/hooks
contracts/runtime
```

### R3 — Runtime Public Facade

新增：

```text
public/runtime
public/session
public/lane
public/run
public/events
```

保留 `runAgentTurn()` compatibility。

### R4 — LeafAgentRunner Adapter

让 `LeafAgentRunner` 内部调用 Runtime Facade。

### R5 — Memory Semantic 解耦

移除 Runner 中 Memory Tool name 特判。

### R6 — ExecutionScope

逐步降低 `workingDirectory` 的核心地位。

### R7 — Runtime/Diagnostic Event 分层

Renderer 先通过 Adapter 保持兼容。

### R8 — Contract v1 Freeze

条件：

- Desktop 实际使用 Public Facade；
- Orchestration 不依赖 Runtime Internal；
- Contracts 有 subpath；
- Runtime 根出口不再导出 reducer/state/store mutation；
- crash resume conformance 全通过；
- CLI/Headless smoke test 可复用同一 Runtime。

---

## 21. 最终判断

前一版 Runtime Contract 大约属于：

```text
架构方向正确
接口定义部分过度前置
```

v2 应从：

```text
“再设计一套稳定接口”
```

变成：

```text
“复用现有 ModelProvider / Tool / HookRuntime / MemoryRuntime，
只把真正不稳定的状态机和存储藏起来”
```

最终原则：

> **冻结行为边界，不冻结当前内部实现类型；复用已有 Contract，不制造同义接口。**

# Jojo Runtime 公共边界稳定化最终优化方案

> 状态：建议作为 Jojo Runtime 下一阶段重构与收口的实施基线  
> 校准日期：2026-08-27  
> 代码基线：`zxt6991-source/jojo-agent@60b4786b3f130ca037652fa98e81ae19cb8cc4e5`  
> 核心目标：
>
> **稳定 Runtime 公共边界，让完全相同的一套 Runtime 能被 Electron、普通 Node 测试程序、无界面 Server 调用；Runtime 不依赖 Electron Main、UtilityProcess、Renderer、IPC 或 Desktop 进程生命周期。**

---

## 1. 结论

Jojo 当前已经完成了 Runtime 解耦最重要的第一步：

```text
createAgentRuntime()
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
RuntimeEventEnvelope
ExecutionScope
```

这些抽象已经进入 `packages/agent-runtime`，并且 `agent-runtime` package 本身没有 Electron dependency。

但当前还没有真正完成：

```text
Desktop Runtime
        =
Headless Runtime
        =
Test Runtime
```

原因不是 Runtime Kernel 仍依赖 Electron，而是：

```text
真正完整的“Jojo 产品 Runtime 组合”
仍然被 apps/desktop/src/worker/worker.ts 持有
```

当前 Desktop Worker 仍直接：

```ts
import {
  runAgentTurn,
  resumeAgentTurn
} from '@desktop-agent/agent-runtime/compat';
```

并且在 Worker 内部组合：

```text
Provider
Tools
Dynamic MCP Tools
Skills
Memory
Hooks
Browser
Orchestration
Permission
Approval
Session Store
Runtime Store
Compaction Summarizer
Event Projection
```

因此现状实际是：

```text
                    Public Runtime Facade
                           ▲
                           │
                 SubAgent 已开始使用
                           │

Desktop Main Agent
      │
      └────────────→ compat runner
                       ▲
                       │
          Desktop Worker 持有完整产品组合
```

最终应变成：

```text
                 Jojo Runtime Public API
                          │
                 Runtime Composition
                          │
                     AgentRuntime
                          │
            RuntimeSession / RuntimeLane
                          │
                         Run
                  ┌───────┼────────┐
                  │       │        │
              Electron   Test    Server
```

核心原则：

> **Runtime 定义执行语义；Host 只负责注入环境和适配 Transport。**

---

## 2. 本方案要解决的问题

目标不是简单把：

```ts
runAgentTurn(...)
```

机械替换为：

```ts
lane.run(...)
```

因为当前 Public Facade 还没有覆盖 Desktop Main Agent 使用的全部能力。

Desktop compat runner 当前还需要：

```text
userImages
getTools
summarize
commitMessage
approval
dynamic MCP tools
legacy session projection
```

而当前 Public `RunRequest` 主要只有：

```text
input
providerId
model
history
instructions
maxIterations
workingDirectory
signal
memoryBinding
hookMeta
...
```

因此正确迁移顺序必须是：

```text
补齐 Public Runtime 语义
        ↓
把 Desktop 私有 callback 重新归类
        ↓
提取 Runtime Composition
        ↓
Desktop Main Agent 迁到 Public Facade
        ↓
Test / Server 复用完全相同 Runtime
        ↓
关闭 compat runner 对新代码的入口
```

---

## 3. 设计目标

最终必须满足以下条件。

### 3.1 Electron

Electron Worker 可以：

```ts
const runtime = await createJojoRuntime(...);

const session = await runtime.openSession(...);
const lane = await session.getLane('main');
const run = await lane.run(...);
```

Electron 只负责：

```text
IPC
Renderer Approval UI
Desktop Settings
Desktop Browser UI Adapter
OS Integration
```

### 3.2 普通 Node 测试程序

不启动：

```text
Electron
Renderer
UtilityProcess
BrowserWindow
```

即可：

```ts
const runtime = createTestRuntime(...);

const session = await runtime.openSession(...);
const lane = await session.getLane();
const handle = await lane.run(...);

const result = await handle.result;
```

### 3.3 无界面 Server

Server 可以：

```ts
const runtime = await createJojoRuntime({
  host: serverHost
});
```

然后：

```text
HTTP / WebSocket
       ↓
App Service
       ↓
AgentRuntime
```

Server 不需要启动 Desktop Main。

---

## 4. 非目标

这一阶段不需要：

```text
把 Runtime 做成浏览器 JS Runtime
把 Runtime 做成远程 RPC 对象
一 Session 一进程
Distributed Runtime
Cloud multi-tenant
Plugin ABI
把 Browser 直接塞进 Runtime Kernel
```

Runtime 可以继续运行在 Node.js 环境。

要求是：

```text
Node Runtime
≠
Electron Runtime
```

即：

> 可以依赖合理的 Node 基础能力，但不能依赖 Electron/Desktop 进程模型。

---

## 5. 最终分层

推荐明确形成五层：

```text
┌──────────────────────────────────────┐
│ Host                                 │
│ Electron / Test / Server / CLI       │
└─────────────────┬────────────────────┘
                  │
┌─────────────────▼────────────────────┐
│ Runtime Composition                  │
│ Jojo capabilities assembly           │
└─────────────────┬────────────────────┘
                  │
┌─────────────────▼────────────────────┐
│ Agent Runtime Public Facade          │
│ Session / Lane / Run / Event         │
└─────────────────┬────────────────────┘
                  │
┌─────────────────▼────────────────────┐
│ Runtime Kernel                       │
│ Operation / Reducer / Interpreter    │
└─────────────────┬────────────────────┘
                  │
┌─────────────────▼────────────────────┐
│ Agent Core                           │
│ Model / Tool / Message primitives    │
└──────────────────────────────────────┘
```

---

## 6. 各层职责

### 6.1 Agent Core

`packages/agent`

负责：

```text
Message
Model Step
Tool Execution
Context Budget
Loop Guard
Iteration Policy
```

不负责：

```text
Session durability
Lane
Crash resume
Electron
HTTP
```

### 6.2 Runtime Kernel

`packages/agent-runtime/src/internal/*`

负责：

```text
OperationState
Reducer
Interpreter
Effect sandwich
Replay
Durability
Session Entry
Lane State
Usage Ledger
Recovery
```

这些都是：

```text
Internal Kernel Contract
```

不得被 App / Server / Electron 直接依赖。

### 6.3 Runtime Public Facade

`packages/agent-runtime/src/public/*`

负责：

```text
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
RunRequest
RunResult
RuntimeEventEnvelope
ExecutionScope
RuntimeEnvironment Ports
```

这是稳定公共行为边界。

### 6.4 Runtime Composition

建议新增：

```text
packages/runtime-composition
```

它负责把 Jojo 的产品能力组合成：

```text
RuntimeEnvironment
```

包括：

```text
Provider Resolver
Tool Source
Permission Chain
Memory Runtime
Hook Runtime
Summarizer
Approval Port
Orchestration Capability
Browser Tool Capability
MCP / Skills Capability
Telemetry
```

它不得依赖：

```text
Electron
Fastify
WebSocket
Renderer
parentPort
DesktopApi
WorkerCommand
```

### 6.5 Host Adapter

Host 分别位于：

```text
apps/desktop
apps/server
agent-runtime/testing
```

负责：

```text
配置来源
Secret 来源
Transport
Approval UI / Remote Approval
Process lifecycle
具体持久化路径
Runtime Event 输出
```

---

## 7. 推荐包结构

```text
packages/
├── contracts/
│   └── src/
│       └── runtime.ts
│
├── agent-runtime/
│   └── src/
│       ├── public/
│       │   ├── runtime.ts
│       │   ├── environment.ts
│       │   ├── session.ts
│       │   ├── lane.ts
│       │   ├── run.ts
│       │   ├── events.ts
│       │   └── index.ts
│       │
│       ├── internal/
│       │   ├── operation/
│       │   ├── session/
│       │   ├── context/
│       │   ├── usage/
│       │   └── runner/
│       │
│       ├── compat/
│       │   └── runner.ts
│       │
│       └── testing/
│           ├── runtime.ts
│           ├── providers.ts
│           ├── approval.ts
│           └── storage.ts
│
├── runtime-composition/
│   └── src/
│       ├── create-runtime.ts
│       ├── environment.ts
│       ├── tools.ts
│       ├── providers.ts
│       ├── permissions.ts
│       ├── summarizer.ts
│       └── capabilities.ts
│
└── ...

apps/
├── desktop/
│   └── src/
│       └── runtime/
│           ├── electron-host.ts
│           ├── electron-approval.ts
│           ├── electron-events.ts
│           └── legacy-projection.ts
│
└── server/
    └── src/
        └── runtime/
            ├── server-host.ts
            ├── server-approval.ts
            └── server-events.ts
```

---

## 8. Public Export 必须彻底收口

当前 root `@desktop-agent/agent-runtime` 仍然同时 export：

```text
createAgentRuntime
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle

以及

runAgentTurn
resumeAgentTurn
RuntimeAgentRunOptions
```

这会让新代码继续绕过 Public Facade。

目标：

```json
{
  "exports": {
    ".": "./src/public/index.ts",
    "./compat": "./src/compat/index.ts",
    "./testing": "./src/testing/index.ts",
    "./spi": "./src/spi/index.ts"
  }
}
```

---

## 9. Stable Root

`@desktop-agent/agent-runtime`

只公开：

```ts
createAgentRuntime

AgentRuntime
RuntimeSession
RuntimeLane
RunHandle

OpenSessionRequest
CreateLaneRequest
RunRequest
RunResult

RuntimeEnvironment
RuntimeResolutionContext

RuntimeEventListener
```

普通应用禁止看到：

```text
OperationState
Reducer
Interpreter
StoredOperation
SessionEntry
LaneState
runAgentTurn
resumeAgentTurn
assertOperationState
```

---

## 10. Compat

旧接口统一迁到：

```text
@desktop-agent/agent-runtime/compat
```

包括：

```text
runAgentTurn
resumeAgentTurn
RuntimeAgentRunOptions
```

规则：

> **compat 只允许旧代码迁移使用，不允许任何新功能依赖。**

建议 CI 加：

```text
apps/server/**
packages/runtime-composition/**
packages/orchestration/**
```

禁止 import：

```text
@desktop-agent/agent-runtime/compat
```

Desktop 在迁移完成后也加入禁止列表。

---

## 11. SPI 与 App API 分开

Runtime 有两类消费者：

### App Consumer

```text
Electron
Server
CLI
Test
```

只应该看：

```text
AgentRuntime Public API
```

### Infrastructure Provider

例如：

```text
SQLite Runtime Store
```

可能需要更低层持久化 SPI。

所以不要把 Store internals 混进 root。

推荐：

```text
@desktop-agent/agent-runtime/spi
```

只为 Jojo 内部 infrastructure package 使用。

明确：

```text
Public App API = Stable
Host/Storage SPI = Preview / separately versioned
Kernel Internal = No export
```

---

## 12. 当前 AgentRuntimeStore 不适合作为普通 Public API

当前 Store 直接暴露：

```text
OperationMeta
OperationState
StoredOperation
SessionEntry
LaneState
UsageRecord
```

这些类型属于 Durable Kernel。

因此：

```text
AgentRuntimeStore
```

不应该成为 Electron / Server 的日常接口。

正确：

```text
Electron / Server
       ↓
Runtime Composition
       ↓
AgentRuntime
```

而：

```text
SqliteAgentRuntimeStore
```

只通过 Composition Root 注入。

---

## 13. 稳定 Public Runtime API

建议最终保留：

```ts
export interface AgentRuntime {
  openSession(
    request: OpenSessionRequest
  ): Promise<RuntimeSession>;

  getSession(
    sessionId: string
  ): Promise<RuntimeSession | undefined>;

  resumeOperation(
    request: ResumeOperationRequest
  ): Promise<RunHandle>;

  subscribe(
    listener: RuntimeEventListener
  ): Disposable;

  close(): Promise<void>;
}
```

---

## 14. RuntimeSession

```ts
export interface RuntimeSession {
  readonly id: string;

  getSnapshot(): Promise<RuntimeSessionSnapshot>;

  getLane(
    laneId?: string
  ): Promise<RuntimeLane>;

  createLane(
    request: CreateLaneRequest
  ): Promise<RuntimeLane>;

  listLanes(): Promise<LaneInfo[]>;
}
```

Session 是：

```text
durable conversation container
```

不是：

```text
Electron chat tab
HTTP connection
WebSocket
```

---

## 15. RuntimeLane

```ts
export interface RuntimeLane {
  readonly sessionId: string;
  readonly id: string;

  run(
    request: RunRequest
  ): Promise<RunHandle>;

  cancelActiveRun(
    reason?: string
  ): Promise<void>;

  getSnapshot(): Promise<LaneSnapshot>;
}
```

Lane 表达：

```text
Conversation continuity
```

例如：

```text
main
agent:<id>
workflow:<id>
```

---

## 16. RunHandle

```ts
export interface RunHandle {
  readonly id: string;

  readonly result: Promise<RunResult>;

  cancel(
    reason?: string
  ): Promise<void>;
}
```

Public：

```text
Run
```

Internal：

```text
Operation
```

不要把二者永久绑定成同一个 Contract。

---

## 17. RunRequest 必须“数据化”

最重要的 Stable API 原则：

> **RunRequest 只承载 Run 数据，不承载 Host callback。**

不要出现：

```text
getTools()
summarize()
commitMessage()
approve()
emit()
permissionGate
```

这些属于 Environment。

---

## 18. 推荐新的 RunInput

当前：

```ts
input: string
```

不足以覆盖 Desktop 图片输入。

建议：

```ts
export type RuntimeInputBlock =
  | {
      type: 'text';
      text: string;
    }
  | ImageContentBlock;

export type RuntimeInput = {
  content: RuntimeInputBlock[];
};
```

于是：

```ts
await lane.run({
  input: {
    content: [
      {
        type: 'text',
        text: '分析这张图'
      },
      image
    ]
  },
  providerId: 'openai',
  model: 'gpt-5'
});
```

Compatibility：

```text
string input
```

可以在 v0.x 内部自动转为 text block。

---

## 19. RunRequest 推荐结构

```ts
export type RunRequest = {
  input: RuntimeInput;

  providerId: string;

  model: string;

  instructions?: string[];

  budget?: {
    maxIterations?: number;
    allowPartialOnLimit?: boolean;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  };

  actor?: {
    kind:
      | 'main'
      | 'subagent'
      | 'workflow';

    id?: string;
    profile?: string;
  };

  workflow?: {
    id: string;
    runId?: string;
    stepId?: string;
  };

  signal?: AbortSignal;
};
```

---

## 20. history 应从 Stable RunRequest 删除

当前 Public RunRequest 仍允许：

```ts
history?: Message[]
```

这会破坏：

```text
Session / Lane 是对话状态权威来源
```

Host 可以随意传一套历史，Runtime Store 又保存另一套历史。

最终应：

```text
lane.run()
      ↓
Runtime 根据 lane leaf
读取历史
```

而不是：

```text
Host
  ↓
history[]
  ↓
lane.run()
```

---

## 21. 测试需要预置 History 怎么办

不要污染 Stable Run API。

Testing 提供：

```ts
const session = await testRuntime.createSession({
  seed: [...]
});
```

或者：

```text
@desktop-agent/agent-runtime/testing
```

提供：

```ts
seedSession()
seedLane()
```

Compatibility runner 可以继续接受 `history`。

---

## 22. workingDirectory 应从 Stable RunRequest 删除

ExecutionScope 应属于：

```text
Session
```

创建 Session：

```ts
runtime.openSession({
  executionScope: {
    kind: 'workspace',
    workingDirectory: '/repo'
  }
});
```

以后：

```ts
lane.run(...)
```

不再重复传工作目录。

---

## 23. process.cwd() 隐式 fallback 应删除

当前 Runtime 在：

```text
executionScope = none
```

等情况下仍可能为了兼容 runner 推导：

```ts
process.cwd()
```

这在 Headless Server 中有潜在风险：

```text
Server 工作目录
意外变成 Agent workspace
```

正确原则：

```text
scope.none
=
没有 workspace
```

需要 workspace 的 Tool：

```text
不应该被 ToolResolver 提供
```

Compat runner 若必须有 cwd：

```text
由 compat adapter 显式提供受控 fallback
```

禁止 Runtime Kernel 静默使用：

```text
process.cwd()
```

作为权限语义。

---

## 24. RuntimeEnvironment 是 Host 解耦核心

建议最终：

```ts
export interface RuntimeEnvironment {
  host: RuntimeHostDescriptor;

  providers: ModelProviderResolver;

  tools: ToolResolver;

  permissions: PermissionGate;

  approval?: ApprovalBroker;

  summarizer?: RuntimeSummarizer;

  memory?: MemoryRuntime;

  hooks?: HookRuntime;

  telemetry?: TelemetrySink;
}
```

---

## 25. RuntimeHostDescriptor

```ts
export type RuntimeHostDescriptor = {
  kind:
    | 'desktop'
    | 'server'
    | 'test'
    | 'cli'
    | 'unknown';

  instanceId?: string;
};
```

注意：

Runtime 可以把它用于：

```text
Hook metadata
Telemetry
Audit context
```

但禁止：

```ts
if (host.kind === 'desktop') {
  // desktop-specific runtime behavior
}
```

行为差异必须由 Port 注入。

---

## 26. ProviderResolver

现有方向正确：

```ts
export interface ModelProviderResolver {
  resolve(
    context: RuntimeResolutionContext
  ): ModelProvider | Promise<ModelProvider>;
}
```

Electron / Server / Test 分别可以提供：

```text
Configured Provider
Remote Provider
ScriptedProvider
```

Runtime 不读取：

```text
Desktop Settings
API Key file
process.env
```

---

## 27. ToolResolver 需要升级

当前 Public ToolResolver：

```ts
resolve(context): Tool[]
```

只能在 Run 启动时解析一次。

但 Desktop 主 Agent 当前支持：

```text
getTools()
```

例如：

```text
MCP 动态工具
Skill 动态工具
```

因此 Public Runtime 需要保留“运行过程中 Tool Catalog 可变化”的能力。

---

## 28. 推荐 ToolSource 模型

```ts
export interface RuntimeToolSource {
  snapshot(
    context: ToolSnapshotContext
  ): Tool[];

  dispose?(): Promise<void>;
}

export interface ToolResolver {
  resolve(
    context: RuntimeResolutionContext
  ): RuntimeToolSource | Promise<RuntimeToolSource>;
}
```

Runtime 启动 Run：

```text
ToolResolver
    ↓
RuntimeToolSource
```

每次准备 Model Context 前：

```text
toolSource.snapshot()
```

这样保留：

```text
MCP lazy tools
Skill tools
Capability changes
```

而不需要把：

```ts
getTools
```

暴露到 RunRequest。

---

## 29. ToolSource 必须由 Host-independent Composition 创建

例如：

```text
Base Tools
Memory Tools
MCP Tools
Skill Tools
Browser Tools
Orchestration Tools
      ↓
CompositeRuntimeToolSource
```

Electron / Server 不分别重写组合规则。

---

## 30. Browser 不进入 Runtime Kernel

正确：

```text
browser-automation
      ↓
Browser Tool Adapter
      ↓
RuntimeToolSource
      ↓
AgentRuntime
```

不同 Host：

### Electron

```text
Browser capability
+
Desktop Browser UI Adapter
```

### Server

```text
Browser capability
+
Headless Chrome CDP
```

Runtime 只看到：

```text
Tool[]
```

---

## 31. Summarizer 从 Run callback 提升成 Port

当前 Desktop 传：

```ts
summarize: (...)
```

这不应该属于每次 `lane.run()`。

推荐：

```ts
export interface RuntimeSummarizer {
  summarize(
    request: {
      sessionId: string;
      laneId: string;
      runId: string;
      source: string;
    },
    signal: AbortSignal
  ): Promise<string>;
}
```

注入：

```ts
createAgentRuntime({
  environment: {
    summarizer
  }
});
```

---

## 32. ApprovalBroker

当前方向正确：

```ts
export interface ApprovalBroker {
  requestApproval(
    request: ApprovalRequest,
    context: RuntimeResolutionContext,
    signal: AbortSignal
  ): Promise<boolean>;
}
```

三个 Host：

### Electron

```text
ElectronApprovalBroker
       ↓
IPC
       ↓
Renderer Dialog
```

### Server

```text
ServerApprovalBroker
       ↓
Pending Approval
       ↓
WebSocket / REST
```

### Test

```text
DeterministicApprovalBroker
```

例如：

```ts
allowAll()
denyAll()
allowTools(['read_file'])
```

---

## 33. Runtime 不直接知道 Approval UI

禁止 Runtime import：

```text
DesktopApi
WorkerCommand
BrowserWindow
dialog
WebSocket
Fastify
```

Runtime 只：

```text
await approval.requestApproval(...)
```

---

## 34. commitMessage 不应该成为 Stable Runtime Port

Desktop 当前同时存在：

```text
JsonlSessionStore
AgentRuntimeStore
```

并通过：

```text
commitMessage
```

维持两份 Message 状态。

长期来看：

```text
AgentRuntimeStore / Session Entry
```

应该成为对话 Durable Source of Truth。

因此：

```text
commitMessage
```

不应该提升成公共 Runtime API。

---

## 35. Legacy Session Projection

迁移阶段：

```text
RuntimeEvent / RunResult
       ↓
DesktopLegacySessionProjection
       ↓
JsonlSessionStore
```

它属于：

```text
apps/desktop
```

不是：

```text
agent-runtime
```

等 Desktop Renderer 能直接使用 Runtime Session Projection 后：

```text
删除 legacy message duplication
```

---

## 36. Event 是三种 Host 共用的核心接口

稳定：

```text
RuntimeEventEnvelope
```

应该足以驱动：

```text
Electron UI
Server WebSocket
Test Assertions
CLI output
```

因此核心 UI 需要的 Event 不能只停留在：

```text
AgentEvent / diagnostic
```

---

## 37. RuntimeEvent 建议至少覆盖

```text
run.started

assistant.delta

tool.requested
tool.started
tool.progress
tool.completed

approval.required

context.compacted

run.suspended
run.resumed

usage.updated

run.completed
run.cancelled
run.failed
```

当前已有大部分。

建议补：

```text
tool.progress
```

因为 Browser / Terminal / Workflow 等长任务都需要稳定进度。

---

## 38. Diagnostic Event 与 Runtime Event 分开

### Stable Runtime Event

面向：

```text
Product UI
Server
SDK
Tests
```

### Diagnostic AgentEvent

面向：

```text
Debug
Memory lifecycle
Hook lifecycle
Internal context metrics
Tracing
```

保留：

```ts
TelemetrySink.diagnostic(event)
```

但不能要求 Server / Desktop 核心 UI 依赖 AgentEvent shape。

---

## 39. Session / Lane / Run Event Envelope

继续使用：

```ts
{
  schemaVersion,
  eventId,
  sequence,
  timestamp,
  sessionId,
  laneId,
  runId?,
  event
}
```

这是非常适合三种 Host 共用的边界。

---

## 40. Memory

Runtime 可以依赖：

```text
MemoryRuntime Port
```

但 Host 不应该：

```text
if desktop → Memory A
if server → Memory B
```

默认 Jojo 产品行为应通过：

```text
runtime-composition
```

统一创建。

Test 可以注入：

```text
NoopMemoryRuntime
InMemoryMemoryRuntime
```

---

## 41. Hooks

Runtime 继续只依赖：

```text
HookRuntime
```

Host transport：

```text
desktop
server
test
cli
```

只是 metadata。

Hook 执行机制不应位于 Electron Worker。

---

## 42. Permission

Permission 组合应从 Desktop Worker 提取。

当前类似：

```text
OrchestrationPermissionGate
  ↓
BrowserPermissionGate
  ↓
ExtensionPermissionGate
  ↓
MemoryPermissionGate
  ↓
ToolPermissionGate
```

应该由：

```text
runtime-composition
```

统一创建。

Host 只注入：

```text
Policy Config
ApprovalBroker
Security Capability
```

---

## 43. Runtime Composition

新增：

```ts
export type JojoRuntimeCompositionOptions = {
  host: RuntimeHostDescriptor;

  storage: RuntimeStorageFactory;

  providers: RuntimeProviderConfig;

  capabilities: RuntimeCapability[];

  approval: ApprovalBroker;

  telemetry?: TelemetrySink;

  dataDirectory?: string;
};

export async function createJojoRuntime(
  options: JojoRuntimeCompositionOptions
): Promise<AgentRuntime>;
```

---

## 44. Capability Contribution

推荐统一内部组合：

```ts
export interface RuntimeCapability {
  contribute(
    builder: RuntimeEnvironmentBuilder
  ): void | Promise<void>;
}
```

内建：

```text
CoreToolCapability
MemoryCapability
HookCapability
McpCapability
SkillCapability
BrowserCapability
OrchestrationCapability
```

这不是第三方 Plugin ABI。

它只是 Jojo 内部 Composition Pattern。

---

## 45. 为什么需要 Runtime Composition Package

如果没有它：

```text
Desktop
  自己组合 tools/memory/hooks

Server
  再组合一遍

Test
  又组合一遍
```

很快会产生：

```text
Desktop 能用 Tool A
Server 忘记 Tool A

Desktop Permission Chain A
Server Permission Chain B

Desktop Hook Meta 正确
Server Hook Meta 缺失
```

最终“同一套 Runtime”仍然只是表面相同。

因此：

> **公共 Runtime Facade 解决执行边界；Runtime Composition 解决产品行为一致性。**

两者缺一不可。

---

## 46. Electron 最终结构

当前：

```text
Electron UtilityProcess Worker
        │
        ├── Provider
        ├── Memory
        ├── Hooks
        ├── Browser
        ├── MCP
        ├── Skills
        ├── Orchestration
        ├── Permission
        └── runAgentTurn()
```

目标：

```text
Electron UtilityProcess Worker
        │
        ├── IPC Adapter
        ├── ElectronApprovalBroker
        ├── Desktop Browser Adapter
        └── createJojoRuntime()
                  │
                  ▼
             AgentRuntime
```

Worker 从：

```text
Runtime Owner
```

降级为：

```text
Runtime Host Adapter
```

---

## 47. Electron Worker 只应该做什么

允许：

```text
read WorkerCommand
validate IPC
resolve Desktop config path
create Desktop approval adapter
post RuntimeEvent
shutdown runtime
```

不应该直接实现：

```text
Agent Loop
Context Compaction
Runtime Resume
Tool Catalog rules
Memory orchestration
Hook lifecycle
SubAgent execution semantics
```

---

## 48. Server 最终结构

```text
HTTP / WS
    ↓
App Service
    ↓
createJojoRuntime()
    ↓
AgentRuntime
```

Server adapter 负责：

```text
Auth
Principal
Lease
Remote Approval
Backpressure
HTTP Error Mapping
```

Runtime 不知道：

```text
HTTP
WebSocket
Bearer Token
```

---

## 49. Test 最终结构

提供：

```text
@desktop-agent/agent-runtime/testing
```

或：

```text
runtime-composition/testing
```

示例：

```ts
const runtime = await createTestJojoRuntime({
  provider: new ScriptedProvider([...]),
  approvals: 'deny'
});

const session = await runtime.openSession({
  id: 'test-session',
  executionScope: {
    kind: 'none'
  }
});

const lane = await session.getLane();

const events: RuntimeEventEnvelope[] = [];
runtime.subscribe(event => events.push(event));

const run = await lane.run({
  input: {
    content: [{
      type: 'text',
      text: 'hello'
    }]
  },
  providerId: 'test',
  model: 'scripted'
});

const result = await run.result;
```

整个测试：

```text
不 import Electron
不 mock parentPort
不启动 UtilityProcess
```

---

## 50. Test Runtime 必须支持确定性

Testing helpers：

```text
ScriptedProvider
MemoryRuntimeStore
FixedClock
DeterministicIdGenerator
DeterministicApprovalBroker
FakeToolSource
EventCollector
```

这样 Runtime Contract 可以做真正的行为测试。

---

## 51. Runtime Lifecycle

Host：

```ts
const runtime = await createJojoRuntime(...);

try {
  // use runtime
} finally {
  await runtime.close();
}
```

Runtime.close：

```text
停止接受新 Run
cancel active runs
等待结果 settle
dispose tool sources
dispose memory/hooks resources
close listeners
```

---

## 52. Capability 生命周期

如果 ToolSource / Capability 有资源：

```text
MCP connection
Browser process
Hook watcher
```

应该有显式：

```ts
dispose()
```

Composition 收集 disposables。

不要依赖：

```text
Electron process exit
```

来释放资源。

这是 Headless Server 必须具备的能力。

---

## 53. Runtime 与 Process 生命周期彻底分开

禁止：

```text
Runtime constructor
  ↓
读取 process.parentPort

Runtime.close()
  ↓
process.exit()
```

正确：

```text
Host owns process

Runtime owns runtime resources
```

---

## 54. 环境变量读取也要放 Host / Composition

例如：

```text
DESKTOP_AGENT_DATA_DIR
JOJO_E2E
JOJO_BROWSER_SECRET_*
```

不要由 Runtime Kernel 自己读取。

链路：

```text
Host Env
   ↓
Config / Secret Resolver
   ↓
Runtime Composition
   ↓
Runtime Ports
```

---

## 55. SecretResolver

对于 Server / Desktop 共用能力，建议增加：

```ts
export interface SecretResolver {
  resolve(
    request: RuntimeSecretRequest
  ): Promise<RuntimeSecret | undefined>;
}
```

但它应属于：

```text
Capability / Composition
```

而不是 Runtime Kernel 必选 Port。

例如 Browser、MCP OAuth 可按需使用。

---

## 56. Orchestration

当前 SubAgent Runner 已经开始使用：

```text
createAgentRuntime
RuntimeSession
RuntimeLane
lane.run
```

这个方向是正确的。

下一步应进一步让：

```text
Main Agent
SubAgent
Workflow Agent
```

全部进入同一个 Runtime Facade。

最终：

```text
Main
  → lane main

SubAgent
  → lane agent:<id>

Workflow Agent
  → lane workflow:<id>
```

---

## 57. 不要让每个 SubAgent 创建自己的 Runtime Kernel

当前过渡实现会在 leaf execution 中：

```text
createAgentRuntime(...)
...
runtime.close()
```

长期更理想：

```text
一个 AgentRuntime
       │
       ├── main lane
       ├── subagent lanes
       └── workflow lanes
```

这样才能统一：

```text
Session writer
Event sequence
Usage ledger
Recovery
Runtime lifecycle
```

---

## 58. 推荐 RuntimeService / RuntimeRegistry

Composition 层可以维护：

```ts
export interface RuntimeService {
  readonly runtime: AgentRuntime;

  openSession(...): Promise<RuntimeSession>;

  close(): Promise<void>;
}
```

但不要重新发明：

```text
第二套 Session / Lane / Run API
```

它只是 Runtime 实例和 Capability 生命周期容器。

---

## 59. Public Error Contract

Runtime Public API 不应该抛出：

```text
Reducer internal error
SQLite error
Electron IPC error
```

推荐统一：

```ts
type RuntimeError = {
  code: string;
  message: string;
  detail?: JsonValue;
};
```

基础：

```text
runtime_closed
session_not_found
lane_not_found
lane_busy
run_not_found
provider_unavailable
tool_unavailable
permission_denied
approval_unavailable
scope_not_allowed
resume_not_safe
runtime_internal
```

---

## 60. Runtime Result

```ts
type RunResult = {
  runId: string;
  sessionId: string;
  laneId: string;

  status:
    | 'completed'
    | 'failed'
    | 'cancelled';

  stopReason?: string;

  finalText?: string;

  messages: Message[];

  error?: RuntimeError;
};
```

以后 Durable Suspension 真正实现后再扩：

```text
suspended
```

不要提前承诺未实现语义。

---

## 61. Snapshot

Public：

```text
SessionSnapshot
LaneSnapshot
```

只返回行为层信息。

禁止包含：

```text
OperationState
Reducer phase
Pending Effect internals
Interpreter checkpoint
```

Debug 如需要：

```text
testing / diagnostic
```

单独提供。

---

## 62. Runtime Contract Versioning

建议：

```ts
export const RUNTIME_CONTRACT_VERSION = 1;
```

用途：

```text
Runtime Worker IPC
Server runtime bridge
Conformance tests
Serialized snapshot migration
```

Behavior API 使用 SemVer。

---

## 63. Import Boundary CI

增加 ESLint / dependency-cruiser / madge 约束。

### agent-runtime 禁止

```text
electron
apps/desktop
apps/server
fastify
ws
DesktopApi
WorkerCommand
WorkerMessage
BrowserWindow
WebContentsView
```

---

## 64. runtime-composition 禁止

```text
electron
renderer
fastify
WebSocket
parentPort
Desktop IPC DTO
```

---

## 65. apps/desktop 禁止的新依赖

迁移完成后：

```text
@desktop-agent/agent-runtime/compat
```

---

## 66. apps/server 禁止

从第一天开始禁止：

```text
@desktop-agent/agent-runtime/compat
agent-runtime/internal
operation/*
session internal
```

Server 只能依赖：

```text
agent-runtime
runtime-composition
app-service
```

---

## 67. Consumer Contract Tests

必须增加三套消费测试。

### Electron Consumer

验证：

```text
Electron adapter
  ↓
Runtime Public API
```

不再直接调用 compat runner。

### Node Test Consumer

一个普通：

```text
node
```

程序能完整完成：

```text
create runtime
open session
run
tool
event
cancel
close
```

### Headless Server Consumer

一个最小：

```text
apps/runtime-smoke-server
```

或 integration test：

```text
不安装/加载 electron
```

即可跑 Runtime。

---

## 68. 最关键的 Conformance Test

推荐建立：

```text
packages/agent-runtime/src/testing/contract-suite.ts
```

任何 Runtime Host 都跑相同测试：

```text
session create/open
lane create/open
single writer
run success
run cancel
tool lifecycle
approval
event sequence
usage
crash resume
close
scope none
workspace scope
```

---

## 69. Host Matrix

| 能力 | Electron | Test | Headless Server |
|---|---|---|---|
| AgentRuntime | 同一实现 | 同一实现 | 同一实现 |
| RuntimeSession | 同一实现 | 同一实现 | 同一实现 |
| RuntimeLane | 同一实现 | 同一实现 | 同一实现 |
| Runtime Kernel | 同一实现 | 同一实现 | 同一实现 |
| Provider | 配置 Provider | Scripted | 配置 Provider |
| Store | SQLite | Memory | SQLite |
| Approval | Renderer IPC | Deterministic | Remote Broker |
| Browser | Desktop/Chrome Adapter | Fake/Headless | Headless CDP |
| Event Output | IPC Adapter | Collector | WS Adapter |
| Process | UtilityProcess | Node | Node |
| Runtime behavior | 相同 | 相同 | 相同 |

---

## 70. Desktop Worker 重构目标

目标把当前约 50KB 的 `worker.ts` 拆成：

```text
worker.ts
  ├── ipc adapter
  ├── desktop host config
  └── runtime bootstrap
```

而产品逻辑下沉：

```text
runtime-composition
```

---

## 71. 推荐 Desktop Worker 伪代码

```ts
const host = createElectronRuntimeHost({
  dataDirectory,
  parentPort,
  settings,
  secrets
});

const runtimeService = await createJojoRuntime({
  host: {
    kind: 'desktop'
  },

  storage: host.storage,

  providers: host.providers,

  approval: host.approval,

  capabilities: host.capabilities
});

const disposeEvents = runtimeService.runtime.subscribe(
  event => {
    parentPort.postMessage(
      desktopRuntimeEvent(event)
    );
  }
);

parentPort.on('message', async event => {
  await desktopCommandAdapter(
    runtimeService,
    event.data
  );
});
```

可以看到：

```text
worker.ts
```

不再出现：

```text
runAgentTurn
resumeAgentTurn
OperationState
```

---

## 72. Server 伪代码

```ts
const runtimeService = await createJojoRuntime({
  host: {
    kind: 'server'
  },

  storage,

  providers,

  approval: serverApprovalBroker,

  capabilities
});

const appService = createAppService({
  runtime: runtimeService.runtime
});
```

无 Electron。

---

## 73. Test 伪代码

```ts
const runtimeService = await createTestJojoRuntime({
  provider: scriptedProvider,
  approvals: 'deny'
});

const session = await runtimeService.runtime.openSession({
  id: 's1',
  executionScope: {
    kind: 'none'
  }
});

const lane = await session.getLane();

const run = await lane.run({
  input: {
    content: [{
      type: 'text',
      text: 'hello'
    }]
  },
  providerId: 'test',
  model: 'test'
});

expect(
  (await run.result).status
).toBe('completed');
```

---

## 74. Migration Phase R0 — Boundary Freeze

先明确：

```text
root Public API
compat API
SPI
internal
```

工作：

```text
重写 package exports
增加 no-restricted-imports
添加 Contract tests
```

验收：

```text
新代码不能 import compat
新代码不能 import operation/session internals
```

---

## 75. R1 — 补齐 RunRequest

完成：

```text
RuntimeInput
Image input
Run budget
Actor metadata
```

逐步移除 Stable：

```text
history
workingDirectory
```

Compatibility 继续接受旧字段。

---

## 76. R2 — Dynamic Tool Port

实现：

```text
RuntimeToolSource
ToolResolver → ToolSource
```

把 Desktop：

```text
getTools
```

迁到 Environment。

验收：

```text
MCP lazy tools 行为不回归
Skill dynamic tools 行为不回归
```

---

## 77. R3 — Summarizer Port

把：

```text
summarize callback
```

迁到：

```text
RuntimeEnvironment.summarizer
```

验收：

```text
compaction
recovery
token budget
```

与当前 Desktop 行为一致。

---

## 78. R4 — Event Completeness

补齐：

```text
tool.progress
```

检查 Desktop UI 所依赖的核心 AgentEvent。

能进入 Stable RuntimeEvent 的：

```text
迁入 RuntimeEvent
```

内部诊断继续：

```text
TelemetrySink
```

---

## 79. R5 — Runtime Composition

新增：

```text
packages/runtime-composition
```

从 Desktop Worker 抽：

```text
Tool composition
Permission composition
Memory
Hooks
MCP
Skills
Orchestration
Provider resolver
Summarizer
```

验收：

```text
runtime-composition 不 import Electron
```

---

## 80. R6 — Desktop Main Agent 迁移

替换：

```text
runAgentTurn
resumeAgentTurn
```

为：

```text
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
```

保留：

```text
WorkerCommand
WorkerMessage
```

作为 Desktop Transport Adapter。

这样可以避免一次同时重写 Renderer。

---

## 81. R7 — Legacy Message Projection

移除 Runtime 的：

```text
commitMessage callback
```

Desktop 用：

```text
RuntimeEvent
RunResult
```

同步旧 Jsonl UI store。

后续逐步删除双 Store。

---

## 82. R8 — SubAgent / Workflow 共用 Runtime

把现在 LeafAgent 内部：

```text
每次 createAgentRuntime()
```

优化为：

```text
共享 Runtime
+
独立 Lane
```

验收：

```text
main / subagent / workflow
共用 session writer / event sequence / usage ledger
```

---

## 83. R9 — Headless Smoke Program

新增：

```text
apps/runtime-smoke
```

仅 Node：

```bash
pnpm runtime-smoke
```

运行：

```text
create runtime
open session
run scripted provider
tool
event
close
```

CI 强制执行。

---

## 84. R10 — Server 接入

Server 只通过：

```text
Runtime Public API
Runtime Composition
```

接入。

从 Server 第一个 commit 起：

```text
禁止 compat
```

---

## 85. R11 — 删除 Root Compat Export

当 Desktop 主 Agent 已迁移：

root 删除：

```text
runAgentTurn
resumeAgentTurn
RuntimeAgentRunOptions
```

仅：

```text
/compat
```

保留一个迁移周期。

---

## 86. R12 — 删除 Compat

确认：

```text
repo 内无生产代码依赖
```

后完全删除。

测试若需 low-level runner：

```text
改用 testing package
```

---

## 87. 优先级

### P0

```text
R0 Boundary Freeze
R1 Run Input
R2 Dynamic Tool Port
R3 Summarizer Port
R4 Event Completeness
```

这些是 Desktop 迁移前置条件。

### P1

```text
R5 Runtime Composition
R6 Desktop Main Migration
R7 Legacy Projection
R9 Headless Smoke
```

完成后即达到本方案核心目标：

> Electron / Test / Server 可以调用同一 Runtime。

### P2

```text
R8 Shared SubAgent Runtime
R10 Server Integration
R11 Root Compat Removal
R12 Compat Delete
```

---

## 88. 推荐实施顺序

```text
Public Export 收口
        ↓
RunRequest 数据化
        ↓
Dynamic ToolSource
        ↓
Summarizer Environment Port
        ↓
Runtime Event 补齐
        ↓
Runtime Composition 抽离
        ↓
Desktop Main → Public Runtime
        ↓
普通 Node Smoke Test
        ↓
Headless Server
        ↓
SubAgent 共享 Runtime
        ↓
Compat 清理
```

---

## 89. 第一阶段不要做的事

不要同时：

```text
重写 Renderer
重写 HTTP Server
重做 Orchestration
重做 Memory
重做 Hook
重做 Browser
```

先完成：

```text
Runtime Public Boundary
```

再让这些能力通过 Composition 接入。

---

## 90. Public API Stability Rules

Stable 类型新增字段：

```text
优先 optional
```

禁止：

```text
Public API 暴露 implementation class
Public API 暴露 reducer state
Public API 依赖 Desktop DTO
Public API 直接传 callback 解决所有问题
Public API 使用 any / unknown 逃逸类型设计
```

---

## 91. Runtime Environment Stability Rules

Port 应表达：

```text
能力
```

而不是：

```text
当前实现
```

正确：

```text
ApprovalBroker
RuntimeSummarizer
ModelProviderResolver
ToolResolver
```

错误：

```text
ElectronApprovalDialog
OpenAIProviderFactory
McpManagerCallback
DesktopBrowserBridge
```

---

## 92. Capability Package Pattern

继续坚持：

```text
Capability Package
=
能力实现

Runtime Composition
=
能力组合

Runtime Public Contract
=
执行边界

Host Adapter
=
平台接入
```

Browser 是最典型例子。

---

## 93. Definition of Done

Runtime 公共边界稳定化完成的判断标准：

### 代码

```text
apps/desktop 主 Agent
不再 import agent-runtime/compat
```

### Runtime

```text
packages/agent-runtime
无 electron dependency
无 Desktop DTO
无 parentPort
无 HTTP
```

### Test

```text
普通 Node process
可完整跑 Agent Runtime
```

### Server

```text
Server 可直接创建 Runtime
不启动 Electron
```

### Behavior

```text
Electron / Test / Server
共享 Session / Lane / Run 语义
```

### Product Composition

```text
Provider / Tools / Permission / Memory / Hooks
组合规则只有一套
```

### Recovery

```text
Run cancellation
lane busy
resumeOperation
event sequence
三种 Host 语义一致
```

---

## 94. 最终目标目录关系

```text
                   packages/contracts
                          │
                          ▼
                    packages/agent
                          │
                          ▼
                packages/agent-runtime
                  Public │ Internal
                         │
                         ▼
              packages/runtime-composition
                    /        |        \
                   /         |         \
                  ▼          ▼          ▼
          apps/desktop   tests/node   apps/server
```

依赖只允许向下：

```text
Host
 ↓
Composition
 ↓
Runtime Public API
 ↓
Runtime Kernel
 ↓
Agent Core
```

禁止反向：

```text
Runtime → Electron
Runtime → Server
Runtime → Desktop Worker
Runtime → Transport
```

---

## 95. 最终架构

```text
                         AgentRuntime
                             │
                ┌────────────┼────────────┐
                │            │            │
          RuntimeSession RuntimeSession ...
                │
          ┌─────┴──────────────┐
          │                    │
       main lane          subagent lane
          │                    │
         Run                  Run
          │                    │
          └──────────┬─────────┘
                     │
              Runtime Kernel
                     │
        ┌────────────┼────────────┐
        │            │            │
     Provider       Tools       Memory
                     │
             Capability Layer
```

外层：

```text
Electron              Node Test             Server
   │                      │                    │
   └──────────────┬───────┴───────────┬────────┘
                  │                   │
             Host Adapter       Host Adapter
                  └─────────┬─────────┘
                            │
                  Runtime Composition
                            │
                       AgentRuntime
```

---

## 96. 最终结论

Jojo 下一阶段 Runtime 优化的重点，不应该继续增加新的 Runner。

真正需要做的是：

```text
① 把 AgentRuntime 定成唯一执行入口

② 把 Public API 中的 Host callback 清掉

③ 把 Desktop Worker 中的产品 Runtime 组合抽出来

④ 把动态 Tool / Summarizer / Approval 等能力变成 Environment Port

⑤ Session / Lane 成为状态权威，RunRequest 不再自带另一套 history/workspace

⑥ Electron / Test / Server 只做 Host Adapter

⑦ 用同一套 Contract Test 验证三种 Host
```

最终一句话：

> **Electron 不拥有 Runtime，Server 也不拥有 Runtime；它们都只是 Jojo Runtime 的宿主。**

而：

> **AgentRuntime + Runtime Composition 才是 Jojo 真正可复用、可测试、可 Headless、可长期稳定的执行核心。**

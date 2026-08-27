# Jojo Agent HTTP API / Server 最终优化设计（Code-Aligned Final）

> 状态：建议作为 Jojo 后续 Server / Headless / Web / CLI / IM / SDK 能力的最终基线设计  
> 校准时间：2026-08-27  
> 当前代码基线：`zxt6991-source/jojo-agent@045a1ee8c7f1320b344da82c338dc1fc184eb91e`  
> 关联设计：
> - `jojo-runtime-contract-v2-code-aligned.md`
> - `jojo-extension-contract-v2-code-aligned.md`
>
> 核心目标：让 Jojo 从 Desktop-first Agent 演进为 **Runtime-first、Transport-independent、可 Headless、自托管、可多客户端接入的通用 Agent 平台**。

---

# 1. 设计目标

Jojo 当前已经具备：

```text
agent
agent-runtime
orchestration
memory
hooks
extensions
browser-automation
tools-node
providers
storage
desktop
```

并且最新代码已经正式落地：

```text
createAgentRuntime()
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
RuntimeEventEnvelope
ExecutionScope
```

因此 HTTP API / Server 不应该继续被理解为：

```text
给 Desktop Main 增加 HTTP Route
```

也不应该再新增一套：

```text
DefaultJojoSessionRuntime
→ runAgentTurn
→ AgentEvent
```

新的 Server 正确定位是：

> **把已经稳定下来的 Agent Runtime Public Facade 作为执行内核，在其上构建 App Service、Server Core、Public Protocol 和 Transport Adapter。**

---

# 2. 最终架构原则

Jojo Server 必须遵守：

1. `agent-runtime` 不依赖 Server。
2. Server Core 不依赖 HTTP。
3. HTTP / WebSocket 不直接依赖 Electron。
4. Server 不直接调用 `runAgentTurn()`。
5. `runAgentTurn / resumeAgentTurn` 只属于 Compatibility / Internal Harness。
6. Public API 使用 `Run`，不暴露 Runtime 内部 `OperationState`。
7. Public Protocol 不复用 Desktop IPC DTO。
8. Public Protocol 不复用 Worker Command / Worker Message。
9. Server 优先使用 `RuntimeEventEnvelope`，不直接公开 `AgentEvent`。
10. Session 创建从 V1 直接使用 `ExecutionScope`。
11. Approval 在 Server 模式必须保留，禁止自动批准。
12. Browser 是 Capability Package，不是独立 Agent Runtime。
13. Runtime Worker 是可选隔离层，不是 Server 必经层。
14. Snapshot 是 Client UI 的权威状态。
15. 一个 Runtime Lane 同时只允许一个 Active Run。
16. Server Lease 管多客户端所有权，Runtime Lane 管执行并发，两者分层。
17. 所有 mutation API 必须考虑 Idempotency。
18. Secret 不得进入 Transcript / Memory / Hook / Journal / Log。

---

# 3. 总体架构

```text
                         Jojo Clients
          ┌──────────────┼───────────────┐
          │              │               │
       Desktop          Web          CLI / SDK / IM
          │              │               │
       IPC Adapter    HTTP / WS        Client SDK
          │              │               │
          └──────────────┼───────────────┘
                         ▼
                  Jojo App Service
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
 Session Projector  Approval Broker  Workflow Service
          │              │              │
          └──────────────┼──────────────┘
                         ▼
                     RuntimeHost
                    /           \
                   /             \
          InProcessHost       WorkerHost
               │                  │
               │            Runtime Bridge
               │                  │
               └──────────┬───────┘
                          ▼
                    AgentRuntime
                          │
                    RuntimeSession
                          │
                     RuntimeLane
                          │
                         Run
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
           Tools        Memory        Hooks
             │
             ▼
       Capability Packages
      Browser / MCP / Skills / ...
```

---

# 4. 包结构

推荐最终结构：

```text
packages/
├── server-protocol/
│   └── src/
│       ├── version.ts
│       ├── common.ts
│       ├── errors.ts
│       ├── server.ts
│       ├── sessions.ts
│       ├── runs.ts
│       ├── approvals.ts
│       ├── workflows.ts
│       ├── memory.ts
│       ├── browser.ts
│       └── events.ts
│
├── app-service/
│   └── src/
│       ├── service.ts
│       ├── session-service.ts
│       ├── session-projector.ts
│       ├── run-service.ts
│       ├── approval-service.ts
│       ├── workflow-service.ts
│       └── runtime-host.ts
│
├── server-core/
│   └── src/
│       ├── server.ts
│       ├── listener.ts
│       ├── connection.ts
│       ├── live-sessions.ts
│       ├── leases.ts
│       ├── snapshots.ts
│       ├── command-dispatcher.ts
│       └── errors.ts
│
├── server-http/
│   └── src/
│       ├── server.ts
│       ├── auth/
│       ├── routes/
│       ├── websocket/
│       ├── middleware/
│       └── openapi/
│
├── runtime-bridge/
│   └── src/
│       ├── protocol.ts
│       ├── client.ts
│       ├── supervisor.ts
│       ├── electron.ts
│       └── node.ts
│
└── client/
    └── src/
        ├── client.ts
        ├── session.ts
        ├── transport.ts
        ├── http.ts
        └── websocket.ts

apps/
├── desktop/
├── server/
│   └── src/main.ts
└── runtime-worker/
    └── src/main.ts
```

注意：

```text
server-protocol
≠
contracts
```

`contracts` 是 Jojo 通用平台 Contract。

`server-protocol` 只负责：

```text
HTTP / WebSocket Public Wire Protocol
ServerSnapshot
ServerSessionSnapshot
Transcript DTO
Auth Scope
Public Error
Protocol Version
```

---

# 5. 与 `@desktop-agent/contracts` 的关系

Server 不应复制 Runtime Contract。

直接复用：

```text
@desktop-agent/contracts/runtime
├── ExecutionScope
├── SessionInfo
├── LaneInfo
├── RuntimeError
├── RuntimeEvent
├── RuntimeEventEnvelope
├── RunResult
├── RuntimeSessionSnapshot
└── LaneSnapshot
```

Server 自己只定义更高层 Public DTO：

```text
ServerSessionSnapshot
TranscriptItem
PendingApprovalSnapshot
LeaseSnapshot
ServerCapabilities
WorkflowSnapshot
```

---

# 6. Runtime Public Facade 是唯一执行入口

Server 不调用：

```ts
runAgentTurn()
resumeAgentTurn()
```

Server 使用：

```ts
const runtime = createAgentRuntime({
  store,
  environment
});

const session = await runtime.openSession(...);

const lane = await session.getLane('main');

const handle = await lane.run(...);

const result = await handle.result;
```

Crash Recovery：

```ts
await runtime.resumeOperation({
  operationId
});
```

继续对话不是 `resumeOperation()`：

```text
继续对话
=
同一个 RuntimeLane 再次 lane.run()
```

---

# 7. RuntimeHost

Server 不应强制所有执行都走 Worker。

定义：

```ts
export interface RuntimeHost {
  open(): Promise<AgentRuntime>;

  health(): Promise<RuntimeHostHealth>;

  close(): Promise<void>;
}
```

实现：

```text
InProcessRuntimeHost
WorkerRuntimeHost
```

---

# 8. InProcessRuntimeHost

适合：

```text
开发
测试
单用户本地部署
快速 MVP
```

结构：

```text
App Service
    ↓
InProcessRuntimeHost
    ↓
createAgentRuntime()
```

优点：

```text
简单
调试方便
少一层 IPC
快速完成 jojo serve MVP
```

---

# 9. WorkerRuntimeHost

产品化时：

```text
App Service
    ↓
WorkerRuntimeHost
    ↓
runtime-bridge
    ↓
Node Child Process / UtilityProcess
    ↓
AgentRuntime
```

提供：

```text
Crash isolation
Memory isolation
Worker restart
Future worker pool
Desktop / Server 共享执行面
```

因此：

> `runtime-bridge` 是 RuntimeHost 的实现之一，不是 Server Core 的强制依赖。

---

# 10. Public Protocol Version

```ts
export const JOJO_SERVER_PROTOCOL_VERSION = 1;
```

WebSocket Client Hello：

```json
{
  "type": "hello",
  "version": 1,
  "client": {
    "name": "jojo-web",
    "version": "0.1.0"
  }
}
```

Server：

```json
{
  "type": "hello",
  "version": 1,
  "connectionId": "conn_xxx",
  "server": {
    "id": "srv_xxx",
    "version": "0.1.0"
  }
}
```

版本错误：

```json
{
  "type": "hello_error",
  "error": {
    "code": "protocol_version_unsupported",
    "message": "Protocol version is not supported."
  }
}
```

---

# 11. Public DTO 与 Runtime DTO 分层

禁止：

```ts
return runtimeInternalObject;
```

推荐：

```text
RuntimeSessionSnapshot
        ↓
ServerSessionProjector
        ↓
ServerSessionSnapshot
```

Public DTO 不允许出现：

```text
AbortController
Runtime Store
OperationState
Reducer
Interpreter
Raw Provider Header
API Key
OAuth Token
Raw Stack
Tool Implementation Instance
Internal Checkpoint
SQLite Row
```

---

# 12. Session 创建使用 ExecutionScope

HTTP V1 不应该继续把：

```text
workingDirectory
```

作为核心概念。

创建 Workspace Session：

```json
{
  "title": "Repo Analysis",
  "executionScope": {
    "kind": "workspace",
    "workingDirectory": "/workspace/demo"
  }
}
```

General Agent：

```json
{
  "title": "Research",
  "executionScope": {
    "kind": "none"
  }
}
```

未来可扩：

```json
{
  "executionScope": {
    "kind": "custom",
    "type": "sandbox",
    "data": {}
  }
}
```

---

# 13. 不给 General Session 偷偷创建 Workspace

不要：

```text
General Session
    ↓
自动绑定 ~/.jojo/server/workspaces/<sessionId>
```

正确：

```text
scope = none
     ↓
ToolResolver
     ↓
只提供不依赖 Workspace 的 Tool
```

如果以后需要 Scratch：

```text
显式设计 sandbox/scratch scope
```

而不是伪装成 workspace。

---

# 14. Run 是 Public API 概念

内部：

```text
Operation
=
Durable Runtime State Machine
```

Public：

```text
Run
=
一次 RuntimeLane 执行
```

因此 HTTP：

```http
POST /api/v1/sessions/:sessionId/runs
```

Request：

```json
{
  "input": "分析这个项目",
  "providerId": "openai",
  "model": "gpt-5"
}
```

Response：

```http
202 Accepted
```

```json
{
  "runId": "run_xxx",
  "sessionId": "ses_xxx",
  "laneId": "main",
  "status": "running"
}
```

---

# 15. 不暴露 OperationState

禁止 Public API：

```text
GET /operations/:operationId/raw-state
```

Public 只返回：

```text
RunSnapshot
RunResult
RunStatus
RuntimeError
```

内部 `operationId` 可以与 `runId` 当前一一对应，但 Protocol 不承诺永久等价。

---

# 16. Session 与 Lane

一个 Session：

```text
Session
├── main
├── agent:<id>
└── workflow:<id>
```

MVP：

```text
Public API 默认只操作 main lane
```

Sub-Agent / Workflow Lane 可以先通过 Session Snapshot / Workflow Snapshot 暴露。

以后可增加：

```http
GET /api/v1/sessions/:id/lanes
GET /api/v1/sessions/:id/lanes/:laneId
```

但不是 MVP 必需。

---

# 17. Runtime 并发规则

Runtime invariant：

> 一个 Lane 同时最多一个 Active Run。

发生冲突：

```text
runtime_lane_busy
```

Server 映射：

```text
409 session_busy
```

或未来更精确：

```text
409 lane_busy
```

---

# 18. Server Lease 与 Runtime Lock 分离

Server Lease：

```text
Observer Lease
Control Lease
```

Observer：

```text
read snapshot
receive events
```

Control：

```text
start run
cancel
resolve approval
set model
trigger workflow
```

MVP：

```text
一个 Session 最多一个 Control Lease
```

未来：

```text
多个 Lane 可以分别授权 Control
```

---

# 19. LiveSessionManager

```ts
type LiveSession = {
  id: string;

  observers: Set<string>;

  controlOwner?: string;

  runtimeSession: RuntimeSession;

  activeRunIds: Set<string>;

  disposing?: Promise<void>;
};
```

同时：

```ts
openingSessions:
  Map<string, Promise<LiveSession>>
```

防止并发 attach 重复 open。

释放条件：

```text
no observers
AND no control owner
AND no active runs
AND no pending approval
```

---

# 20. ServerSessionSnapshot

Runtime 自己已经有较轻量：

```text
Runtime SessionSnapshot
=
SessionInfo + LaneInfo[]
```

Server 需要更高层：

```ts
type ServerSessionSnapshot = {
  id: string;
  title?: string;

  executionScope: ExecutionScope;

  revision: number;

  runtime: RuntimeSessionSnapshot;

  activeRuns: RunSummary[];

  transcript: TranscriptItem[];

  pendingApprovals: ApprovalSnapshot[];

  lease: LeaseSnapshot;

  provider?: {
    id: string;
    model: string;
  };

  usage?: UsageSnapshot;

  workflow?: WorkflowSessionSnapshot;
};
```

原则：

```text
ServerSessionSnapshot
=
Client UI Source of Truth
```

---

# 21. Snapshot 与 Event

```text
Event
=
incremental UX optimization

Snapshot
=
authoritative UI state
```

Client 断线后：

```text
重新获取 Snapshot
```

即可恢复。

不要依赖无限 Event Replay。

---

# 22. RuntimeEventEnvelope 作为稳定 Streaming 来源

Runtime 已经提供：

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

Server：

```text
AgentRuntime.subscribe()
     ↓
RuntimeEventEnvelope
     ↓
Server Event Mapper
     ↓
WebSocket
```

---

# 23. AgentEvent 只属于 Diagnostic Channel

当前 `TelemetrySink` 继续用于：

```text
context.updated
memory.*
hook.*
low-level tool progress
internal diagnostics
```

链路：

```text
AgentEvent
   ↓
TelemetrySink
   ↓
DiagnosticEvent
```

Public Client 不应该默认依赖 AgentEvent Shape。

---

# 24. Event Sequence

Runtime Event 已有：

```text
sequence
```

这是：

```text
sessionSeq
```

Server WebSocket 还需要：

```text
connectionSeq
```

推荐：

```json
{
  "type": "event",
  "seq": 481,
  "sessionSeq": 35,
  "sessionId": "ses_x",
  "event": {}
}
```

语义：

```text
seq
=
本 WebSocket connection 投递顺序

sessionSeq
=
Runtime Session 内事件顺序
```

---

# 25. Gap Recovery

Client 收到：

```text
seq 480
seq 482
```

则：

```text
refresh ServerSnapshot / ServerSessionSnapshot
```

不要要求 Server 保存无限 WebSocket Event History。

---

# 26. HTTP 与 WebSocket 分工

REST：

```text
resource
snapshot
create
async mutation start
health
metadata
```

WebSocket：

```text
runtime stream
approval
workflow progress
session change
server notification
```

---

# 27. HTTP API V1

Base：

```text
/api/v1
```

Server：

```http
GET /healthz
GET /readyz

GET /api/v1/server
GET /api/v1/capabilities
GET /api/v1/models
```

Sessions：

```http
GET    /api/v1/sessions
POST   /api/v1/sessions
GET    /api/v1/sessions/:sessionId
PATCH  /api/v1/sessions/:sessionId
DELETE /api/v1/sessions/:sessionId
```

Runs：

```http
POST /api/v1/sessions/:sessionId/runs
GET  /api/v1/sessions/:sessionId/runs/:runId
POST /api/v1/sessions/:sessionId/runs/:runId/cancel
```

---

# 28. Steer / Follow-up 不进入 Server MVP

当前 Runtime Public API 尚未提供：

```text
steer()
followUp()
```

因此 Server V1 不应自己实现一套。

MVP 暂时只支持：

```text
run
cancel
next run
```

也就是：

```text
当前 Run 结束
    ↓
下一次 lane.run()
```

---

# 29. Steer / Follow-up 的正确未来位置

以后如果需要：

```text
Steer
Follow-up queue
```

必须先进入 Runtime Contract。

例如：

```ts
run.steer(input)

lane.enqueue({
  mode: 'follow_up',
  input
});
```

确定 Runtime semantics 后：

```text
Desktop
Server
CLI
IM
```

统一复用。

禁止 Server App Service 自己修改 Agent Message Queue。

---

# 30. WebSocket Commands

V1：

```text
server.snapshot

session.list
session.create
session.attach
session.detach

run.start
run.cancel

approval.resolve
```

后续：

```text
workflow.run
workflow.cancel
memory.status
browser.replay
session.set_model
session.bind_scope
```

暂不加入：

```text
session.steer
session.follow_up
```

直到 Runtime Contract 支持。

---

# 31. Approval 是 Server V1 必须能力

禁止：

```text
server
  ↓
headless
  ↓
auto approve
```

Runtime 已有：

```ts
interface ApprovalBroker {
  requestApproval(
    request,
    context,
    signal
  ): Promise<boolean>;
}
```

Server 实现：

```text
ServerApprovalBroker
├── PendingApprovalStore
├── Event Publisher
└── resolve()
```

---

# 32. Approval 链路

```text
Agent Runtime
      ↓
approval.required
      ↓
ServerApprovalBroker
      ↓
PendingApprovalStore
      ↓
ServerSessionSnapshot + WS Event
      ↓
Client
      ↓
approval.resolve
      ↓
ServerApprovalBroker.resolve()
      ↓
原 Run 继续
```

---

# 33. Approval 与 Connection 解耦

Approval 绑定：

```text
sessionId
laneId
runId
approvalId
```

不绑定：

```text
WebSocket connection
```

因此：

```text
Client A 发起
   ↓
断线
   ↓
Client B attach
   ↓
看到 Pending Approval
   ↓
继续 resolve
```

---

# 34. Approval 当前 Durable 限制

当前 Runtime Event 已预留：

```text
run.suspended
run.resumed
```

但 Runtime 并未完整实现：

```text
durable approval suspension
```

因此 V1 定义：

```text
Approval 等待由 ServerApprovalBroker 持有
Run 保持等待
```

Worker Crash：

```text
Run interrupted
```

不能假装已经 Durable Suspended。

未来 Runtime Contract 完成 durable suspension 后再升级。

---

# 35. Browser 在 Server 中的位置

Browser 现在已经是：

```text
packages/browser-automation
```

能力模型：

```text
BrowserDriver
BrowserSession
BrowserPage
Chrome CDP
Headless Browser Host
Recording
Replay
Healing
```

因此：

```text
Server
  ↓
Browser Tool / Browser Service Adapter
  ↓
BrowserDriver
  ↓
HeadlessBrowserHost / Chrome CDP
```

Server 不依赖：

```text
Electron WebContentsView
BrowserWindow
Desktop Dock
```

---

# 36. Browser Public API

第一阶段只建议：

```http
GET  /api/v1/browser/recordings
POST /api/v1/browser/recordings/:id/replay
```

不要优先公开：

```text
click
type
eval
hover
cookie
```

这些继续走 Agent Tool + Permission。

---

# 37. Browser Secret

Server 无 Desktop Masked Dialog。

Secret 来源：

```text
Environment
Secret Store
Out-of-band Client Input
```

缺 Secret：

```json
{
  "type": "secret_required",
  "request": {
    "id": "sec_x",
    "name": "password",
    "description": "Login password"
  }
}
```

Resolve：

```http
POST /api/v1/secrets/:id/resolve
```

---

# 38. Secret 禁止流入

```text
Transcript
Memory
Hook Payload
Workflow Journal
Browser Recording YAML
Server Log
Audit Detail
WebSocket Diagnostic
```

Server Secret Request 应只保存：

```text
id
name
description
state
expiry
```

Secret value 默认只在内存中短时存在。

---

# 39. Memory API

第一阶段只开放治理/管理：

```http
GET    /api/v1/memory/status
GET    /api/v1/memory/entries
POST   /api/v1/memory/rebuild

POST   /api/v1/memory/candidates/:id/accept
POST   /api/v1/memory/candidates/:id/reject
DELETE /api/v1/memory/entries/:id
```

Agent 内部 Memory 继续走：

```text
MemoryRuntime
Memory Tool
Context
```

Server 不重写 Memory Engine。

---

# 40. Workflow API

```http
GET  /api/v1/workflows
POST /api/v1/workflows/:workflowId/runs

GET  /api/v1/workflow-runs/:runId
POST /api/v1/workflow-runs/:runId/cancel
POST /api/v1/workflow-runs/:runId/resume
```

Workflow 继续由：

```text
packages/orchestration
```

负责：

```text
DAG
retry
timeout
budget
resource group
journal
resume
```

Server 只做调用和 projection。

---

# 41. Sub-Agent API

MVP 不做独立完整 CRUD。

通过：

```text
Session Snapshot
Workflow Snapshot
Orchestration Event
```

暴露。

以后如需要：

```http
GET /api/v1/sessions/:id/subagents
GET /api/v1/subagents/:id
```

再补。

---

# 42. REST 与 WebSocket 共用 Command Dispatcher

禁止：

```text
REST createSession()
WS createSession()
```

两套逻辑。

统一：

```text
REST ──────┐
WS ────────┼── CommandDispatcher
CLI ───────┘
                  ↓
             App Service
```

统一处理：

```text
AuthZ
Lease
Idempotency
Concurrency
Audit
Error Mapping
```

---

# 43. App Service

推荐：

```ts
interface JojoAppService {
  listSessions(ctx: RequestContext): Promise<ServerSessionSummary[]>;

  createSession(
    ctx: RequestContext,
    input: CreateSessionInput
  ): Promise<ServerSessionSnapshot>;

  getSession(
    ctx: RequestContext,
    sessionId: string
  ): Promise<ServerSessionSnapshot>;

  startRun(
    ctx: RequestContext,
    sessionId: string,
    input: StartRunInput
  ): Promise<RunAccepted>;

  cancelRun(
    ctx: RequestContext,
    sessionId: string,
    runId: string
  ): Promise<void>;

  resolveApproval(
    ctx: RequestContext,
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<void>;
}
```

App Service 不 import：

```text
Fastify
Electron
Renderer
WebSocket library
```

---

# 44. SessionProjector

职责：

```text
RuntimeSessionSnapshot
+
Session Entry Transcript
+
Pending Approval
+
Server Metadata
+
Lease
+
Workflow
     ↓
ServerSessionSnapshot
```

所有 Client：

```text
Desktop
Web
CLI
IM
```

尽量共享 Projection 逻辑。

---

# 45. Session Metadata

Server 自己可以维护：

```text
title
labels
favorite
default provider
default model
createdBy
lastOpenedAt
```

这些不是 Runtime Kernel 状态。

不要塞进 Runtime OperationState。

---

# 46. Provider / Model

Runtime 继续通过：

```text
RuntimeEnvironment.providers
```

解析 ModelProvider。

Server：

```http
GET /api/v1/models
```

来自：

```text
Provider Registry / Capability Registry
```

不要由 HTTP 层硬编码模型。

---

# 47. Capability Discovery

```json
{
  "capabilities": {
    "runtime": {
      "lanes": true,
      "resumeOperation": true,
      "steer": false,
      "followUp": false,
      "durableSuspend": false
    },
    "workflow": true,
    "browser": true,
    "memory": true,
    "subagents": true,
    "images": true,
    "approvals": true
  }
}
```

Client 应依赖 Capability，而不是猜版本。

---

# 48. Authentication

默认：

```yaml
server:
  host: 127.0.0.1
  port: 7788
```

默认禁止：

```text
0.0.0.0
```

Local Token：

```text
~/.jojo/server/token
```

Unix：

```text
0600
```

Client：

```http
Authorization: Bearer <token>
```

---

# 49. Principal

Transport 鉴权后：

```ts
type Principal = {
  id: string;

  type:
    | 'local'
    | 'token'
    | 'service';

  scopes: string[];
};
```

Server Core 不解析：

```text
Authorization
Cookie
JWT
```

---

# 50. Scope

未来：

```text
sessions:read
sessions:write
runs:start
runs:cancel
workflows:run
memory:read
memory:write
browser:use
approvals:resolve
admin
```

MVP 可以只有 Admin Token，但 Domain 不假设永远单用户。

---

# 51. Workspace Security

当：

```text
executionScope.kind == workspace
```

必须检查 Allowed Roots：

```yaml
server:
  workspaceRoots:
    - ~/projects
    - /data/agent-workspaces
```

校验：

```text
realpath
symlink
ancestor boundary
```

禁止：

```text
/
$HOME
```

作为默认 Allowed Root。

---

# 52. ExecutionScope Authorization

Server 创建 Session 前：

```text
Client ExecutionScope
       ↓
ScopePolicy
       ↓
Authorized ExecutionScope
       ↓
runtime.openSession()
```

对于：

```text
kind = none
```

不需要 workspace root。

对于：

```text
kind = custom
```

必须由注册的 Scope Handler 明确授权。

---

# 53. Idempotency

所有 mutation：

```text
session create
run start
workflow run
approval resolve
browser replay
memory mutation
```

支持：

```http
Idempotency-Key: <uuid>
```

记录：

```text
principal
route
key
request hash
result
createdAt
expiry
```

同 Key 不同 Request Hash：

```text
409 idempotency_conflict
```

---

# 54. Error Model

```ts
type ProtocolError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonValue;
  requestId?: string;
};
```

基础：

```text
protocol_version_unsupported
unauthorized
forbidden
not_found
invalid_request
session_busy
lane_busy
session_locked
approval_required
approval_expired
run_not_found
run_cancelled
runtime_unavailable
rate_limited
payload_too_large
scope_not_allowed
workspace_not_allowed
provider_error
internal_error
```

---

# 55. HTTP Mapping

```text
400 invalid_request
401 unauthorized
403 forbidden
404 not_found
409 session_busy / lane_busy
413 payload_too_large
423 session_locked
429 rate_limited
503 runtime_unavailable
500 internal_error
```

内部 Stack：

```text
只写 Server Log
```

---

# 56. Fastify

`server-http` 推荐 Fastify。

原因：

```text
Node/TS 生态成熟
Route 生命周期
Body Limit
Request ID
WebSocket
OpenAPI
Auth plugin
Rate limit
```

但 Fastify 只能存在：

```text
packages/server-http
```

禁止：

```text
app-service import fastify
server-core import fastify
agent-runtime import fastify
```

---

# 57. Schema Source of Truth

Jojo 继续使用 Zod。

推荐：

```text
Zod Schema
   ↓
JSON Schema
   ↓
OpenAPI
```

不要再维护：

```text
一份 TS Type
一份 JSON Schema
一份 OpenAPI Schema
```

三套重复定义。

---

# 58. Remote Mode

显式：

```bash
jojo serve \
  --host 0.0.0.0 \
  --allow-remote
```

至少要求：

```text
Token
```

推荐：

```text
TLS
或可信 Reverse Proxy
```

CORS：

```text
default deny
```

优先：

```text
same-origin Web UI
```

---

# 59. Runtime Worker Crash

Worker 退出：

```text
active Run
   ↓
runtime unavailable
   ↓
mark interrupted
   ↓
broadcast ServerSessionSnapshot
```

Worker 重启后：

```text
AgentRuntime.resumeOperation()
```

只对可安全恢复 Operation 使用。

---

# 60. Replay

继续遵守现有 Tool：

```text
replay = safe | never
```

`never`：

```text
不能自动重放
```

Worker Crash 后：

```text
interrupted / manual recovery
```

而不是自动再执行。

---

# 61. Backpressure

每个 WS Connection 限制：

```text
maxPendingBytes
maxPendingEvents
```

策略：

```text
critical
  不丢

snapshot
  coalesce

assistant.delta
  merge

usage.updated
  coalesce

diagnostic progress
  可丢旧值
```

超硬上限：

```text
disconnect slow consumer
```

---

# 62. Limits

建议：

```text
Prompt text       100 KB
Image             10 MB / image
Image count       4
Normal JSON Body  1 MiB
WS frame          bounded
```

同时 Runtime Event / Agent Event 本身已有大小限制，也应在 Adapter 层二次校验。

---

# 63. Rate Limit

至少区分：

```text
read
mutation
run start
auth failure
approval resolve
browser replay
```

以后按 Principal / Token / IP 组合限流。

---

# 64. Audit

记录：

```text
requestId
principalId
method
route
sessionId
laneId
runId
approvalId
toolName
decision
durationMs
errorCode
```

禁止：

```text
Authorization
API Key
OAuth token
Cookie value
Secret
完整敏感 Tool Input
```

---

# 65. Health / Ready

```http
GET /healthz
```

表示：

```text
Server process alive
```

```http
GET /readyz
```

表示：

```text
storage ready
runtime host ready
config loaded
```

Worker unavailable：

```text
healthz = 200
readyz  = 503
```

---

# 66. Graceful Shutdown

```text
SIGTERM
  ↓
server = draining
  ↓
停止新 mutation
  ↓
关闭 Listener 新连接
  ↓
广播 shutdown
  ↓
等待安全停点
  ↓
cancel remaining run
  ↓
persist
  ↓
close RuntimeHost
  ↓
close storage
```

禁止直接：

```ts
process.exit()
```

---

# 67. Client SDK

建议：

```text
packages/client
```

上层：

```ts
const client = new JojoClient({
  baseUrl,
  token
});

await client.connect();

const session = await client.createSession({
  executionScope: {
    kind: 'workspace',
    workingDirectory: '/workspace'
  }
});

const run = await session.run('分析这个项目');

run.subscribe(...);

await run.result();
```

---

# 68. Client SDK 隐藏

```text
HTTP
WebSocket
Request Correlation
Reconnect
Lease
Snapshot Refresh
Idempotency Key
Protocol Version
```

第一版：

```text
reconnect()
```

可以显式调用，避免隐式 retry 导致重复副作用。

---

# 69. Desktop 是否改成 localhost HTTP

不建议。

正确：

```text
Desktop IPC
     ↓
App Service

HTTP/WS
     ↓
App Service
```

而不是：

```text
Desktop
   ↓
localhost HTTP
   ↓
Server
```

---

# 70. Desktop 与 Server 共用什么

共用：

```text
App Service
Session Projector
RuntimeHost interface
Runtime Public Contract
Provider Registry
Tool Registry
Hook Runtime
Memory Runtime
Orchestration
```

不共用：

```text
HTTP Auth
WebSocket Connection
CORS
Electron IPC DTO
Renderer DTO
```

---

# 71. `jojo serve`

```text
apps/server
```

命令：

```bash
jojo serve
```

参数：

```text
--host
--port
--data-dir
--workspace-root
--token-file
--allow-remote
--log-level
--runtime-mode
--browser-mode
```

---

# 72. Runtime Mode

```text
--runtime-mode in-process
--runtime-mode worker
```

开发默认可以：

```text
in-process
```

产品默认推荐：

```text
worker
```

---

# 73. Scheduler

同进程：

```text
Scheduler
   ↓
App Service
```

独立：

```text
Scheduler
   ↓
Jojo Client SDK
```

---

# 74. IM

```text
Telegram / Slack / Discord / WeChat
                ↓
          Channel Adapter
                ↓
      App Service / Client SDK
```

Hook transport：

```text
im
```

---

# 75. Web UI

```text
Static Web UI
   ↓ REST
   ↓ WebSocket
Jojo Server
```

优先 same-origin 部署。

---

# 76. Conformance Test Kit

推荐：

```text
packages/server-core/testing
```

提供：

```text
createTestServer
TestRuntimeHost
TestAppService
ProtocolTestClient
InMemoryListener
```

---

# 77. 测试层级

Protocol：

```text
schema
version
unknown field
sensitive exclusion
```

App Service：

```text
session
run
cancel
approval
scope
```

Server Core：

```text
attach
detach
lease
dispose
concurrency
revision
```

WebSocket：

```text
hello
auth
correlation
seq
slow consumer
```

HTTP：

```text
validation
status
idempotency
body limit
auth
```

Crash：

```text
worker crash
client disconnect
shutdown
interrupted recovery
```

---

# 78. 不推荐：HTTP Route 直接调用 runAgentTurn

禁止：

```text
HTTP Handler
   ↓
runAgentTurn()
```

原因：

```text
绕过 Runtime Public Contract
重复 Session 生命周期
绕过 Lane 并发
绕过 RuntimeEvent
增加未来 Breaking Change
```

---

# 79. 不推荐：再做 DefaultJojoSessionRuntime

旧设计：

```text
DefaultJojoSessionRuntime
  ↓
runAgentTurn
```

现在应该删除。

现有：

```text
AgentRuntime
RuntimeSession
RuntimeLane
```

已经承担 Runtime 生命周期。

Server 只需要：

```text
ServerSessionController / App Service
```

做更高层业务编排。

---

# 80. 不推荐：Public API 暴露 Operation

Public：

```text
Run
```

Internal：

```text
Operation
```

不要把：

```text
OperationState
Effect State
Program Counter
StoredOperation
```

变成远程 SDK Contract。

---

# 81. 不推荐：Server 自己实现 Steer

在 Runtime Public Contract 之前：

```text
Server 不实现 steer / follow-up
```

否则 Desktop / Server 会再次产生两套执行行为。

---

# 82. 不推荐：Browser 与 Agent Runtime 并列

错误：

```text
Agent Runtime
Workflow Runtime
Browser Runtime
```

更准确：

```text
Agent Runtime
Orchestration
    ↓
Capability Packages
    ↓
Browser
```

---

# 83. 不推荐：Runtime Bridge 强制必经

错误：

```text
App Service
    ↓
runtime-bridge
```

正确：

```text
App Service
    ↓
RuntimeHost
   /      \
InProc   Worker
```

---

# 84. 不推荐：所有接口只做 WebSocket

资源读取：

```text
REST 更合适
```

Streaming：

```text
WebSocket 更合适
```

保持混合模式。

---

# 85. 不推荐：所有接口只 REST Polling

Agent 天然：

```text
Streaming
Approval
Tool Progress
Workflow Event
```

必须有事件通道。

---

# 86. 开发阶段

## S0 — Server 前置 Contract 收口

完成：

```text
Runtime Public Facade
contracts/runtime
ExecutionScope
RuntimeEventEnvelope
Run API
```

当前已经基本完成。

剩余：

```text
Approval Broker server semantics
steer/follow-up decision
durable suspension boundary
```

---

## S1 — Server Protocol

新增：

```text
packages/server-protocol
```

实现：

```text
version
hello
error
server snapshot
server session snapshot
run DTO
approval DTO
request/response/event envelope
```

验收：

```text
Zod runtime validation
version mismatch
secret exclusion
Runtime DTO reuse
```

---

## S2 — App Service

新增：

```text
packages/app-service
```

实现：

```text
session service
run service
session projector
approval service
runtime host
```

验收：

```text
不 import Electron
不 import Fastify
不 import agent-runtime internal
```

---

## S3 — RuntimeHost

先实现：

```text
InProcessRuntimeHost
```

确保 Server 能快速跑起来。

接口从一开始就允许：

```text
WorkerRuntimeHost
```

---

## S4 — Server Core

新增：

```text
packages/server-core
```

实现：

```text
JojoServer
Listener
Connection
LiveSessionManager
LeaseManager
SnapshotPublisher
CommandDispatcher
```

---

## S5 — WebSocket

实现：

```text
auth
hello
correlation
runtime events
snapshot event
backpressure
disconnect
```

---

## S6 — REST

实现：

```text
health
ready
server
capabilities
models
sessions
runs
cancel
run snapshot
```

---

## S7 — Approval

实现：

```text
ServerApprovalBroker
PendingApprovalStore
approval event
resolve API
disconnect persistence in process lifetime
```

---

## S8 — Client SDK

实现：

```text
connect
listSessions
createSession
attach
subscribe
run
cancel
approval
snapshot refresh
```

---

## S9 — WorkerRuntimeHost / Runtime Bridge

实现：

```text
NodeChildProcessTransport
WorkerSupervisor
WorkerRuntimeHost
```

Desktop 后续可复用：

```text
ElectronUtilityProcessTransport
```

---

## S10 — Workflow

实现：

```text
run
cancel
resume
snapshot
events
```

---

## S11 — Browser / Memory

实现：

```text
Browser Recording API
Browser Replay
Memory governance API
secret_required
```

---

## S12 — jojo serve 产品化

实现：

```text
Loopback default
Token
Workspace allowlist
Remote mode
Graceful shutdown
Health
Ready
Logs
Runtime mode
Config
```

---

# 87. MVP 范围

第一版只做：

```text
Server Info
Capabilities
Model List

Session List
Create Session
Attach / Detach

Run Start
Run Cancel
Run Result

Assistant Streaming
Tool Lifecycle
Usage

Approval
ServerSessionSnapshot
```

暂不做：

```text
Steer
Follow-up
IM
Scheduler
完整 Web UI
Browser 低层控制
Memory 全 CRUD
Plugin Marketplace
Distributed Worker
Cloud Multi-tenant
```

---

# 88. MVP 端到端

```text
Client
  │
  ▼
Auth
  │
  ▼
WebSocket Hello
  │
  ▼
ServerSnapshot
  │
  │ session.create
  ▼
App Service
  │
  ▼
RuntimeHost
  │
  ▼
AgentRuntime
  │
  ▼
RuntimeSession
  │
  ▼
RuntimeLane(main)
  │
  │ lane.run()
  ▼
RunHandle
  │
  ├── assistant.delta
  ├── tool.started
  ├── approval.required
  ├── usage.updated
  └── run.completed
  │
  ▼
RuntimeEventEnvelope
  │
  ▼
Server Event Mapper
  │
  ▼
WebSocket Client
```

---

# 89. Approval MVP

```text
Runtime
   │
   ▼
ServerApprovalBroker
   │
   ├── PendingApproval
   ├── WS Event
   └── Snapshot
            │
            ▼
          Client
            │
            ▼
approval.resolve
            │
            ▼
ServerApprovalBroker
            │
            ▼
Run continues
```

---

# 90. 最终依赖方向

```text
contracts
   ↑
agent
   ↑
agent-runtime
   ↑
orchestration

server-protocol
   ↑
app-service
   ↑
server-core
   ↑
server-http / client / apps-server
```

Capability：

```text
browser-automation
hooks
providers
memory
extensions
tools-node
```

由 Composition Root 注入。

禁止：

```text
agent-runtime -> server
agent-runtime -> fastify
agent-runtime -> electron
server-core -> electron
server-core -> fastify
```

---

# 91. 与 Runtime Contract 的对应关系

```text
Runtime Contract
负责：
Session
Lane
Run
RuntimeEvent
ExecutionScope
Approval Port
Crash Resume

Server
负责：
Principal
Lease
Connection
Public Protocol
Server Snapshot
Idempotency
Remote Security
Backpressure
Rate Limit
```

---

# 92. 与 Extension Contract 的对应关系

```text
Extension Contract
负责：
Tool Contribution
Hook Contribution
Context Contribution
Provider/Profile/Workflow Preview

Server
不重新实现这些 Registry
```

Server 只通过 Composition Root 获取：

```text
ToolResolver
ModelProviderResolver
HookRuntime
MemoryRuntime
Capability Registry
```

---

# 93. 最终结论

Jojo HTTP API / Server 的目标不再是：

```text
把 Desktop 逻辑搬到 Node Server
```

而是：

```text
把已经稳定的 Runtime Public Contract
包装成可远程访问的 Application Platform
```

最终核心关系：

```text
Runtime Contract
=
执行边界

Extension Contract
=
能力接入边界

App Service
=
业务用例边界

Server Core
=
连接 / Session / Lease / Snapshot 边界

Server Protocol
=
远程兼容边界

HTTP / WebSocket
=
Transport
```

一句话：

> **Jojo Server 不再拥有 Agent Runtime，它只是 Runtime Public Contract 的远程控制面。**

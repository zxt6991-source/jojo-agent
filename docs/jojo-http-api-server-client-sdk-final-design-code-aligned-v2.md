# Jojo Agent Headless Server / HTTP API / Client SDK 最终设计（Code-Aligned V2）

> 状态：建议作为 Jojo 后续 Headless Server / HTTP API / WebSocket / Client SDK / Web / CLI / IM 接入能力的最终实施基线  
> 校准日期：2026-08-27  
> 当前代码基线：`zxt6991-source/jojo-agent@16af09f7f778752d27b3cd83a2aa722f02667271`  
> 前一版文档基线：`045a1ee8c7f1320b344da82c338dc1fc184eb91e`  
> 关键后续提交：`7ea3028f7104ab4505b56de16f583e0429e64553`（稳定 Runtime 公共边界）  
> 关联设计：
>
> - `jojo-runtime-contract-v2-code-aligned.md`
> - `jojo-runtime-public-boundary-stabilization-final-design.md`
> - `jojo-extension-contract-v2-code-aligned.md`
> - `jojo-agent-agent-loop-safety-final-design.md`
> - `jojo-agent-hooks-design.md`
> - `jojo-agent-pi-harness-technical-design.md`
>
> 核心目标：
>
> **让 Jojo 从 Desktop-first Agent 演进为 Runtime-first、Transport-independent、可 Headless、自托管、可多客户端接入、可通过 SDK 进行远程控制的通用 Agent Platform。**

---

# 0. 最终结论

Jojo 当前已经不再处于：

```text
“能不能实现 Headless？”
```

这个阶段。

当前代码已经实际证明：

```text
Plain Node
   ↓
runtime-composition
   ↓
AgentRuntime
   ↓
RuntimeSession
   ↓
RuntimeLane
   ↓
RunHandle
```

可以在：

```text
无 Electron
无 Renderer
无 IPC
无 UtilityProcess
无 Desktop Main
```

的情况下正常运行。

当前已经存在：

```text
packages/runtime-composition
packages/app-service
apps/server
```

以及：

```text
createJojoRuntime()
createRuntimeAppService()
createHeadlessServer()
```

并有纯 Node Headless Contract Test。

因此：

> **Headless Runtime 已经成立。**

但当前：

```text
apps/server
```

仍然只是：

```text
Headless Application Host
```

而不是完整的：

```text
Network Headless Server
```

当前尚未完整实现：

```text
HTTP Listener
REST API
WebSocket
Authentication
Server Protocol
Server Core
Lease
Run Registry
Remote Approval Broker
Client SDK
jojo serve
```

因此接下来真正要完成的是：

```text
Headless Runtime
      ↓
Headless App Service
      ↓
Server Core
      ↓
HTTP / WebSocket
      ↓
Client SDK
```

本方案的核心判断：

1. **原 HTTP Server 设计方向正确，不需要推翻。**
2. **文档必须更新，因为旧文档的 Code-Aligned 基线已经过期。**
3. **`runtime-composition` 必须正式进入 Server 架构。**
4. **Client SDK 可以实现，但必须先补齐查询面、Run 持久查询、Transcript、Lease 和重连语义。**
5. **Server 不重新实现 Agent Runtime，只构建 Runtime 的远程控制面。**

---

# 1. 当前代码真实状态

当前代码已经正式存在：

```text
packages/
├── agent
├── agent-runtime
├── app-service
├── browser-automation
├── contracts
├── extensions
├── hooks
├── memory
├── orchestration
├── providers
├── runtime-composition
├── storage
└── tools-node

apps/
├── desktop
├── server
└── ...
```

其中：

```text
agent-runtime
```

已经提供：

```text
createAgentRuntime()
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
RuntimeEventEnvelope
ExecutionScope
```

`runtime-composition` 已经提供：

```text
createJojoRuntime()
RuntimeEnvironmentBuilder
RuntimeEnvironmentRegistry
```

`app-service` 已经提供最小：

```text
openSession
getSession
run
cancel
getLane
subscribe
close
```

`apps/server` 已经提供：

```text
createHeadlessServer()
```

其结构已经是：

```text
createHeadlessServer()
        ↓
createJojoRuntime()
        ↓
AgentRuntime
        ↓
RuntimeAppService
```

因此新的 Server 设计必须建立在这些已经落地的代码之上。

---

# 2. 当前 Headless 能力定义

必须区分三个概念。

## 2.1 Headless Runtime

```text
createJojoRuntime()
       ↓
AgentRuntime
```

特征：

```text
不启动 Electron
不启动 Renderer
不启动 IPC
不启动 UtilityProcess
```

这是当前已经实现的能力。

---

## 2.2 Headless Application

```text
AgentRuntime
    ↓
RuntimeAppService
```

提供：

```text
Session use case
Run use case
Cancel use case
Runtime event subscription
```

当前已经存在最小实现。

---

## 2.3 Network Headless Server

```text
RuntimeAppService
       ↓
Server Core
       ↓
HTTP / WebSocket
       ↓
Remote Clients
```

这才是最终：

```bash
jojo serve
```

需要实现的东西。

因此后续不要继续把：

```text
createHeadlessServer()
```

直接等价理解为：

```text
HTTP Server
```

建议后续代码命名进一步收口为：

```text
createHeadlessApplication()
createJojoServer()
```

或者保留现有 API，但文档必须明确语义。

---

# 3. 最终架构原则

Jojo Server 必须遵守：

1. `agent-runtime` 不依赖 Server。
2. `runtime-composition` 不依赖 HTTP。
3. `app-service` 不依赖 HTTP / Electron。
4. Server Core 不依赖 Fastify。
5. HTTP / WebSocket 不直接调用 Runtime Kernel。
6. Server 不直接调用 `runAgentTurn()`。
7. `runAgentTurn / resumeAgentTurn` 只属于 compat / internal harness。
8. Public Remote API 使用 `Run`，不暴露 `OperationState`。
9. Public Protocol 不复用 Desktop IPC DTO。
10. Public Protocol 不复用 Worker Command / Worker Message。
11. Streaming 优先来自 `RuntimeEventEnvelope`。
12. `AgentEvent` 只作为 Diagnostic Source。
13. Session V1 使用 `ExecutionScope`。
14. Approval 在 Server 模式必须保留。
15. Headless 不等于 auto-approve。
16. Browser 是 Capability，不是独立 Agent Runtime。
17. Runtime Worker 是可选 Runtime Backend。
18. Snapshot 是 Client 恢复状态的权威来源。
19. Event 是增量优化，不是唯一状态源。
20. 一个 Runtime Lane 同时最多一个 Active Run。
21. Server Lease 与 Runtime Lane Lock 分层。
22. 所有 mutation API 必须支持或预留 Idempotency。
23. Secret 不进入 Transcript / Memory / Hook / Journal / Log。
24. Client SDK 不依赖 `agent-runtime`。
25. Client SDK 与 Server 共用 `server-protocol`。
26. Server 查询能力不得通过偷用 Runtime Internal / SPI 实现。
27. Runtime 公共查询面不足时，先补 Public Contract。
28. Reconnect 后必须可以通过 Snapshot + Run Query 恢复状态。

---

# 4. 最终总体架构

```text
                             Jojo Clients
                ┌───────────────┼────────────────┐
                │               │                │
             Desktop           Web          CLI / SDK / IM
                │               │                │
            IPC Adapter      HTTP / WS        Client SDK
                │               │                │
                └───────────────┼────────────────┘
                                ▼
                         Jojo App Service
                                │
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                      ▼
 Session Service          Run Service          Approval Service
          │                     │                      │
          ├─────────────── Session Projector ─────────┤
          │                                            │
          └─────────────────────┬──────────────────────┘
                                ▼
                         Runtime Backend
                       /                 \
                      /                   \
            InProcess Backend        Worker Backend
                    │                     │
                    │              runtime-bridge
                    │                     │
                    └───────────┬─────────┘
                                ▼
                         Runtime Composition
                                │
                                ▼
                           AgentRuntime
                                │
                         RuntimeSession
                                │
                          RuntimeLane
                                │
                              Run
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
        Tools                  Memory                Hooks
          │
          ▼
                     Capability Packages
            Browser / MCP / Skills / Providers / ...
```

---

# 5. 最终包结构

推荐：

```text
packages/
├── server-protocol/
│   └── src/
│       ├── index.ts
│       ├── version.ts
│       ├── common.ts
│       ├── auth.ts
│       ├── errors.ts
│       ├── capabilities.ts
│       ├── sessions.ts
│       ├── transcript.ts
│       ├── runs.ts
│       ├── approvals.ts
│       ├── leases.ts
│       ├── workflows.ts
│       ├── memory.ts
│       ├── browser.ts
│       ├── websocket.ts
│       └── server.ts
│
├── app-service/
│   └── src/
│       ├── index.ts
│       ├── service.ts
│       ├── session-service.ts
│       ├── session-projector.ts
│       ├── run-service.ts
│       ├── run-registry.ts
│       ├── approval-service.ts
│       ├── workflow-service.ts
│       ├── model-service.ts
│       └── runtime-backend.ts
│
├── server-core/
│   └── src/
│       ├── index.ts
│       ├── server.ts
│       ├── listener.ts
│       ├── connection.ts
│       ├── client-session.ts
│       ├── live-sessions.ts
│       ├── leases.ts
│       ├── snapshots.ts
│       ├── command-dispatcher.ts
│       ├── idempotency.ts
│       ├── authz.ts
│       └── errors.ts
│
├── server-http/
│   └── src/
│       ├── server.ts
│       ├── auth/
│       ├── routes/
│       ├── websocket/
│       ├── middleware/
│       ├── openapi/
│       └── config.ts
│
├── runtime-bridge/
│   └── src/
│       ├── protocol.ts
│       ├── client.ts
│       ├── server.ts
│       ├── supervisor.ts
│       ├── node.ts
│       └── electron.ts
│
├── client/
│   └── src/
│       ├── index.ts
│       ├── client.ts
│       ├── session.ts
│       ├── run.ts
│       ├── approval.ts
│       ├── transport.ts
│       ├── http.ts
│       ├── websocket.ts
│       ├── reconnect.ts
│       └── errors.ts
│
└── runtime-composition/
    └── ...

apps/
├── desktop/
├── server/
│   └── src/
│       ├── main.ts
│       ├── config.ts
│       ├── composition.ts
│       └── shutdown.ts
└── runtime-worker/
    └── src/main.ts
```

---

# 6. 最终依赖方向

核心：

```text
contracts
   ↑
agent
   ↑
agent-runtime
   ↑
runtime-composition
   ↑
app-service
   ↑
server-core
   ↑
server-http
   ↑
apps/server
```

Remote Protocol：

```text
server-protocol
      ▲
      │
 ┌────┴─────────────┐
 │                  │
server-http       client
```

Client SDK 禁止：

```text
client -> agent-runtime
client -> app-service
client -> runtime-composition
client -> server-core
```

正确：

```text
client
  ↓
server-protocol
```

---

# 7. Runtime Composition 正式成为产品 Runtime 组合层

当前已经存在：

```text
packages/runtime-composition
```

这一层应正式承担：

```text
Provider Resolver
Tool Resolver
Permission Gate
Approval Port
Memory Runtime
Hook Runtime
Run Context
Telemetry
Capabilities
```

最终结构：

```text
Host
  ↓
Runtime Composition
  ↓
AgentRuntime
```

Host 只负责：

```text
Config
Secret
Storage
Process Lifecycle
Transport-specific Approval
Transport-specific Browser UI Adapter
```

Runtime Composition 禁止依赖：

```text
Electron
Fastify
WebSocket
Renderer
HTTP Request
Desktop IPC
```

---

# 8. RuntimeEnvironmentRegistry

当前已经存在：

```text
RuntimeEnvironmentRegistry
```

用于给共享 Runtime 绑定：

```text
sessionId + laneId
```

对应的 Product Environment：

```text
provider
tools
permissions
hooks
telemetry
runContext
```

这一设计保留。

它的作用是：

```text
Shared AgentRuntime
      │
      ├── main lane environment
      ├── subagent lane environment
      └── workflow lane environment
```

Host 不需要为每个 Agent 新建一个完整 Runtime。

---

# 9. Runtime Public Facade 仍是唯一执行入口

Server 禁止：

```text
HTTP Route
   ↓
runAgentTurn()
```

必须：

```text
App Service
   ↓
AgentRuntime
   ↓
RuntimeSession
   ↓
RuntimeLane
   ↓
lane.run()
```

Crash Recovery：

```text
AgentRuntime.resumeOperation()
```

继续对话：

```text
同一 RuntimeLane 再次 lane.run()
```

而不是：

```text
resumeOperation()
```

---

# 10. RuntimeBackend

旧文档中：

```ts
interface RuntimeHost
```

容易与当前：

```text
RuntimeHostDescriptor
```

混淆。

因此 Server / App Service 层建议使用：

```ts
export interface RuntimeBackend {
  open(): Promise<AgentRuntime>;

  health(): Promise<RuntimeBackendHealth>;

  close(): Promise<void>;
}
```

实现：

```text
InProcessRuntimeBackend
WorkerRuntimeBackend
```

而当前 Runtime 内：

```text
RuntimeHostDescriptor
```

继续只表示：

```text
desktop
server
test
cli
unknown
```

等 host metadata。

---

# 11. InProcessRuntimeBackend

适用：

```text
开发
测试
本机个人部署
MVP
CI
```

结构：

```text
App Service
    ↓
InProcessRuntimeBackend
    ↓
createJojoRuntime()
```

优点：

```text
实现简单
调试简单
低延迟
无 IPC
快速实现 jojo serve MVP
```

第一阶段推荐默认完成这一模式。

---

# 12. WorkerRuntimeBackend

产品模式：

```text
App Service
    ↓
WorkerRuntimeBackend
    ↓
runtime-bridge
    ↓
Node Child Process
    ↓
Runtime Composition
    ↓
AgentRuntime
```

能力：

```text
Crash Isolation
Memory Isolation
Worker Restart
Future Worker Pool
Desktop / Server 共用执行层
```

注意：

> runtime-bridge 是 RuntimeBackend 的实现细节，不是 Server Core 的强制依赖。

---

# 13. Public Protocol 与 Runtime Contract 分层

`server-protocol` 不应复制全部 Runtime Contract。

可以复用：

```text
ExecutionScope
SessionInfo
LaneInfo
RuntimeError
RuntimeEvent
RuntimeEventEnvelope
RunResult
SessionSnapshot
LaneSnapshot
```

但 Server 需要自己定义：

```text
ServerInfo
ServerCapabilities
ServerSessionSummary
ServerSessionSnapshot
TranscriptItem
RunSnapshot
RunSummary
PendingApprovalSnapshot
LeaseSnapshot
WorkflowSnapshot
ProtocolError
WS Envelope
```

关系：

```text
Runtime Contract
      ↓
Server Projector
      ↓
Server Protocol DTO
```

禁止：

```ts
return runtimeInternalObject;
```

---

# 14. Server Protocol 必须以 Zod 为唯一 Schema Source

统一：

```text
Zod
 ↓
TypeScript Type
 ↓
JSON Schema
 ↓
OpenAPI
```

例如：

```ts
export const RunSnapshotSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  laneId: z.string(),
  status: z.enum([
    'accepted',
    'running',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ]),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  result: RunResultSchema.optional(),
  error: ProtocolErrorSchema.optional()
}).strict();

export type RunSnapshot =
  z.infer<typeof RunSnapshotSchema>;
```

Server 与 Client SDK 必须复用相同 Schema。

---

# 15. Protocol Version

```ts
export const JOJO_SERVER_PROTOCOL_VERSION = 1;
```

Client Hello：

```json
{
  "type": "hello",
  "version": 1,
  "client": {
    "id": "cli_xxx",
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

版本不支持：

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

# 16. Capability Discovery

Client 不能只依赖 Protocol Version 猜功能。

```json
{
  "capabilities": {
    "runtime": {
      "lanes": true,
      "resumeOperation": true,
      "transcriptQuery": true,
      "runQuery": true,
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

---

# 17. ExecutionScope

创建 Session：

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

禁止：

```text
General Session
     ↓
偷偷绑定 ~/.jojo/server/workspaces/<sessionId>
```

`none` 就是：

```text
无 Workspace
```

未来 Scratch：

```text
显式 sandbox / scratch scope
```

---

# 18. Workspace Authorization

Server 收到：

```text
ExecutionScope(workspace)
```

必须经过：

```text
ScopePolicy
```

例如：

```yaml
server:
  workspaceRoots:
    - ~/projects
    - /data/workspaces
```

校验必须考虑：

```text
realpath
symlink
ancestor boundary
path traversal
```

禁止默认允许：

```text
/
$HOME
```

---

# 19. Session Catalog：必须补齐 Runtime Public Query

当前远程 API 需要：

```http
GET /api/v1/sessions
```

Client SDK 需要：

```ts
client.listSessions()
```

因此 Runtime 必须提供可公开查询的 Session Catalog。

建议 SPI：

```ts
interface AgentRuntimeStore {
  listSessions(): Promise<Session[]>;
}
```

Public Runtime：

```ts
interface AgentRuntime {
  listSessions(): Promise<SessionInfo[]>;
}
```

或者：

```ts
interface AgentRuntime {
  querySessions(
    request?: QuerySessionsRequest
  ): Promise<SessionInfo[]>;
}
```

Server 不允许：

```text
app-service
  ↓
直接 import AgentRuntimeStore
```

去补这个缺口。

---

# 20. Server Session Metadata

Runtime Session 负责：

```text
id
createdAt
executionScope
runtime metadata
lanes
```

Server Metadata 负责：

```text
title
labels
favorite
defaultProvider
defaultModel
lastOpenedAt
createdBy
```

不要塞入：

```text
OperationState
```

最终：

```text
Runtime Session
+
Server Session Metadata
=
ServerSessionSummary
```

---

# 21. Transcript Query：必须补齐

当前：

```text
SessionSnapshot
=
SessionInfo + LaneInfo[]
```

`LaneSnapshot` 只含：

```text
messageCount
leafEntryId
```

不足以让 Server 重建 UI Transcript。

必须新增 Runtime Public Query。

推荐：

```ts
export type TranscriptReadOptions = {
  cursor?: string;
  limit?: number;
};

export type RuntimeTranscriptPage = {
  items: Message[];
  nextCursor?: string;
};

export interface RuntimeLane {
  readonly id: string;
  readonly sessionId: string;

  run(request: RunRequest): Promise<RunHandle>;

  cancelActiveRun(reason?: string): Promise<void>;

  getSnapshot(): Promise<LaneSnapshot>;

  readTranscript(
    options?: TranscriptReadOptions
  ): Promise<RuntimeTranscriptPage>;
}
```

这样：

```text
Runtime Durable Entries
        ↓
RuntimeLane.readTranscript()
        ↓
SessionProjector
        ↓
TranscriptItem[]
```

---

# 22. 为什么 Transcript Query 必须属于 Runtime Public API

禁止：

```text
SessionProjector
     ↓
AgentRuntimeStore.readPath()
```

原因：

```text
泄露 Kernel Storage
Server 与 Store Schema 耦合
破坏 Public Boundary
未来 Store 实现改变会破坏 Server
```

正确：

```text
SessionProjector
     ↓
Runtime Public Query
```

---

# 23. ServerSessionSnapshot

推荐：

```ts
type ServerSessionSnapshot = {
  id: string;
  title?: string;

  executionScope: ExecutionScope;

  revision: number;

  runtime: SessionSnapshot;

  activeRuns: RunSummary[];

  transcript: TranscriptItem[];

  pendingApprovals: PendingApprovalSnapshot[];

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

> **ServerSessionSnapshot 是 Client 恢复 UI 的 Source of Truth。**

---

# 24. Snapshot 与 Event

```text
Event
=
增量更新

Snapshot
=
权威状态
```

Client 断线：

```text
disconnect
   ↓
reconnect
   ↓
refresh snapshot
```

即可恢复。

不要依赖：

```text
无限 Event Replay
```

---

# 25. Run 是 Public API 概念

Internal：

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

HTTP：

```http
POST /api/v1/sessions/:sessionId/runs
```

Request：

```json
{
  "input": {
    "content": [
      {
        "type": "text",
        "text": "分析这个项目"
      }
    ]
  },
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
  "status": "accepted"
}
```

---

# 26. RunRegistry：必须新增

当前最小 `RuntimeAppService` 只保留 Active `RunHandle`。

Run 完成后：

```text
RunHandle
被移除
```

这不足以实现：

```http
GET /runs/:runId
```

也不足以支撑 SDK 重连。

必须新增：

```text
RunRegistry
```

负责：

```text
accepted
running
completed
failed
cancelled
interrupted
```

状态。

---

# 27. RunSnapshot

推荐：

```ts
type RunStatus =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

type RunSnapshot = {
  id: string;
  sessionId: string;
  laneId: string;

  status: RunStatus;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  result?: RunResult;

  error?: ProtocolError;
};
```

---

# 28. RunRegistry 生命周期

```text
startRun()
   ↓
create RunSnapshot(accepted)
   ↓
lane.run()
   ↓
running
   ↓
RunHandle.result
   ↓
completed / failed / cancelled
   ↓
persist/queryable
```

Worker Crash：

```text
running
   ↓
interrupted
```

---

# 29. Run Query

HTTP：

```http
GET /api/v1/sessions/:sessionId/runs/:runId
```

返回：

```text
RunSnapshot
```

Client SDK 的：

```ts
await run.result()
```

不能只依赖 WebSocket。

正确：

```text
WebSocket run.completed
      │
      ├── 收到 → resolve
      │
      └── 丢失 / 断线
                ↓
           reconnect
                ↓
        GET /runs/:runId
                ↓
           resolve result
```

---

# 30. Runtime Event

Streaming Source：

```text
AgentRuntime.subscribe()
      ↓
RuntimeEventEnvelope
```

当前 Runtime Event 包括：

```text
run.started
assistant.delta
tool.requested
approval.required
tool.started
tool.completed
tool.progress
context.compacted
run.suspended
run.resumed
run.completed
run.failed
run.cancelled
usage.updated
```

Server 应优先暴露这一层。

---

# 31. AgentEvent 只用于 Diagnostic

```text
AgentEvent
   ↓
TelemetrySink
   ↓
Diagnostic Channel
```

适合：

```text
low-level progress
memory diagnostics
hook diagnostics
context internals
```

Client 默认不依赖：

```text
AgentEvent Shape
```

---

# 32. Event Sequence

Runtime Event：

```text
sessionSeq
```

WebSocket：

```text
connectionSeq
```

推荐：

```json
{
  "type": "event",
  "seq": 481,
  "sessionSeq": 35,
  "sessionId": "ses_xxx",
  "event": {}
}
```

其中：

```text
seq
=
本 Connection 投递顺序

sessionSeq
=
Runtime Session 顺序
```

---

# 33. Gap Recovery

Client：

```text
seq=480
seq=482
```

发现 gap：

```text
refresh ServerSnapshot
或
refresh ServerSessionSnapshot
```

然后恢复。

不要求 Server 保存：

```text
无限 Event Replay History
```

---

# 34. REST / WebSocket 分工

REST：

```text
resource query
snapshot
create
mutation start
health
metadata
run query
session query
```

WebSocket：

```text
runtime stream
approval
workflow progress
session changes
server notification
```

---

# 35. HTTP API V1

Base：

```text
/api/v1
```

Health：

```http
GET /healthz
GET /readyz
```

Server：

```http
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

Transcript：

```http
GET /api/v1/sessions/:sessionId/transcript
```

可选 Lane：

```http
GET /api/v1/sessions/:sessionId/lanes/:laneId/transcript
```

Runs：

```http
POST /api/v1/sessions/:sessionId/runs
GET  /api/v1/sessions/:sessionId/runs/:runId
POST /api/v1/sessions/:sessionId/runs/:runId/cancel
```

Approvals：

```http
GET  /api/v1/sessions/:sessionId/approvals
POST /api/v1/approvals/:approvalId/resolve
```

---

# 36. WebSocket Commands V1

```text
server.snapshot

session.list
session.create
session.attach
session.detach
session.snapshot

run.start
run.cancel
run.get

approval.resolve
```

后续：

```text
workflow.run
workflow.cancel
memory.status
browser.replay
session.set_model
```

暂不加入：

```text
session.steer
session.follow_up
```

---

# 37. Steer / Follow-up

当前 Runtime Public Contract 未正式提供：

```text
steer()
followUp()
```

因此 Server V1 不自己实现。

正确顺序：

```text
Runtime Contract
   ↓
Desktop / Server / CLI / IM
```

未来例如：

```ts
run.steer(input);
```

或者：

```ts
lane.enqueue({
  mode: 'follow_up',
  input
});
```

必须先定义 Runtime Semantics。

---

# 38. Approval 是 Server V1 必须能力

禁止：

```text
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

# 39. Approval 生命周期

```text
Agent Runtime
      ↓
approval.required
      ↓
ServerApprovalBroker
      ↓
PendingApprovalStore
      ↓
Snapshot + WS
      ↓
Client
      ↓
approval.resolve
      ↓
Broker.resolve()
      ↓
Run continues
```

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

---

# 40. Approval 与 Disconnect

```text
Client A
   ↓
start run
   ↓
approval required
   ↓
Client A disconnect
   ↓
Run 保持等待
   ↓
Client B / Client A reconnect
   ↓
attach
   ↓
snapshot sees approval
   ↓
resolve
```

注意：

当前 durable suspension 尚未完整实现。

因此 Worker Crash 时：

```text
approval waiting run
   ↓
interrupted
```

不能假装自动恢复。

---

# 41. Authentication

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

Remote 模式：

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

---

# 42. REST Authentication

REST：

```http
Authorization: Bearer <token>
```

Local Token：

```text
~/.jojo/server/token
```

Unix：

```text
0600
```

---

# 43. WebSocket Authentication

浏览器原生：

```js
new WebSocket(url)
```

不能可靠自定义：

```http
Authorization
```

因此 WS 必须有明确认证方案。

推荐：

```json
{
  "type": "hello",
  "version": 1,
  "auth": {
    "type": "bearer",
    "token": "..."
  },
  "client": {
    "id": "client_xxx",
    "name": "jojo-web",
    "version": "0.1.0"
  }
}
```

要求：

```text
Loopback
或
WSS
```

在 auth 完成前禁止：

```text
attach
subscribe
run.start
approval.resolve
任何 mutation
```

禁止：

```text
token 放 URL query
token 写日志
token 写 audit
```

---

# 44. Principal

Transport 鉴权后转成：

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

Transport Adapter 负责解析。

---

# 45. Authorization Scope

未来：

```text
sessions:read
sessions:write
runs:start
runs:cancel
approvals:resolve
workflows:run
memory:read
memory:write
browser:use
admin
```

MVP 可以只有：

```text
Admin Token
```

但 Domain 不假设永远单用户。

---

# 46. Lease 的职责

Server Lease 管：

```text
多 Client 控制权
```

Runtime Lane Lock 管：

```text
执行并发
```

二者不是一回事。

---

# 47. Lease 类型

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
cancel run
resolve approval
set model
trigger workflow
```

MVP：

```text
一个 Session 最多一个 Control Lease
```

---

# 48. Lease Wire Contract

推荐：

```ts
type LeaseMode =
  | 'observe'
  | 'control';

type LeaseSnapshot = {
  id: string;
  sessionId: string;
  mode: LeaseMode;
  clientId: string;
  connectionId: string;
  acquiredAt: string;
};
```

MVP 先定义：

```text
Lease 与 Connection 生命周期绑定
```

---

# 49. Disconnect 时 Lease 行为

断线：

```text
Connection closed
   ↓
Lease release
```

但：

```text
Run 不 cancel
Approval 不 cancel
Session 不 delete
```

重连：

```text
connect
  ↓
authenticate
  ↓
session.attach
  ↓
重新获得 lease
```

这样第一版最简单。

---

# 50. Control Lease Takeover

第一版：

```text
已有 Control Lease
   ↓
新的 control attach
   ↓
409 session_locked
```

未来再增加：

```text
takeover
force takeover
lease expiry
```

MVP 不需要复杂 TTL。

---

# 51. LiveSessionManager

推荐：

```ts
type LiveSession = {
  id: string;

  observers: Set<string>;

  controlLease?: LeaseSnapshot;

  runtimeSession: RuntimeSession;

  activeRunIds: Set<string>;

  pendingApprovalIds: Set<string>;

  disposing?: Promise<void>;
};
```

以及：

```ts
openingSessions:
  Map<string, Promise<LiveSession>>
```

避免并发 attach：

```text
同 Session 重复 open
```

---

# 52. LiveSession 释放条件

```text
no observers
AND no control lease
AND no active runs
AND no pending approvals
```

才能释放 Runtime Session Reference。

注意：

```text
释放 LiveSession
≠
删除 Durable Session
```

---

# 53. Idempotency

所有 mutation：

```text
session create
run start
approval resolve
workflow run
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

同 Key 不同 Request：

```text
409 idempotency_conflict
```

---

# 54. Command Dispatcher

REST 和 WS 禁止各写一份逻辑：

```text
REST createSession()
WS createSession()
```

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

# 55. JojoAppService

当前 `RuntimeAppService` 是最小骨架。

最终建议升级成：

```ts
interface JojoAppService {
  listSessions(
    ctx: RequestContext
  ): Promise<ServerSessionSummary[]>;

  createSession(
    ctx: RequestContext,
    input: CreateSessionInput
  ): Promise<ServerSessionSnapshot>;

  getSession(
    ctx: RequestContext,
    sessionId: string
  ): Promise<ServerSessionSnapshot>;

  getTranscript(
    ctx: RequestContext,
    sessionId: string,
    input?: TranscriptQuery
  ): Promise<TranscriptPage>;

  startRun(
    ctx: RequestContext,
    sessionId: string,
    input: StartRunInput
  ): Promise<RunSnapshot>;

  getRun(
    ctx: RequestContext,
    sessionId: string,
    runId: string
  ): Promise<RunSnapshot>;

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

  subscribe(
    listener: AppServiceEventListener
  ): Disposable;
}
```

---

# 56. App Service 禁止依赖

```text
Fastify
Electron
Renderer
WebSocket library
HTTP Request
HTTP Response
```

App Service 的输入必须是：

```text
RequestContext
Domain Input
```

---

# 57. SessionProjector

负责：

```text
Runtime Session Snapshot
+
Runtime Transcript
+
Server Metadata
+
Pending Approval
+
Run Registry
+
Lease
+
Workflow
      ↓
ServerSessionSnapshot
```

Desktop / Web / CLI 可以共享 Projection 逻辑。

---

# 58. Server Core

Server Core 负责：

```text
Connection
Principal
Lease
Live Session
Snapshot
Run Registry Coordination
Command Dispatch
Idempotency
Backpressure Policy
Audit Context
```

不负责：

```text
Agent Execution
Tool Execution
Memory Engine
Workflow Engine
Provider API
```

---

# 59. Server Core 不依赖 Fastify

定义抽象：

```ts
interface Listener {
  listen(): Promise<void>;
  close(): Promise<void>;
}
```

或者：

```ts
interface ServerConnection {
  id: string;
  principal: Principal;
  send(message: ServerMessage): Promise<void>;
  close(reason?: string): Promise<void>;
}
```

Fastify 只在：

```text
server-http
```

存在。

---

# 60. Fastify

推荐 `server-http` 使用：

```text
Fastify
```

原因：

```text
Node/TS 生态
生命周期
schema
request id
body limit
OpenAPI
插件化 Auth
rate limit
WebSocket integration
```

但禁止：

```text
agent-runtime import fastify
runtime-composition import fastify
app-service import fastify
server-core import fastify
```

---

# 61. Error Model

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
idempotency_conflict
approval_required
approval_expired
run_not_found
run_cancelled
runtime_unavailable
runtime_interrupted
rate_limited
payload_too_large
scope_not_allowed
workspace_not_allowed
provider_error
internal_error
```

---

# 62. HTTP Mapping

```text
400 invalid_request
401 unauthorized
403 forbidden
404 not_found
409 session_busy / lane_busy / idempotency_conflict
413 payload_too_large
423 session_locked
429 rate_limited
503 runtime_unavailable
500 internal_error
```

Raw Stack：

```text
只写 Server Log
```

---

# 63. Backpressure

每个 Connection：

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
  可丢旧
```

达到硬上限：

```text
disconnect slow consumer
```

---

# 64. Payload Limits

建议：

```text
Prompt text       100 KB
Image             10 MB / image
Image count       4
Normal JSON Body  1 MiB
WS frame          bounded
```

Server Adapter 必须再次校验。

---

# 65. Rate Limit

至少区分：

```text
read
mutation
run start
auth failure
approval resolve
browser replay
```

未来：

```text
Principal
Token
IP
```

组合。

---

# 66. Audit

记录：

```text
requestId
principalId
connectionId
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
OAuth Token
Cookie
Secret
完整敏感 Tool Input
```

---

# 67. Health / Ready

```http
GET /healthz
```

只表示：

```text
process alive
```

```http
GET /readyz
```

表示：

```text
storage ready
runtime backend ready
config loaded
```

Worker Down：

```text
healthz = 200
readyz = 503
```

---

# 68. Graceful Shutdown

```text
SIGTERM
  ↓
server draining
  ↓
拒绝新 mutation
  ↓
停止接受新 connection
  ↓
broadcast shutdown
  ↓
等待安全停点
  ↓
cancel remaining runs
  ↓
persist RunRegistry
  ↓
close RuntimeBackend
  ↓
close storage
```

禁止：

```ts
process.exit()
```

直接退出。

---

# 69. Worker Crash

```text
Worker exit
   ↓
active runs
   ↓
mark interrupted
   ↓
publish ServerSessionSnapshot
```

Worker Restart：

```text
resumeOperation()
```

只允许：

```text
可安全 resume 的 Operation
```

---

# 70. Replay Safety

Tool 保持：

```text
replay = safe | never
```

`never`：

```text
不能自动重放
```

Crash 后：

```text
interrupted
```

需要人工恢复。

---

# 71. Browser

Browser 保持 Capability：

```text
Server
  ↓
Browser Capability
  ↓
BrowserDriver
  ↓
Headless Browser Host / CDP
```

不依赖：

```text
Electron WebContentsView
BrowserWindow
```

---

# 72. Browser Remote API

第一阶段建议只开放：

```http
GET  /api/v1/browser/recordings
POST /api/v1/browser/recordings/:id/replay
```

不要优先暴露：

```text
click
type
eval
hover
cookie
```

这些继续走 Agent Tool + Permission。

---

# 73. Secret

Headless Server 无 Desktop Masked Dialog。

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
    "id": "sec_xxx",
    "name": "password",
    "description": "Login password"
  }
}
```

Secret Value 禁止进入：

```text
Transcript
Memory
Hook
Workflow Journal
Browser Recording
Log
Audit
Diagnostic
```

---

# 74. Memory API

远程第一阶段只做治理：

```http
GET    /api/v1/memory/status
GET    /api/v1/memory/entries
POST   /api/v1/memory/rebuild

POST   /api/v1/memory/candidates/:id/accept
POST   /api/v1/memory/candidates/:id/reject
DELETE /api/v1/memory/entries/:id
```

Server 不重写：

```text
Memory Engine
```

---

# 75. Workflow API

```http
GET  /api/v1/workflows
POST /api/v1/workflows/:workflowId/runs

GET  /api/v1/workflow-runs/:runId
POST /api/v1/workflow-runs/:runId/cancel
POST /api/v1/workflow-runs/:runId/resume
```

Workflow 仍由：

```text
packages/orchestration
```

负责。

---

# 76. Sub-Agent API

MVP 不做独立 CRUD。

通过：

```text
Session Snapshot
Workflow Snapshot
Runtime Lane
Orchestration Event
```

暴露。

未来：

```http
GET /api/v1/sessions/:id/subagents
GET /api/v1/subagents/:id
```

---

# 77. Client SDK 目标

Client SDK 不应只是：

```text
REST wrapper
```

而应该提供：

```text
Remote Agent Object Model
```

---

# 78. Client SDK Public API

推荐：

```ts
const client = new JojoClient({
  baseUrl: 'http://127.0.0.1:7788',
  token
});

await client.connect();

const session = await client.createSession({
  executionScope: {
    kind: 'none'
  }
});

const unsubscribe = session.subscribe((event) => {
  console.log(event);
});

const run = await session.run({
  input: '分析这个项目',
  providerId: 'openai',
  model: 'gpt-5'
});

const result = await run.result();

unsubscribe();

await client.close();
```

---

# 79. JojoClient

```ts
interface JojoClient {
  connect(): Promise<void>;

  reconnect(): Promise<void>;

  close(): Promise<void>;

  getServerInfo(): Promise<ServerInfo>;

  getCapabilities(): Promise<ServerCapabilities>;

  listSessions(): Promise<ServerSessionSummary[]>;

  createSession(
    input: CreateSessionInput
  ): Promise<JojoSession>;

  getSession(
    sessionId: string
  ): Promise<JojoSession>;
}
```

---

# 80. JojoSession

```ts
interface JojoSession {
  readonly id: string;

  attach(
    mode?: 'observe' | 'control'
  ): Promise<LeaseSnapshot>;

  detach(): Promise<void>;

  snapshot(): Promise<ServerSessionSnapshot>;

  transcript(
    options?: TranscriptQuery
  ): Promise<TranscriptPage>;

  run(
    input: StartRunInput
  ): Promise<JojoRun>;

  subscribe(
    listener: SessionEventListener
  ): () => void;
}
```

---

# 81. JojoRun

```ts
interface JojoRun {
  readonly id: string;

  snapshot(): Promise<RunSnapshot>;

  cancel(reason?: string): Promise<void>;

  subscribe(
    listener: RunEventListener
  ): () => void;

  result(): Promise<RunResult>;
}
```

---

# 82. `run.result()` 恢复语义

SDK 必须隐藏：

```text
WS disconnect
event gap
snapshot refresh
run query
```

逻辑：

```text
run started
    ↓
listen WS
    ↓
completed event?
 ┌──┴──┐
 │     │
yes    no/disconnect
 │     │
 ▼     ▼
resolve reconnect
       ↓
   GET RunSnapshot
       ↓
completed?
 ┌─────┴─────┐
 │           │
yes         running
 │           │
resolve   continue observe
```

禁止：

```text
无限自动重试 mutation
```

---

# 83. Client SDK Transport

内部：

```text
JojoClient
├── HttpTransport
├── WebSocketTransport
├── ConnectionManager
├── ProtocolCodec
├── SessionHandle
├── RunHandle
└── ApprovalHandle
```

SDK 隐藏：

```text
HTTP
WebSocket
Request Correlation
Protocol Version
Idempotency Key
Reconnect
Reattach
Snapshot Refresh
Run Recovery
Lease
```

---

# 84. Reconnect Strategy

第一版推荐：

```text
自动重建 WebSocket
自动重新 hello/auth
自动 refresh server snapshot
自动 refresh 已 attach session snapshot
```

但：

```text
Control Lease
```

默认不静默抢占。

策略：

```text
重新 attach(control)
   ↓
成功 → 恢复
失败 → session_locked
```

---

# 85. Idempotency 与 SDK

所有 mutation：

```text
createSession
startRun
resolveApproval
```

SDK 自动生成：

```text
Idempotency-Key
```

网络超时后：

```text
可以安全重发相同 mutation
```

但必须：

```text
相同 key + 相同 request
```

---

# 86. Browser Client / Node Client

统一 Client SDK API。

Node：

```text
HTTP
WS
Bearer Header / Hello Auth
```

Browser：

```text
fetch
native WebSocket
Hello Auth
```

协议层保持一致。

---

# 87. Desktop 是否改成 localhost HTTP

不建议。

正确：

```text
Desktop IPC
     ↓
App Service
```

Server：

```text
HTTP / WS
     ↓
App Service
```

不要：

```text
Desktop
  ↓
localhost HTTP
  ↓
Server
```

---

# 88. Desktop 与 Server 共用

共用：

```text
Runtime Public Contract
Runtime Composition
App Service
Session Projector
Provider Registry
Tool Registry
Memory Runtime
Hook Runtime
Orchestration
```

不共用：

```text
Fastify
HTTP Auth
CORS
WebSocket Connection
Electron IPC DTO
Renderer DTO
```

---

# 89. `jojo serve`

最终：

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

默认：

```text
host = 127.0.0.1
runtime-mode = in-process
```

产品可：

```text
runtime-mode = worker
```

---

# 90. Config

推荐：

```yaml
server:
  host: 127.0.0.1
  port: 7788
  allowRemote: false

  auth:
    tokenFile: ~/.jojo/server/token

  workspaceRoots:
    - ~/projects

  runtime:
    mode: in-process

  limits:
    promptBytes: 102400
    bodyBytes: 1048576
    imageBytes: 10485760
    imageCount: 4

  websocket:
    maxPendingBytes: 4194304
    maxPendingEvents: 2048
```

---

# 91. Scheduler

同进程：

```text
Scheduler
   ↓
App Service
```

独立部署：

```text
Scheduler
   ↓
Client SDK
   ↓
Jojo Server
```

---

# 92. IM Adapter

```text
Telegram / Slack / Discord / WeChat
                ↓
          Channel Adapter
                ↓
           Client SDK
                ↓
           Jojo Server
```

如果 IM 与 Server 同进程，也可以：

```text
Channel Adapter
      ↓
App Service
```

---

# 93. Web UI

```text
Static Web UI
   ↓
REST
   ↓
WebSocket
   ↓
Jojo Server
```

优先：

```text
same-origin
```

Remote 模式再考虑 CORS。

---

# 94. Conformance Test Kit

推荐：

```text
packages/server-core/testing
```

提供：

```text
createTestServer
TestRuntimeBackend
TestAppService
ProtocolTestClient
InMemoryListener
FakeClock
FakeLeaseManager
```

---

# 95. Runtime Contract Tests

继续保留：

```text
Plain Node Runtime Contract
```

验证：

```text
openSession
lane.run
events
tool
cancel
resume
scope
```

这已经是 Headless Runtime 的关键基础。

---

# 96. Protocol Tests

```text
schema validation
version mismatch
unknown field
secret exclusion
runtime DTO mapping
run snapshot
transcript pagination
lease schema
```

---

# 97. App Service Tests

```text
session list
session create
session get
transcript
run start
run query
run cancel
approval
scope
projection
```

---

# 98. Server Core Tests

```text
attach
detach
observer lease
control lease
session lock
dispose
concurrency
revision
idempotency
run registry
```

---

# 99. WebSocket Tests

```text
hello
auth
version
correlation
connection seq
session seq
gap
reconnect
reattach
slow consumer
shutdown
```

---

# 100. HTTP Tests

```text
validation
status mapping
idempotency
body limit
auth
workspace authorization
run query
transcript pagination
```

---

# 101. Crash Tests

```text
worker crash
client disconnect
server shutdown
run interrupted
approval pending crash
resume safe operation
never-replay tool
```

---

# 102. 不推荐：Server 直接调用 Compat Runner

禁止：

```text
HTTP
 ↓
runAgentTurn()
```

原因：

```text
绕过 Runtime Public Contract
重复 Session 生命周期
绕过 Lane 并发
绕过 Runtime Event
破坏 Headless/Desktop 一致性
```

---

# 103. 不推荐：再实现 DefaultJojoSessionRuntime

旧思路：

```text
DefaultJojoSessionRuntime
      ↓
runAgentTurn
```

应该废弃。

现在已经有：

```text
AgentRuntime
RuntimeSession
RuntimeLane
```

Server 只做更高层：

```text
JojoAppService
SessionProjector
RunRegistry
```

---

# 104. 不推荐：Server 直接依赖 Runtime Store

禁止：

```text
app-service
  ↓
AgentRuntimeStore
```

来实现：

```text
Session List
Transcript
Run Query
```

缺少的查询能力应进入：

```text
Runtime Public Contract
```

---

# 105. 不推荐：Public 暴露 Operation

Public：

```text
Run
```

Internal：

```text
Operation
```

禁止暴露：

```text
OperationState
Reducer
Effect State
Program Counter
StoredOperation
Internal Checkpoint
```

---

# 106. 不推荐：Client SDK 依赖 Runtime Contract

虽然有些类型可以语义相似，但 SDK 的依赖必须是：

```text
server-protocol
```

而不是：

```text
agent-runtime
```

否则：

```text
Runtime Internal Evolution
```

会直接变成 Remote Breaking Change。

---

# 107. 不推荐：SDK 只靠 WebSocket

错误：

```text
run.result()
=
等 run.completed WS event
```

正确：

```text
WS Event
+
Run Query
+
Snapshot Recovery
```

共同完成。

---

# 108. 不推荐：无限 Event Replay

Event 不是数据库。

恢复：

```text
Snapshot
+
Transcript Query
+
Run Query
```

即可。

---

# 109. 不推荐：Remote Server 默认监听 0.0.0.0

默认：

```text
127.0.0.1
```

Remote：

```text
显式 --allow-remote
```

并要求认证。

---

# 110. 不推荐：WS Token 放 URL

禁止：

```text
ws://host/events?token=xxx
```

原因：

```text
日志
代理
历史
监控
```

泄露风险。

---

# 111. 不推荐：Lease 与 Run Lock 混在一起

错误：

```text
Control Lease
=
Lane Active Run Lock
```

正确：

```text
Lease
=
Client Authorization Ownership

Lane Lock
=
Runtime Execution Concurrency
```

---

# 112. 开发阶段重新规划

## S0 — Runtime Public Contract

状态：

```text
✅ 基本完成
```

已有：

```text
AgentRuntime
RuntimeSession
RuntimeLane
RunHandle
RuntimeEventEnvelope
ExecutionScope
```

---

## S0.5 — Runtime Composition

状态：

```text
✅ 已有初版
```

已有：

```text
createJojoRuntime
RuntimeEnvironmentBuilder
RuntimeEnvironmentRegistry
```

下一步：

```text
继续清理 Desktop 私有组合
```

---

## S0.6 — Runtime Query Surface

状态：

```text
❌ 必须新增
```

实现：

```text
listSessions
transcript query
必要时 run durable query adapter
```

其中：

```text
Session / Transcript
```

必须从 Runtime Public Boundary 暴露。

---

## S1 — Server Protocol

状态：

```text
❌
```

实现：

```text
version
hello
auth
error
server info
capabilities
session DTO
transcript DTO
run DTO
approval DTO
lease DTO
WS envelope
```

验收：

```text
Zod
JSON Schema
OpenAPI compatibility
Secret exclusion
```

---

## S2 — App Service V2

状态：

```text
🟡 当前只有最小 RuntimeAppService
```

补齐：

```text
SessionService
SessionProjector
RunService
RunRegistry
ApprovalService
ModelService
Transcript Query
```

---

## S3 — InProcessRuntimeBackend

状态：

```text
✅ 基础能力已经具备
```

把当前：

```text
createHeadlessServer
```

收口到明确 Backend / Application Composition。

---

## S4 — Server Core

状态：

```text
❌
```

实现：

```text
JojoServer
Connection
LiveSessionManager
LeaseManager
CommandDispatcher
IdempotencyStore
SnapshotPublisher
RunRegistry integration
```

---

## S5 — WebSocket

状态：

```text
❌
```

实现：

```text
hello
auth
version
correlation
events
snapshot
approval
reconnect semantics
backpressure
```

---

## S6 — REST

状态：

```text
❌
```

实现：

```text
health
ready
server
capabilities
models
sessions
transcript
runs
cancel
run query
```

---

## S7 — Approval

状态：

```text
❌
```

实现：

```text
ServerApprovalBroker
PendingApprovalStore
approval event
approval snapshot
resolve API
disconnect persistence
```

---

## S8 — Client SDK

状态：

```text
❌
```

实现：

```text
connect
reconnect
listSessions
createSession
getSession
attach
detach
snapshot
transcript
subscribe
run
cancel
run.result
approval
```

---

## S9 — WorkerRuntimeBackend / runtime-bridge

状态：

```text
❌
```

实现：

```text
NodeChildProcessTransport
RuntimeBridgeProtocol
WorkerSupervisor
WorkerRuntimeBackend
```

Desktop 后续：

```text
ElectronUtilityProcessTransport
```

---

## S10 — Workflow Remote API

状态：

```text
❌
```

实现：

```text
run
cancel
resume
snapshot
events
```

---

## S11 — Browser / Memory Remote API

状态：

```text
❌
```

实现：

```text
Browser Recording API
Replay
Memory Governance API
Secret Required
```

---

## S12 — `jojo serve` 产品化

状态：

```text
❌
```

实现：

```text
CLI
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

# 113. 推荐的实际开发顺序

不要直接：

```text
Server Protocol
 ↓
Client SDK
```

推荐：

```text
1. Runtime Session List
2. Runtime Transcript Query
3. RunRegistry / RunSnapshot
4. server-protocol
5. App Service V2
6. Server Core
7. HTTP
8. WebSocket
9. Approval
10. Client SDK
11. jojo serve
12. Worker Backend
```

原因：

```text
SDK
```

依赖的几个关键能力：

```text
listSessions
snapshot
transcript
run query
reconnect
lease
```

必须先稳定。

---

# 114. MVP 范围

第一版做：

```text
Server Info
Capabilities
Model List

Session List
Create Session
Get Session
Attach / Detach

Transcript Query

Run Start
Run Cancel
Run Query
Run Result

Assistant Streaming
Tool Lifecycle
Usage

Approval

ServerSnapshot
ServerSessionSnapshot

Client SDK
```

暂不做：

```text
Steer
Follow-up
Scheduler
完整 Web UI
IM
Browser Low-level Remote Control
Memory Full CRUD
Plugin Marketplace
Distributed Worker
Cloud Multi-tenant
Lease Takeover
Event Infinite Replay
```

---

# 115. MVP End-to-End

```text
Client
  │
  ▼
HTTP / WebSocket Auth
  │
  ▼
Protocol Hello
  │
  ▼
ServerSnapshot
  │
  │ session.create
  ▼
CommandDispatcher
  │
  ▼
App Service
  │
  ▼
RuntimeBackend
  │
  ▼
Runtime Composition
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
WebSocket
  │
  ▼
Client SDK
```

---

# 116. Reconnect End-to-End

```text
Client
  │
  │ run.start
  ▼
Run running
  │
  X connection lost
  │
  ▼
Client reconnect
  │
  ▼
hello/auth
  │
  ▼
session.attach
  │
  ▼
ServerSessionSnapshot
  │
  ├── active run?
  │
  ├── pending approval?
  │
  └── transcript revision?
  │
  ▼
GET RunSnapshot
  │
  ▼
continue / resolve result
```

---

# 117. Approval End-to-End

```text
Runtime
   │
   ▼
ServerApprovalBroker
   │
   ├── PendingApproval
   ├── Runtime Event
   └── Session Snapshot
            │
            ▼
        Client SDK
            │
            ▼
      approval.resolve
            │
            ▼
      CommandDispatcher
            │
            ▼
 ServerApprovalBroker.resolve
            │
            ▼
        Run continues
```

---

# 118. Headless Server 最终定义

最终：

```text
Headless Server
≠
没有 UI 的 Desktop Worker
```

而是：

```text
Runtime Composition
        ↓
AgentRuntime
        ↓
App Service
        ↓
Server Core
        ↓
Public Protocol
        ↓
HTTP / WebSocket
```

---

# 119. Client SDK 最终定义

```text
Client SDK
≠
Runtime 的远程代理对象
```

更准确：

```text
Client SDK
=
Jojo Server Protocol 的高级客户端
```

它暴露：

```text
JojoClient
JojoSession
JojoRun
Approval
```

但内部：

```text
不暴露 Runtime Kernel
```

---

# 120. 最终架构关系

```text
Runtime Contract
=
执行边界

Runtime Composition
=
产品能力组合边界

App Service
=
Use Case 边界

Server Core
=
Connection / Lease / Snapshot / Idempotency 边界

Server Protocol
=
远程兼容边界

HTTP / WebSocket
=
Transport

Client SDK
=
Remote Developer Experience
```

---

# 121. 最终结论

Jojo 当前已经完成最关键的一步：

> **Headless Runtime 已经真实成立。**

下一阶段不应该重新造 Runtime，而应该继续：

```text
Runtime Public Query Surface
        ↓
Server Protocol
        ↓
App Service V2
        ↓
Server Core
        ↓
HTTP / WebSocket
        ↓
Client SDK
```

原 `jojo-http-api-server-final-design-code-aligned.md` 的大方向仍然正确，但必须更新，因为当前代码已经正式新增：

```text
runtime-composition
app-service
apps/server
```

并且 Runtime 公共边界已经再次稳定化。

最终最重要的修正点有六个：

```text
1. Session Catalog
2. Transcript Query
3. RunRegistry / RunSnapshot
4. 完整 Server Protocol Schema
5. WebSocket Auth + Reconnect
6. Lease Wire Contract
```

补齐之后：

```text
Headless Server
+
Client SDK
```

都可以在现有 Jojo 架构上自然实现，不需要破坏 Runtime Contract，也不需要把 Desktop 逻辑搬到 Server。

一句话总结：

> **Jojo Server 是 Runtime Public Contract 的远程控制面；Jojo Client SDK 是这个远程控制面的稳定开发者接口。**

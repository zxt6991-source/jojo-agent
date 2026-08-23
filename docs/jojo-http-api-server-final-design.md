# Jojo Agent HTTP API / Server 最终优化设计

> 状态：建议作为 Jojo 后续 Server 能力的基线设计  
> 目标项目：`zxt6991-source/jojo-agent`  
> 核心参考：`earendil-works/pi` 的 Server / Protocol / Client / SDK 分层  
> 目标方向：Headless Agent、Web UI、CLI、Scheduler、IM、SDK、远程自托管

---

## 1. 设计目标

Jojo 当前已经具备较完整的 Agent 核心：`agent`、`agent-runtime`、`orchestration`、`memory`、`hooks`、`extensions`、`tools-node`、`storage`，Desktop 侧也已经采用 `Electron Main → UtilityProcess Worker → Agent Runtime → Event` 的执行模式。

因此 HTTP API / Server 不应该被理解为“给 Desktop 加一组 HTTP Route”，而应该被定义为：

> **把 Jojo 的 Agent 能力抽象成一个与 Electron、UI、HTTP 解耦的 Session Server Runtime，再由 Desktop IPC、HTTP/WebSocket、CLI、Scheduler、IM 等入口复用同一套应用服务。**

最终目标：

```text
                    Jojo Clients
         ┌────────────┼────────────┐
         │            │            │
      Desktop        Web         CLI/SDK/IM
         │            │            │
      IPC Adapter   HTTP/WS Adapter│
         └────────────┼────────────┘
                      │
                Jojo Server Core
                      │
               Jojo App Service
                      │
              Session Runtime Port
                      │
       ┌──────────────┼───────────────┐
       │              │               │
 Agent Runtime   Workflow Runtime  Browser Runtime
       │              │               │
       └──────────────┼───────────────┘
                      │
                   Storage
```

---

## 2. 核心结论

推荐拆成：

```text
packages/
├── protocol/          # Public Wire Protocol / DTO / Schema
├── app-service/       # Jojo 应用服务层
├── server-core/       # 与 HTTP 无关的 Session Server Core
├── server-http/       # REST + WebSocket Adapter
├── runtime-bridge/    # Desktop/Server ↔ Agent Worker 内部 IPC
└── client/            # TS SDK / Client

apps/
├── desktop/
├── server/            # jojo serve
└── runtime-worker/    # 可选统一 Worker 入口
```

核心原则：

1. Server Core 不依赖 HTTP。
2. Agent Runtime 不依赖 Server。
3. HTTP 不直接调用 Electron Main。
4. Public Protocol 不复用 `DesktopApi`。
5. Public Protocol 不复用 `WorkerCommand/WorkerMessage`。
6. Wire DTO 与内部 Agent Domain Object 分离。
7. Desktop IPC 与 HTTP/WS 复用同一个 App Service。
8. Durable Session 与 Live Runtime 分离。
9. Snapshot 是权威状态，Progress Event 只是增量提示。
10. Session Mutation 必须有明确的并发/所有权规则。
11. 认证在 Transport Adapter 完成，Server Core 只接收已认证 Principal。
12. Approval 在 Server 模式下仍然必须保留，不能因为 Headless 而自动批准。

---

## 3. Pi 最值得借鉴的 Server 思路

Pi 当前的 Server 不是“HTTP Server”，而是：

```text
PiServer
   │
   ├── PiServerListener
   ├── LiveSessionManager
   ├── ServerSnapshotPublisher
   └── PiServerService
           │
           └── PiSessionRuntime
```

关键设计：

- Server Core 不绑定具体 Transport；
- Listener 在连接进入 Server Core 前完成认证/授权；
- 一个连接可以 attach 多个 Session；
- Durable Session Metadata 与 Live Runtime 分开；
- Session 无观察者、无活跃 Operation 且 idle 后可以释放 Runtime；
- Snapshot 为权威状态；
- Progress Event 不取代 Snapshot；
- Protocol 有独立 Version；
- Client / Server 不直接暴露 Agent 内部对象；
- Client 通过 Session Lease 管理共享/独占控制；
- Server 与具体 Agent 实现之间只有 `PiServerService` / `PiSessionRuntime` Port。

Jojo 应借这个结构，但不应照搬 Pi 的命令集合，因为 Jojo 还需要：

```text
Approval
Workflow
Sub-Agent events
Memory management
Browser Automation
Browser Secret
Project binding
Server Hook transport
```

所以正确做法是：

> **借 Pi 的 Server 架构，不照搬 Pi 的功能边界。**

---

## 4. Jojo 当前已经具备的基础

### 4.1 `agent-runtime` 已经适合作为 Server Execution Core

当前结构已经包含：

```text
packages/agent-runtime/
├── harness/
├── operation/
├── context/
├── memory/
├── session/
└── usage/
```

并暴露：

```text
runAgentTurn
resumeAgentTurn
AgentRuntimeStore
SessionEntry
OperationState
```

Server 不应该再实现一套 Agent Loop，而应该封装：

```text
HTTP/WS
   ↓
JojoSessionRuntime
   ↓
runAgentTurn / resumeAgentTurn
```

### 4.2 Session 已经是持久领域对象

当前 Session Entry 已经支持：

```text
message
compaction
branch_summary
model_change
active_tools_change
hook_context
memory_snapshot
memory_handoff
memory_recall
custom
```

因此 Server 不应另存一份“HTTP Conversation History”，而应：

```text
AgentRuntimeStore
      ↓
Session Projector
      ↓
Public SessionSnapshot
```

### 4.3 Desktop 已经是 Control Plane → Worker 的雏形

当前路径大致为：

```text
Renderer
   ↓
Electron IPC
   ↓
Main
   ↓
UtilityProcess.postMessage()
   ↓
Agent Worker
   ↓
WorkerMessage(agent.event)
   ↓
Main
   ↓
Renderer
```

所以 Server 后续最重要的不是复制这套逻辑，而是把它抽成：

```text
RuntimeBridge
     ↕
Runtime Worker
```

然后：

```text
Desktop Main ──┐
               ├── RuntimeBridge
Server App ────┘
```

### 4.4 Hooks 已经为 Server 预留 transport

当前 Jojo 已经定义：

```ts
type HookTransport =
  | 'desktop'
  | 'cli'
  | 'server'
  | 'im'
  | 'unknown';
```

因此 Server 调 Agent 时应明确传：

```ts
hookMeta: {
  transport: 'server'
}
```

无需重新设计 Hook 生命周期。

---

## 5. 推荐总体架构

```text
                        ┌───────────────────┐
                        │   server-http     │
                        │                   │
                        │ Auth / REST / WS  │
                        │ CORS / RateLimit  │
                        └─────────┬─────────┘
                                  │
                        ┌─────────▼─────────┐
                        │   server-core     │
                        │                   │
                        │ Connections       │
                        │ Live Sessions     │
                        │ Lease Manager     │
                        │ Snapshots         │
                        │ Command Bus       │
                        └─────────┬─────────┘
                                  │
                        ┌─────────▼─────────┐
                        │   app-service     │
                        │                   │
                        │ Session Service   │
                        │ Model Service     │
                        │ Approval Service  │
                        │ Workflow Service  │
                        └─────────┬─────────┘
                                  │
                        ┌─────────▼─────────┐
                        │  runtime-bridge   │
                        │                   │
                        │ RuntimeHost       │
                        │ Worker Supervisor │
                        └─────────┬─────────┘
                                  │
                        ┌─────────▼─────────┐
                        │ runtime-worker    │
                        │                   │
                        │ agent-runtime     │
                        │ orchestration     │
                        │ memory / hooks    │
                        │ browser           │
                        └─────────┬─────────┘
                                  │
                               Storage
```

---

## 6. 推荐包结构

```text
packages/
├── protocol/
│   └── src/
│       ├── version.ts
│       ├── common.ts
│       ├── errors.ts
│       ├── server.ts
│       ├── sessions.ts
│       ├── operations.ts
│       ├── approvals.ts
│       ├── workflows.ts
│       ├── memory.ts
│       ├── browser.ts
│       └── events.ts
│
├── app-service/
│   └── src/
│       ├── service.ts
│       ├── session-runtime.ts
│       ├── session-projector.ts
│       ├── model-service.ts
│       ├── approval-service.ts
│       └── adapters/
│
├── server-core/
│   └── src/
│       ├── server.ts
│       ├── listener.ts
│       ├── connection.ts
│       ├── sessions.ts
│       ├── leases.ts
│       ├── snapshots.ts
│       ├── command-router.ts
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
│       ├── types.ts
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

---

## 7. Public Protocol 必须独立

### 7.1 不直接复用 `DesktopApi`

`DesktopApi` 是 Electron Renderer ↔ Main 的内部接口，它会随 UI 需求变化，不应该承担 Public API 兼容责任。

错误：

```text
HTTP Route
   ↓
DesktopApi
```

正确：

```text
Desktop IPC ──┐
              ├── App Service
HTTP/WS ──────┘
```

### 7.2 不直接复用 `WorkerCommand / WorkerMessage`

它们属于内部 Runtime IPC：

```text
Public Protocol
      │
      ▼
Protocol Adapter
      │
      ▼
App Service
      │
      ▼
Internal Runtime IPC
      │
      ▼
Agent Runtime
```

否则 Worker 重构就会变成 Public API Breaking Change。

---

## 8. Protocol V1

建议：

```ts
export const JOJO_PROTOCOL_VERSION = 1;
```

WebSocket 第一帧必须为：

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
  },
  "snapshot": {}
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

## 9. Wire DTO 与 Domain Object 分离

不要直接：

```ts
return internalAgentMessage;
```

应做显式映射：

```text
Agent Domain Message
       ↓
Protocol Adapter
       ↓
TranscriptItem DTO
```

建议：

```ts
type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem;
```

例如：

```ts
type AssistantTranscriptItem = {
  id: string;
  role: 'assistant';
  status: 'streaming' | 'complete' | 'error' | 'aborted';
  content: ProtocolContent[];
  model?: {
    providerId: string;
    model: string;
  };
  usage?: ProtocolUsage;
  timestamp: number;
};
```

Public DTO 不应包含：

```text
API key
raw provider headers
raw provider response
OAuth token
internal checkpoint
AbortController
Error stack
private tool implementation object
secret diagnostics
```

建议借鉴 Pi 做“字段审计”：内部 Domain Type 增加字段时，Protocol Adapter 编译期必须明确选择“公开 / 忽略 / 脱敏”。

---

## 10. Server Core 不知道 HTTP

定义：

```ts
export interface JojoServerListener {
  readonly address?: string;

  start(
    accept: (connection: ServerConnection) => ConnectionHandler
  ): Promise<void>;

  close(): Promise<void>;
}
```

Core：

```ts
class JojoServer {
  constructor(
    private readonly service: JojoServerService,
    private readonly listeners: JojoServerListener[]
  ) {}
}
```

以后可挂：

```text
HttpWebSocketListener
UnixSocketListener
NamedPipeListener
InMemoryTestListener
```

而 `LiveSessionManager / LeaseManager / SnapshotPublisher` 无需修改。

---

## 11. HTTP 与 WebSocket 分工

推荐：

```text
REST
  └── Resource / Snapshot / One-shot / Async command start

WebSocket
  └── Interactive Session / Streaming / Approval / Progress
```

REST 适合：

```text
GET sessions
GET session snapshot
GET models
GET workflows
GET memory status
POST create session
POST start turn
POST run workflow
health / ready
```

WebSocket 适合：

```text
assistant delta
tool progress
approval required
approval resolve
steer
follow-up
abort
workflow events
sub-agent events
browser replay progress
session snapshots
server snapshots
```

---

## 12. HTTP API V1

Base：

```text
/api/v1
```

### Server

```http
GET /healthz
GET /readyz
GET /api/v1/server
GET /api/v1/capabilities
GET /api/v1/models
```

### Sessions

```http
GET    /api/v1/sessions
POST   /api/v1/sessions
GET    /api/v1/sessions/:sessionId
PATCH  /api/v1/sessions/:sessionId
DELETE /api/v1/sessions/:sessionId
```

Create：

```json
{
  "title": "New Session",
  "workingDirectory": "/workspace/demo",
  "providerId": "openai",
  "model": "gpt-5"
}
```

Response：

```json
{
  "session": {
    "id": "ses_xxx",
    "title": "New Session",
    "workingDirectory": "/workspace/demo",
    "phase": "idle",
    "revision": 1
  }
}
```

---

## 13. Turn 必须设计成 Operation

不要：

```http
POST /chat
```

建议：

```http
POST /api/v1/sessions/:id/turns
```

Request：

```json
{
  "text": "分析这个项目",
  "providerId": "openai",
  "model": "gpt-5",
  "images": []
}
```

Response：

```http
202 Accepted
```

```json
{
  "operationId": "op_xxx",
  "sessionId": "ses_xxx",
  "state": "running"
}
```

查询：

```http
GET /api/v1/sessions/:id/operations/:operationId
```

原因：一个 Turn 可能经过：

```text
LLM
 ↓
Tool
 ↓
Approval
 ↓
Tool
 ↓
Sub-Agent
 ↓
Browser
 ↓
Compaction
 ↓
Retry
 ↓
LLM
```

不能把它设计成普通短 HTTP 请求。

---

## 14. Steer / Follow-up / Abort

```http
POST /api/v1/sessions/:id/steer
POST /api/v1/sessions/:id/follow-ups
POST /api/v1/sessions/:id/abort
```

语义：

```text
steer
  当前 Agent 完成当前工具批次后尽快收到

follow-up
  当前 Agent 完全结束后继续

abort
  取消当前 Session Operation
```

Abort 作用于 Operation，而不是直接 kill Worker。

---

## 15. WebSocket Protocol

Endpoint：

```text
/api/v1/ws
```

Envelope：

```ts
type ClientEnvelope = {
  type: 'request';
  id: string;
  request: ClientCommand;
};

type ServerResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ProtocolError;
};

type ServerEventEnvelope = {
  type: 'event';
  seq: number;
  event: ServerEvent;
};
```

V1 Commands：

```text
server.snapshot

session.list
session.create
session.attach
session.detach
session.prompt
session.steer
session.follow_up
session.abort
session.set_model

approval.resolve
```

后续加入：

```text
workflow.run
workflow.cancel
memory.status
browser.replay
session.bind_project
```

---

## 16. Durable Session 与 Live Runtime 分离

```text
Durable Session
      │ attach
      ▼
 Live Runtime
      │ detach
      ▼
 no observers
 no operations
 phase == idle
      │
      ▼
 runtime.dispose()
```

Session 仍然留在 Storage。

再次 attach：

```text
openSession()
   ↓
读取持久化 Session / Operation
   ↓
恢复 Runtime
```

这是 Server 资源控制的核心。

---

## 17. Session Runtime Port

建议：

```ts
export interface JojoSessionRuntime {
  snapshot(): Promise<SessionSnapshot>;

  getPhase(): SessionPhase;

  prompt(input: PromptInput): Promise<void>;
  steer(input: SteerInput): Promise<void>;
  followUp(input: FollowUpInput): Promise<void>;
  abort(): Promise<void>;

  setModel(input: ModelSelection): Promise<void>;

  resolveApproval(
    input: ApprovalResolution
  ): Promise<void>;

  subscribe(
    listener: (event: SessionRuntimeEvent) => void
  ): () => void;

  dispose(): Promise<void>;
}
```

---

## 18. JojoServerService

```ts
export interface JojoServerService {
  listSessions(
    ctx: RequestContext
  ): Promise<SessionMetadata[]>;

  listModels(
    ctx: RequestContext
  ): Promise<ModelMetadata[]>;

  createSession(
    ctx: RequestContext,
    options: CreateSessionOptions
  ): Promise<JojoSessionRuntime>;

  openSession(
    ctx: RequestContext,
    sessionId: string
  ): Promise<JojoSessionRuntime>;
}
```

后续 App Service 可扩：

```text
listWorkflows
runWorkflow
getMemoryStatus
listBrowserRecordings
```

Server Core 只依赖 Interface。

---

## 19. 如何适配现有 `runAgentTurn`

Jojo 当前更偏“Operation Runner”，不是 Pi 那种长期存活 `AgentSession` 对象。

因此建议新增：

```text
DefaultJojoSessionRuntime
```

封装：

```text
runAgentTurn
resumeAgentTurn
AbortController
AgentRuntimeStore
AgentEvent
Approval
phase
active operation
```

示意：

```ts
class DefaultJojoSessionRuntime
  implements JojoSessionRuntime {

  private phase: SessionPhase = 'idle';
  private abortController?: AbortController;

  async prompt(input: PromptInput) {
    if (this.phase !== 'idle') {
      throw new SessionBusyError();
    }

    this.phase = 'turn';
    this.abortController = new AbortController();

    try {
      await runAgentTurn({
        sessionId: this.sessionId,
        userText: input.text,
        runtimeStore: this.runtimeStore,
        signal: this.abortController.signal,
        hookMeta: {
          transport: 'server'
        }
      });
    } finally {
      this.phase = 'idle';
      this.emitSnapshot();
    }
  }
}
```

---

## 20. Snapshot 是权威状态

建议：

```ts
type SessionSnapshot = {
  id: string;
  title: string;
  workingDirectory?: string;
  projectBound: boolean;

  createdAt: number;
  updatedAt: number;

  phase:
    | 'idle'
    | 'turn'
    | 'workflow'
    | 'compaction'
    | 'retry';

  revision: number;

  activeOperation?: {
    id: string;
    type: 'turn' | 'workflow';
    state: string;
  };

  provider?: {
    id: string;
    model: string;
  };

  transcript: TranscriptItem[];
  pendingApprovals: ApprovalSnapshot[];
  usage?: UsageSnapshot;
};
```

原则：

```text
Event = UX Optimization
Snapshot = Source of Truth
```

断线后只要重新获取 Snapshot，就能完整恢复 UI。

---

## 21. Revision 与 Event Sequence

每个 Snapshot 带：

```json
{
  "revision": 31
}
```

客户端只接受更高 revision。

每个连接的 Event：

```json
{
  "type": "event",
  "seq": 481,
  "event": {}
}
```

如果 Client 收到：

```text
480
482
```

则直接刷新权威 Snapshot，不依赖无限 Event Replay。

---

## 22. Streaming / Tool Progress

标准化：

```ts
type SessionProgress =
  | ItemStarted
  | AssistantDelta
  | ToolStarted
  | ToolProgress
  | ToolFinished
  | ItemFinished;
```

当前 Jojo `ToolContext` 已经有：

```ts
onProgress(text)
```

Server 链路：

```text
ToolContext.onProgress
       ↓
SessionRuntimeEvent
       ↓
ServerEvent
       ↓
WebSocket
```

这样 Browser Replay、Terminal、Workflow 等长任务都可以实时展示。

---

## 23. Approval 是 Server V1 必须支持的能力

禁止：

```text
server mode
    ↓
no UI
    ↓
auto approve
```

正确：

```text
Agent Runtime
    ↓
approval.required
    ↓
Server Snapshot / Event
    ↓
Client
```

Event：

```json
{
  "type": "approval_required",
  "sessionId": "ses_x",
  "operationId": "op_x",
  "approval": {
    "id": "apr_x",
    "kind": "tool",
    "tool": "terminal",
    "summary": "Run npm install"
  }
}
```

Resolve：

```http
POST /api/v1/approvals/apr_x/resolve
```

```json
{
  "decision": "allow"
}
```

没有交互 Client 时：

```text
waiting_approval / suspended
```

而不是自动批准。

---

## 24. Approval 与连接解耦

Approval 绑定：

```text
sessionId
operationId
approvalId
```

不绑定某个 WebSocket。

因此：

```text
Client A 发起任务
       ↓
断线
       ↓
Client B attach
       ↓
看到 Pending Approval
       ↓
继续处理
```

---

## 25. Session 并发模型

建议：

> **同一 Session 的 Main Lane 同一时刻只允许一个 Mutating Operation。**

```text
Session
 └── main lane
       └── max active mutation = 1
```

如果 busy：

```json
{
  "code": "session_busy"
}
```

`steer / followUp / abort` 属于当前 Operation 控制，不算新 Operation。

---

## 26. Lease / Ownership

借鉴 Pi Client 的 Lease 模型，推荐：

```text
Observer Lease
Control Lease
```

Observer：

```text
read snapshot
receive events
```

可多人同时持有。

Control：

```text
prompt
abort
steer
set model
resolve approval
```

默认同一 Session 一个 Control Owner。

原因：未来可能同时出现：

```text
Desktop
Web UI
Scheduler
IM Bot
```

如果都能随意 mutate，同一 Session 很容易发生竞争。

MVP 可简化为：

```text
first attached writer owns control
until detach/disconnect
```

但 Protocol 从 V1 就应保留 ownership 概念。

---

## 27. LiveSessionManager

```ts
type LiveSession = {
  id: string;
  runtime: JojoSessionRuntime;

  observers: Set<Connection>;
  controlOwner?: string;

  operationCount: number;

  disposing?: Promise<void>;
};
```

同时：

```ts
openingSessions:
  Map<string, Promise<LiveSession>>
```

用于防止两个 Client 同时 attach 同一个 Session 时重复创建 Runtime。

自动释放条件：

```text
no connections
AND no active operations
AND phase == idle
```

---

## 28. REST 与 WebSocket 必须走同一个 Command Bus

禁止：

```text
REST Handler
  ↓
自己实现 createSession

WS Handler
  ↓
另一套 createSession
```

正确：

```text
REST ─────┐
          │
WS ───────┼── CommandDispatcher
          │
CLI ──────┘
               ↓
          Server Core
```

这样统一：

```text
Permission
Concurrency
Idempotency
Audit
Error Mapping
```

---

## 29. Idempotency

HTTP Client 可能：

```text
POST /turn
   ↓
网络超时
   ↓
Retry
```

没有 Idempotency 会导致同一任务执行两次。

推荐 mutation endpoint 支持：

```http
Idempotency-Key: <uuid>
```

Server 记录：

```text
principal
route
idempotency key
request hash
result
```

重点用于：

```text
session create
turn start
workflow run
browser replay
approval resolve
memory mutation
```

对于可能产生外部副作用的 Tool 尤其重要。

---

## 30. Error Model

```ts
type ProtocolError = {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonValue;
  requestId?: string;
};
```

基础错误：

```text
protocol_version_unsupported
unauthorized
forbidden
not_found
invalid_request
session_busy
session_locked
approval_required
approval_expired
operation_not_found
operation_cancelled
rate_limited
payload_too_large
workspace_not_allowed
provider_error
internal_error
```

HTTP Mapping：

```text
400 invalid_request
401 unauthorized
403 forbidden
404 not_found
409 session_busy
413 payload_too_large
423 session_locked
429 rate_limited
500 internal_error
```

内部异常只返回：

```json
{
  "code": "internal_error",
  "message": "Internal server error",
  "requestId": "req_x"
}
```

Stack 只写 Server Log。

---

## 31. HTTP Adapter 推荐 Fastify

Jojo 为 Node.js / TypeScript 项目，`server-http` 建议使用 Fastify。

原因：

```text
成熟 Node 生态
Route 生命周期清晰
Body Limit
Request ID
Plugin 架构
WebSocket
Swagger/OpenAPI
Auth / Rate Limit 插件成熟
```

但 Fastify 只能存在于：

```text
packages/server-http
```

禁止：

```text
server-core import fastify
app-service import fastify
agent-runtime import fastify
```

Jojo 已大量使用 Zod，因此不建议为了 Fastify 改掉协议 Schema；推荐继续以 Zod 为 Source of Truth，通过 Zod Type Provider / JSON Schema 转换生成 OpenAPI。

---

## 32. Authentication

### 默认只监听 Loopback

```yaml
server:
  host: 127.0.0.1
  port: 7788
```

默认禁止 `0.0.0.0`。

### Local Token

首次启动生成高熵随机 Token，保存到：

```text
~/.jojo/server/token
```

Unix 权限：

```text
0600
```

Client：

```http
Authorization: Bearer <token>
```

长期可升级为：

```text
tokenId
tokenHash
scopes
createdAt
lastUsedAt
```

未来 Scope：

```text
sessions:read
sessions:write
workflows:run
memory:read
memory:write
browser:use
approvals:resolve
admin
```

MVP 可先用一个 Local Admin Token，但 Domain 不应假设永远只有一个用户。

---

## 33. Principal

Transport 鉴权完成后交给 Core：

```ts
type Principal = {
  id: string;
  type: 'local' | 'token' | 'service';
  scopes: string[];
};
```

链路：

```text
HTTP/WS Listener
      ↓ authenticate
Principal
      ↓
Server Core
```

Server Core 不解析：

```text
Authorization header
Cookie
JWT
```

---

## 34. Remote Mode

显式开启：

```bash
jojo serve \
  --host 0.0.0.0 \
  --allow-remote
```

至少要求 Token，推荐 TLS 或可信 Reverse Proxy。

禁止静默暴露到 LAN。

CORS 默认 deny；若 Web UI 与 Server 同源部署，优先 same-origin，不应默认 `Access-Control-Allow-Origin: *`。

---

## 35. Workspace Security

远程 API 可以提交：

```json
{
  "workingDirectory": "/xxx"
}
```

这等于远程控制本机文件系统，因此必须配置 Allowed Roots：

```yaml
server:
  workspaceRoots:
    - ~/projects
    - /data/agent-workspaces
```

校验必须包含：

```text
realpath
symlink
ancestor boundary
```

并复用 Jojo 现有 workspace boundary 思路。

Jojo 已支持未绑定项目的 General Session，Server 应给 General Session 使用受控目录，例如：

```text
~/.jojo/server/workspaces/<sessionId>
```

不要把 `/` 或 `$HOME` 当默认 Agent Workspace。

---

## 36. Runtime Worker 抽象

当前 Desktop 使用 Electron `utilityProcess`，Server Node 进程不应依赖 Electron。

新增：

```ts
export interface RuntimeWorkerTransport {
  send(command: RuntimeCommand): Promise<void>;

  onMessage(
    listener: (message: RuntimeMessage) => void
  ): () => void;

  close(): Promise<void>;
}
```

实现：

```text
ElectronUtilityProcessTransport
NodeChildProcessTransport
```

Public `protocol` 与内部 `runtime-bridge` 必须分开：

```text
protocol
  = Public Stable

runtime-bridge
  = Internal Evolvable
```

---

## 37. Control Plane / Execution Plane

最终：

```text
Jojo Server
   │ Command
   ▼
Runtime Worker
   │ Event
   ▼
Jojo Server
   │
   ▼
Client
```

好处：

```text
Agent Crash 不直接杀 HTTP Listener
Worker 可单独监控/重启
CPU/内存隔离
可逐步演进 Worker Pool
Desktop / Server 共用执行层
```

第一版仍建议：

```text
1 Server
  ↓
1 Runtime Worker
  ↓
N Sessions
```

不要一开始就做一 Session 一 Worker。

---

## 38. Worker Crash Recovery

Worker 退出：

```text
active operations
      ↓
mark interrupted
      ↓
broadcast snapshot
```

然后重启 Worker。

如果 `AgentRuntimeStore` 表明 Operation 可恢复，则由用户或上层显式 Resume；不要自动重复具有副作用的 Tool。

应继续遵守 Jojo Tool 的：

```text
replay = safe | never
```

`never` 的副作用操作遇到 Worker Crash 时必须进入 `interrupted`，而不是自动再执行。

---

## 39. Backpressure

WebSocket Client 可能消费很慢，必须限制：

```text
maxPendingBytes / connection
```

策略：

```text
critical events
  不丢

snapshot
  可以 coalesce

assistant delta
  可以合并

诊断型 progress
  可以丢旧值
```

超过硬上限直接断开 slow consumer，不能无限缓存。

---

## 40. Limits / Rate Limit / Audit

建议沿用 Desktop 已有输入限制：

```text
Prompt text      100 KB
Image            10 MB / image
Image count      4
JSON Body        1 MiB（普通 API）
```

Rate Limit 至少区分：

```text
read
mutation
prompt
auth failure
```

Audit Log 建议记录：

```text
requestId
principalId
method / route
sessionId
operationId
approvalId
toolName / decision
duration
errorCode
```

禁止记录：

```text
Authorization
API Key
OAuth Refresh Token
Browser Secret
完整 Secret Tool Input
Cookie Value
```

---

## 41. Health / Ready / Graceful Shutdown

```http
GET /healthz
```

表示进程活着。

```http
GET /readyz
```

表示：

```text
storage ready
runtime bridge ready
config loaded
```

Worker unavailable 时可：

```text
healthz = 200
readyz  = 503
```

Graceful Shutdown：

```text
SIGTERM
  ↓
server = draining
  ↓
停止接受新的 mutation
  ↓
关闭 Listener 新连接
  ↓
通知 Client
  ↓
等待 active operation 到安全停点
  ↓
abort remaining
  ↓
persist state
  ↓
dispose runtime
  ↓
stop worker
  ↓
close storage
```

不要直接 `process.exit()`。

---

## 42. Capability Discovery

建议从 V1 支持：

```json
{
  "capabilities": {
    "workflow": true,
    "browser": true,
    "memory": true,
    "subagents": true,
    "images": true,
    "approvals": true
  }
}
```

这样 Web / CLI / Mobile 不需要硬编码版本判断。

---

## 43. Workflow API

```http
GET  /api/v1/workflows
POST /api/v1/workflows/:workflowId/runs

GET  /api/v1/workflow-runs/:runId
POST /api/v1/workflow-runs/:runId/cancel
POST /api/v1/workflow-runs/:runId/resume
```

Run：

```json
{
  "sessionId": "ses_x",
  "args": {
    "repo": "..."
  }
}
```

返回 `202 + runId`，过程通过 WebSocket 推送 `workflow_changed`。

Sub-Agent 初期不必单独做完整 REST CRUD，优先通过 Session / Workflow Snapshot 与 Event 暴露。

---

## 44. Memory API

第一阶段只开放管理能力：

```http
GET    /api/v1/memory/status
GET    /api/v1/memory/entries
POST   /api/v1/memory/rebuild
DELETE /api/v1/memory/entries/:id

POST /api/v1/memory/candidates/:id/accept
POST /api/v1/memory/candidates/:id/reject
```

Agent 内部 Memory Tool 仍然走 Agent Runtime，不通过 HTTP 重写一套 Memory 逻辑。

---

## 45. Browser Automation 与 Server

按照 Browser Automation 的拆包方案，Server Backend 应使用：

```text
Browser Automation Port
        ↓
Chrome CDP Backend
```

Server 不依赖 Electron `WebContentsView`。

第一阶段 Public API 只建议开放：

```http
GET  /api/v1/browser/recordings
POST /api/v1/browser/recordings/:id/replay
```

不优先把低层 `click/type/eval` 做成 Public REST，因为它们的安全边界过大；交互式 Browser Tool 先通过 Agent Session 使用。

---

## 46. Browser Secret

Server 没有 Desktop Masked Dialog。

Secret 来源建议：

```text
Environment
Secret Store
Out-of-band Client Secret Input
```

缺 Secret 时：

```json
{
  "type": "secret_required",
  "secretRequest": {
    "id": "sec_x",
    "name": "password",
    "description": "Login password"
  }
}
```

通过专门接口提供：

```http
POST /api/v1/secrets/sec_x/resolve
```

Secret 默认只保存在内存，并禁止进入：

```text
Transcript
Memory
Hook Payload
Server Log
Workflow Journal
Browser Recording YAML
```

---

## 47. Client SDK

建议与 Server 同步建立：

```text
packages/client
```

而不是让 Web / CLI / Scheduler 各自实现 fetch + WebSocket。

示意：

```ts
const client = new JojoClient({
  baseUrl: 'http://127.0.0.1:7788',
  token
});

await client.connect();

const session = await client.createSession({
  workingDirectory: '/workspace'
});

session.subscribe(snapshot => {
  render(snapshot);
});

await session.prompt('分析这个项目');
```

Client 上层 API：

```text
session.prompt
session.steer
session.followUp
session.abort
session.subscribe
```

底层隐藏：

```text
HTTP
WebSocket
Request Correlation
Reconnect
Snapshot Refresh
Lease
```

第一版可以像 Pi 一样不自动 reconnect，由 UI 层显式调用 `reconnect()`，避免复杂的隐式重试导致重复副作用。

---

## 48. Desktop 是否改成走 localhost HTTP？

**不建议。**

第一阶段正确结构：

```text
Desktop IPC
      ↓
App Service

HTTP / WS
      ↓
App Service
```

而不是：

```text
Desktop
  ↓ localhost HTTP
Server
```

否则本地 Desktop 会多出端口、认证、网络层、启动依赖和故障点。

最终：

```text
                  App Service
                 /           \
                /             \
       Desktop Adapter      Server Core
            │                   │
       Electron IPC          HTTP / WS
```

---

## 49. `jojo serve`

新增：

```text
apps/server
```

命令：

```bash
jojo serve
```

推荐参数：

```text
--host
--port
--data-dir
--workspace-root
--token-file
--allow-remote
--log-level
--browser-mode
```

配置示例：

```yaml
server:
  host: 127.0.0.1
  port: 7788
  allowRemote: false

  auth:
    mode: token

  workspaceRoots:
    - ~/projects

  limits:
    maxConnections: 32
    maxSessions: 100
    maxLiveSessions: 16

  runtime:
    workerMode: process
```

---

## 50. Scheduler / IM / Web 后续如何接

### Scheduler

同进程：

```text
Scheduler
   ↓
App Service
```

独立进程：

```text
Scheduler
   ↓
Jojo Client SDK
```

### IM

```text
Telegram / Discord / WeChat / Slack
                ↓
          Channel Adapter
                ↓
      App Service / Client SDK
```

Hook transport 使用 `im`。

### Web UI

```text
Static Web App
     ↓ REST
     ↓ WebSocket
Jojo Server
```

最好与 Server 同源托管，降低 CORS/Auth 复杂度。

---

## 51. Protocol Conformance Test Kit

借鉴 Pi，建议：

```text
packages/server-core/testing
```

提供：

```text
createTestServer
TestServerService
ProtocolTestClient
InMemoryTransport
```

未来任何 Transport：

```text
WebSocket
Unix Socket
Named Pipe
```

都跑同一套协议一致性测试。

测试层级：

```text
Protocol
  schema / version / unknown fields / sensitive exclusion

App Service
  session / turn / abort / approval / workspace

Server Core
  attach / detach / acquire / dispose / concurrency / revision

WebSocket
  hello / auth / correlation / seq / slow consumer

HTTP
  validation / status / idempotency / body limit / auth

Crash
  worker crash / client disconnect / shutdown / interrupted recovery
```

---

## 52. 不推荐的设计

### 52.1 HTTP Route 直接调用 `runAgentTurn`

会缺少：

```text
Session 生命周期
attach/detach
streaming abstraction
ownership
runtime recovery
```

### 52.2 复制 Desktop `main.ts`

会形成：

```text
Desktop 行为一套
Server 行为一套
```

很快失控。

### 52.3 Public API 直接暴露 WorkerCommand

会把内部 IPC 变成长期 Public Contract。

### 52.4 只有 REST Polling

Agent 天然是 Streaming / Event Driven，只做 REST 会导致不断 poll message / approval / workflow。

### 52.5 所有接口都 WebSocket

资源读取、OpenAPI、脚本集成又会很差。

### 52.6 Server 自动批准 Tool

必须禁止。

### 52.7 默认监听 `0.0.0.0`

必须禁止。

---

## 53. 开发阶段

### H1 — Public Protocol

新增：

```text
packages/protocol
```

实现：

```text
version
hello
error
server snapshot
session metadata
session snapshot
transcript
request/response/event envelope
```

验收：

```text
Schema runtime validation
unknown field reject
version mismatch
Domain → Protocol Adapter unit test
Secret / internal diagnostic 不进入 DTO
```

---

### H2 — App Service 抽取

新增：

```text
packages/app-service
```

把 Desktop Main 中的：

```text
session
turn
cancel
model
approval
```

业务逻辑向 Service 抽。

Desktop IPC 只负责：

```text
validate
调用 service
映射结果
```

验收：

```text
Desktop 行为不回归
App Service 不 import Electron
App Service 不 import HTTP
transport 可传 desktop/server/cli/im
```

---

### H3 — Session Runtime Adapter

实现：

```text
DefaultJojoSessionRuntime
```

封装：

```text
runAgentTurn
resumeAgentTurn
AbortController
RuntimeStore
AgentEvent
Approval
```

验收：

```text
snapshot
prompt
steer
follow-up
abort
event subscribe
dispose
same-lane busy protection
```

---

### H4 — Server Core

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

验收：

```text
不依赖 Fastify
不依赖 Electron
InMemory transport tests
multi-client attach
runtime acquire 去重
idle dispose
```

---

### H5 — WebSocket Adapter

实现：

```text
auth
hello
request correlation
server events
backpressure
disconnect
```

验收：

```text
hello timeout
protocol mismatch
request ID correlation
event seq
attach multiple sessions
slow consumer limit
```

---

### H6 — REST API

实现：

```text
health
ready
server
capabilities
models
sessions
turn
abort
operation snapshot
```

验收：

```text
OpenAPI
Zod validation
HTTP status mapping
requestId
body limit
idempotency
```

---

### H7 — Approval

实现：

```text
approval_required event
pending approval snapshot
resolve API
```

验收：

```text
Server 不自动 approve
Client 断线 approval 不丢
新 Client attach 可见 pending approval
resolve 重复调用幂等
expired approval 明确报错
```

---

### H8 — Runtime Bridge

新增：

```text
packages/runtime-bridge
```

实现：

```text
ElectronUtilityProcessTransport
NodeChildProcessTransport
WorkerSupervisor
```

验收：

```text
Desktop 正常
Server 不依赖 Electron
Worker crash 可检测
interrupted 状态正确
```

---

### H9 — Client SDK

新增：

```text
packages/client
```

实现：

```text
connect
reconnect
listSessions
createSession
acquireSession
subscribe
prompt
steer
followUp
abort
```

验收：

```text
Client root 不依赖 Node
HTTP/WS transport 可替换
request correlation
authoritative snapshot
lease cleanup
```

---

### H10 — Workflow

加入：

```text
run
cancel
resume
snapshot
events
```

---

### H11 — Memory / Browser

加入：

```text
Memory management API
Browser Recording API
Browser Replay
secret_required
```

---

### H12 — `jojo serve`

产品化：

```text
Loopback default
Token
Workspace allowlist
Graceful shutdown
Health / Ready
Config
Logs
```

---

## 54. 推荐优先级

```text
P0
H1 Protocol
H2 App Service
H3 Session Runtime
H4 Server Core
H5 WebSocket
H6 REST
H7 Approval

P1
H8 Runtime Bridge
H9 Client SDK
H10 Workflow

P2
H11 Memory / Browser
H12 Server Productization
```

注意：`runtime-bridge` 的接口边界应该在 H2-H4 期间就定下来，即使完整 Node Worker Supervisor 后补。

---

## 55. 第一版 Server 功能范围

MVP 只做：

```text
Server Info
Model List
Session List
Create Session
Attach / Detach Session
Prompt
Steer
Follow Up
Abort
Agent Stream
Tool Progress
Approval
Session Snapshot
```

暂时不要同时做：

```text
IM
Scheduler
完整 Web UI
Browser 低层控制 API
Memory 全 CRUD
Plugin marketplace
Cloud multi-tenant
Distributed Worker
```

---

## 56. MVP 端到端流程

```text
Client
  │ WebSocket
  ▼
Auth
  │
  ▼
hello
  │
  ▼
ServerSnapshot
  │
  │ session.create
  ▼
JojoServer
  │
  ▼
AppService
  │
  ▼
SessionRuntime
  │ prompt
  ▼
AgentRuntime
  │
  ├── assistant.delta
  ├── tool.progress
  └── approval.required
  │
  ▼
Server Event
  │
  ▼
Client
```

Approval：

```text
Agent Tool
  ↓
Permission Required
  ↓
Runtime Suspended
  ↓
approval_required
  ↓
Client Allow / Deny
  ↓
approval.resolve
  ↓
Runtime Resume
```

---

## 57. Disconnect / Restart 语义

Client 断线：

```text
release observer
   ↓
active operation?
   ├── YES → 默认继续执行
   └── NO  → no attachment + idle → dispose runtime
```

需要 Approval / Secret / Human Step 的 Operation 在没有 Client 时进入：

```text
WAITING_INTERACTION
```

而不是 auto-approve。

Server Restart 后：

```text
Durable Session
  仍然可见

Active Operation
  根据 RuntimeStore 投影为：
  completed / interrupted / recoverable
```

不能假装仍在 running。

---

## 58. 与 Browser Automation / Harness 的关系

Browser Automation 设计已经要求：

```text
Browser Runtime
     ↓ Port
Chrome / Electron
```

Server 延续相同模式：

```text
Agent Runtime
     ↓ Port
Desktop / Server / Worker
```

最终汇合：

```text
                  Jojo App Service
                       │
      ┌────────────────┼────────────────┐
      │                │                │
 Agent Runtime    Workflow Runtime   Browser Runtime
      │                │                │
      └────────────────┼────────────────┘
                       │
                  Server Core
                       │
                HTTP / WS / IPC
```

Server 不是 Harness：

```text
Harness
  = 如何执行一个 Agent Operation

Server
  = 谁启动 Operation
    Operation 属于哪个 Session
    谁在观察/控制
    如何 streaming / approval / reconnect / lifecycle
```

因此 connection / HTTP / authentication / lease / WebSocket 都不应进入 `agent-runtime`。

---

## 59. 最终产品形态

完成 Server Core 后：

```text
Jojo Core
   │
   ├── Desktop
   ├── CLI
   ├── Web
   ├── Server
   ├── Scheduler
   ├── IM
   └── SDK
```

这些都只是不同的 Transport / UI Adapter，而不是不同的 Agent 实现。

---

## 60. 最终推荐

Jojo HTTP API / Server **不要从 Fastify Route 开始**。

正确开发链路：

```text
H1 Public Protocol
       ↓
H2 App Service
       ↓
H3 Session Runtime
       ↓
H4 Server Core
       ↓
H5 WebSocket
       ↓
H6 REST
       ↓
H7 Approval
```

完成 H1-H7 后，Jojo 才真正拥有一个可靠的 Headless Agent Server 基础。

之后：

```text
Client SDK
Workflow
Scheduler
Web UI
IM
Browser
Remote Self-host
```

都可以自然建立在这个基础上。

最终一句话定义：

> **Jojo Server 是一个 transport-neutral、session-oriented、event-driven 的 Agent Control Plane；HTTP/WebSocket 只是网络适配层，Agent Runtime 才是执行核心。**

---

## 61. 参考实现位置

本设计主要参考 Pi：

```text
earendil-works/pi

packages/server/
  README.md
  src/server.ts
  src/sessions.ts
  src/types.ts
  src/protocol.ts
  src/listener.ts
  src/connection.ts
  src/snapshots.ts
  src/transports/unix/

packages/protocol/
  src/schemas.ts
  src/codec.ts
  src/framing.ts

packages/client/
  README.md

packages/coding-agent/
  docs/sdk.md
```

Jojo 当前相关：

```text
zxt6991-source/jojo-agent

packages/agent/
packages/agent-runtime/
packages/contracts/
packages/orchestration/
packages/storage/
packages/hooks/

apps/desktop/src/main/main.ts
```

Jojo 当前已经具备两个非常关键的基础：

```text
1. agent-runtime 已与 Electron UI 基本分层
2. HookTransport 已预留 server / cli / im
```

因此这套 Server 方案应该采用：

> **沿现有架构继续抽象，而不是推倒重构。**

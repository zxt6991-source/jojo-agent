# Jojo Server Run / Approval / Metadata 持久化闭环技术实现设计

> 状态：建议作为 Jojo Headless Server 下一阶段持久化实现基线  
> 校准日期：2026-08-28  
> 当前代码基线：`zxt6991-source/jojo-agent@0142f48b11d05572aa903c3864b3df4d656c0bde`  
> 关联实现：
>
> - `packages/agent-runtime`
> - `packages/runtime-composition`
> - `packages/app-service`
> - `packages/server-protocol`
> - `packages/server-core`
> - `packages/server-http`
> - `packages/storage`
> - `apps/server`
>
> 关联设计：
>
> - `jojo-http-api-server-final-design-code-aligned.md`
> - `jojo-http-api-server-client-sdk-final-design-code-aligned-v2.md`
> - `jojo-runtime-public-boundary-stabilization-final-design.md`
>
> 本文目标：
>
> **补齐 Jojo Server 当前仍然停留在内存态的 Run、Approval、Session Metadata 三条持久化链路，使 Server 在进程重启、网络断开、运行异常和部分写入失败后都能收敛到一个明确、可查询、不会伪造成功状态的 Durable State。**

---

# 0. 最终结论

当前 `main` 已经实现：

```text
Headless Runtime
      +
App Service
      +
Server Protocol
      +
Server Core
      +
HTTP / WebSocket
      +
Client SDK
```

但是 Server 侧以下状态仍然是进程内状态：

```text
RunRegistry.snapshots
RunRegistry.handles

ServerApprovalBroker.pending

DefaultJojoAppService.metadata
DefaultJojoAppService.revisions
```

也就是：

```text
Server running
   ↓
一切正常

Server restart
   ↓
Run Snapshot 丢失
Approval Pending 丢失
title / labels 丢失
revision 归零
```

当前实现已经能够完成：

```text
网络闭环
```

但还没有完成：

```text
持久化闭环
```

最终需要增加：

```text
                    AgentRuntime
                         │
                         │ Runtime Durable State
                         ▼
                AgentRuntimeStore
                         │
                         │
              ───────────┼───────────
                         │
                         ▼
                  JojoAppService
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
         RunStore   ApprovalStore  MetadataStore
             │           │            │
             └───────────┼────────────┘
                         ▼
                 ServerStateStore
                         │
                         ▼
                server-state.sqlite
```

核心原则：

> **Runtime Store 负责执行事实；Server State Store 负责远程控制面事实。**

两者不强行做跨数据库 ACID。

而是采用：

```text
Durable Intent
    +
Runtime Durable Fact
    +
Reconciliation
```

组成最终闭环。

---

# 1. 当前代码状态

当前：

```text
packages/app-service/src/run-registry.ts
```

使用：

```ts
private readonly snapshots =
  new Map<string, RunSnapshot>();

private readonly handles =
  new Map<string, RunHandle>();
```

Run 完成后：

```text
RunHandle
从 handles 删除
```

但是：

```text
RunSnapshot
只存在当前 Node Process 内存
```

当前：

```text
packages/app-service/src/approval-service.ts
```

使用：

```ts
private readonly pending =
  new Map<string, PendingApproval>();
```

Pending Approval 同时保存：

```text
snapshot
Promise settle closure
```

因此：

```text
WebSocket disconnect
```

没问题。

但是：

```text
Server Process restart
```

会完全丢失 Pending Approval。

当前：

```text
packages/app-service/src/jojo-app-service.ts
```

使用：

```ts
private readonly metadata =
  new Map<string, SessionMetadata>();

private readonly revisions =
  new Map<string, number>();
```

Metadata 当前只有：

```text
title
labels
```

Server 重启后：

```text
Runtime Session 仍存在
但 title / labels 消失
revision 重新变成 0
```

---

# 2. 本方案解决的问题

本文只解决三个 Server-owned Durable State：

```text
1. Run
2. Approval
3. Session Metadata
```

并补齐它们之间的：

```text
事务关系
状态机
启动恢复
崩溃恢复
幂等
Revision
API Projection
```

---

# 3. 非目标

本文不负责：

```text
Runtime Operation 内部持久化重构
Tool Effect Ledger 重构
Memory Persistence
Workflow Journal
Browser Recording Store
Distributed Worker
Cloud Multi-tenant
Lease 跨 Server 持久化
WebSocket Event 无限 Replay
```

Lease V1 继续：

```text
Connection-scoped
```

不持久化。

原因：

```text
连接已经失效
=
Lease 应失效
```

---

# 4. 持久化所有权边界

必须明确：

```text
AgentRuntimeStore
```

继续只负责：

```text
Runtime Session
Runtime Entry
Runtime Lane
Operation
Usage
ExecutionScope
```

不要加入：

```text
Server title
Server labels
Remote RunSnapshot
Approval UI State
Control Lease
HTTP Idempotency
Remote Principal
```

---

# 5. 为什么不能把 Server Metadata 塞进 Runtime metadata_json

Runtime Session 当前已经有：

```text
metadata_json
```

但 Server Metadata 不应直接复用它。

原因：

```text
Runtime metadata
=
Execution / Runtime Contract

Server metadata
=
Remote Product / UI Contract
```

例如：

```text
title
labels
favorite
defaultProvider
defaultModel
createdBy
lastOpenedAt
```

都不是 Runtime Kernel 概念。

如果直接写：

```text
sessions.metadata_json
```

会导致：

```text
agent-runtime
开始承担 Server 产品状态
```

破坏：

```text
Runtime-first
Transport-independent
```

原则。

---

# 6. 最终持久化模型

增加：

```text
ServerStateStore
```

概念：

```text
JojoAppService
     │
     ▼
ServerStateStore
     │
     ├── SessionMetadataStore
     ├── RunStore
     └── ApprovalStore
```

默认实现：

```text
SqliteServerStateStore
```

文件：

```text
<data-dir>/server-state.sqlite
```

---

# 7. 为什么 Server State 单独一个 SQLite

推荐：

```text
runtime.sqlite
server-state.sqlite
```

分开。

不要依赖：

```text
Runtime 和 Server 永远在同一 SQLite Connection
```

因为未来：

```text
InProcessRuntimeBackend
WorkerRuntimeBackend
Remote RuntimeBackend
```

都必须成立。

如果要求：

```text
Server Run Row
+
Runtime Operation Row
```

必须一个 SQLite transaction，

未来 Worker Backend 就会被破坏。

因此正确方案：

```text
两个 Durable Store
+
Saga
+
Reconciler
```

---

# 8. 最终包结构

建议增加：

```text
packages/app-service/src/
├── persistence.ts
├── run-registry.ts
├── approval-service.ts
├── session-metadata-service.ts
├── recovery-coordinator.ts
└── jojo-app-service.ts
```

Storage：

```text
packages/storage/src/
├── sqlite-server-state-store.ts
└── server-state-schema.ts
```

App Service 只依赖：

```text
ServerStateStore interface
```

不依赖：

```text
node:sqlite
packages/storage
```

Composition Root：

```text
apps/server
```

负责：

```text
new SqliteServerStateStore(...)
        ↓
createJojoAppService(runtime, {
    stateStore
})
```

---

# 9. Dependency Direction

正确：

```text
app-service
    │
    │ defines Port
    ▼
ServerStateStore interface

storage
    │
    │ implements Port
    ▼
SqliteServerStateStore
```

Composition：

```text
apps/server
    │
    ├── runtime store
    └── server state store
```

禁止：

```text
app-service
   ↓
import @desktop-agent/storage
```

---

# 10. ServerStateStore Public Port

建议：

```ts
export interface ServerStateStore {
  sessions: SessionMetadataStore;
  runs: RunStore;
  approvals: ApprovalStore;

  close(): Promise<void>;
}
```

具体：

```ts
export interface SessionMetadataStore {
  createCreating(input: CreateSessionMetadataRecord): Promise<SessionMetadataRecord>;
  ensureActive(input: EnsureSessionMetadataRecord): Promise<SessionMetadataRecord>;
  activate(sessionId: string): Promise<SessionMetadataRecord>;
  get(sessionId: string): Promise<SessionMetadataRecord | undefined>;
  list(): Promise<SessionMetadataRecord[]>;
  patch(sessionId: string, patch: SessionMetadataPatch): Promise<SessionMetadataRecord>;
  deleteCreating(sessionId: string): Promise<void>;
}

export interface RunStore {
  createAccepted(input: CreateRunRecord): Promise<PersistedRunRecord>;
  get(runId: string): Promise<PersistedRunRecord | undefined>;
  list(sessionId: string, options?: { activeOnly?: boolean }): Promise<PersistedRunRecord[]>;
  listRecoverable(): Promise<PersistedRunRecord[]>;
  markStarting(runId: string, expectedVersion?: number): Promise<PersistedRunRecord>;
  markRunning(runId: string, expectedVersion?: number): Promise<PersistedRunRecord>;
  markCompleted(runId: string, result: RunResult): Promise<PersistedRunRecord>;
  markFailed(runId: string, error: ProtocolError, result?: RunResult): Promise<PersistedRunRecord>;
  markCancelled(runId: string, result: RunResult): Promise<PersistedRunRecord>;
  markInterrupted(runId: string, error: ProtocolError): Promise<PersistedRunRecord>;
}

export interface ApprovalStore {
  createPending(input: CreateApprovalRecord): Promise<PersistedApprovalRecord>;
  get(id: string): Promise<PersistedApprovalRecord | undefined>;
  listPending(sessionId?: string): Promise<PersistedApprovalRecord[]>;
  listRecoverable(): Promise<PersistedApprovalRecord[]>;
  resolve(id: string, decision: ApprovalDecision, principalId?: string): Promise<PersistedApprovalRecord>;
  interrupt(id: string, reason: string): Promise<PersistedApprovalRecord>;
}
```

---

# 11. Session Metadata Record

内部持久化类型：

```ts
export type SessionMetadataRecord = {
  sessionId: string;

  state:
    | 'creating'
    | 'active';

  title?: string;

  labels: string[];

  favorite: boolean;

  defaultProviderId?: string;

  defaultModel?: string;

  createdBy?: string;

  revision: number;

  createdAt: string;

  updatedAt: string;
};
```

注意：

```text
executionScope
Runtime createdAt
```

仍由 Runtime 提供。

Server row 中的 `createdAt` 只表示：

```text
server metadata row createdAt
```

不是 Runtime Session authoritative createdAt。

---

# 12. Run Persistent Record

建议：

```ts
export type PersistedRunRecord = {
  id: string;

  sessionId: string;

  laneId: string;

  status:
    | 'accepted'
    | 'starting'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

  providerId: string;

  model: string;

  inputHash: string;

  requestMeta?: {
    budget?: {
      maxIterations?: number;
      contextWindowTokens?: number;
      maxOutputTokens?: number;
      allowPartialOnLimit?: boolean;
    };
  };

  result?: RunResult;

  error?: ProtocolError;

  createdAt: string;

  startedAt?: string;

  completedAt?: string;

  updatedAt: string;

  version: number;
};
```

---

# 13. 为什么 Server Run 不默认持久化完整 StartRunInput

不要默认保存：

```text
input.content
image bytes/base64
完整 instructions
```

因为：

```text
Prompt 内容已经会进入 Runtime Transcript
Image 可能非常大
可能包含 Secret
会造成重复持久化
```

Server Run Store 只保存：

```text
inputHash
providerId
model
budget
```

用于：

```text
审计
幂等
状态恢复
```

---

# 14. RunResult 是否持久化

V1 推荐：

```text
终态 RunResult 持久化
```

原因：

```text
GET /runs/:runId
```

必须在 Server Restart 后仍能返回终态。

当前 Server Protocol 的：

```text
RunSnapshot.result
```

直接使用：

```text
RunResult
```

所以最简单可靠的 V1 是：

```text
server_runs.result_json
```

保存最终 Public RunResult。

---

# 15. RunResult 重复数据问题

这会和：

```text
Runtime Transcript
```

存在部分重复。

V1 接受这个代价。

因为：

```text
RunResult 是 Remote API Durable Result
Transcript 是 Runtime Conversation Durable State
```

两者目的不同。

未来如果增加：

```ts
AgentRuntime.inspectRun(runId)
```

可以把：

```text
result_json
```

降级成缓存。

但当前阶段：

> **为了 Server Restart 后 Run Query 的可靠性，推荐直接持久化 Public RunResult。**

---

# 16. Approval Persistent Record

Approval Store 不应直接持久化完整：

```text
ApprovalRequest
```

尤其不能默认持久化：

```text
call.input
preview.patch
```

因为可能包含：

```text
密码
Token
Secret
文件敏感内容
```

推荐：

```ts
export type PersistedApprovalRecord = {
  id: string;

  sessionId: string;

  laneId: string;

  runId: string;

  status:
    | 'pending'
    | 'allowed'
    | 'denied'
    | 'expired'
    | 'interrupted';

  toolCallId: string;

  toolName: string;

  reason: string;

  requestHash: string;

  preview?: {
    kind:
      | 'create'
      | 'update'
      | 'delete';

    path: string;

    additions: number;

    deletions: number;

    truncated?: boolean;
  };

  decision?: 'allow' | 'deny';

  resolvedBy?: string;

  createdAt: string;

  resolvedAt?: string;

  interruptedReason?: string;

  version: number;
};
```

---

# 17. PendingApprovalSnapshot 与 Durable Record 分离

Runtime 当前需要完整：

```text
PendingApprovalSnapshot
```

给 Client UI 展示。

当前进程内可以继续保留：

```text
full ApprovalRequest
+
Promise settle closure
```

但是 Durable Store 只保存：

```text
sanitized summary
```

因此：

```text
In-memory PendingApproval
        ≠
PersistedApprovalRecord
```

这是故意的。

---

# 18. 为什么 Approval Restart 后不恢复成 Pending UI

当前 Runtime 并没有完整实现：

```text
Durable Approval Suspension
```

也就是说 Server Restart 后：

```text
Promise settle closure
Runtime call stack
```

都不存在。

因此绝对不能：

```text
数据库里 pending
   ↓
重启后继续显示 Pending
   ↓
用户点 Allow
   ↓
假装旧 Run 能继续
```

这是错误的。

V1 正确语义：

```text
Server Restart
     ↓
pending approval
     ↓
interrupted
```

同时对应：

```text
Run
   ↓
interrupted
```

---

# 19. Approval V1 持久化目标

Approval 持久化不是为了：

```text
跨进程恢复等待 Promise
```

而是为了：

```text
1. Pending 在同一 Server Process 内断线不丢
2. Restart 后历史不丢
3. Restart 后 Pending 正确收敛为 Interrupted
4. Audit 能知道曾经请求过 Approval
5. 不会出现“数据库 Pending 但 Runtime 已死”的假状态
```

---

# 20. SQLite Schema 总览

建议：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

Server State Schema：

```text
server_sessions
server_runs
server_approvals
```

可选同时增加：

```text
server_idempotency
```

---

# 21. server_sessions

```sql
CREATE TABLE IF NOT EXISTS server_sessions (
    session_id TEXT PRIMARY KEY,

    state TEXT NOT NULL
      CHECK(state IN ('creating', 'active')),

    title TEXT,

    labels_json TEXT NOT NULL DEFAULT '[]',

    favorite INTEGER NOT NULL DEFAULT 0
      CHECK(favorite IN (0, 1)),

    default_provider_id TEXT,

    default_model TEXT,

    created_by TEXT,

    revision INTEGER NOT NULL DEFAULT 0,

    created_at INTEGER NOT NULL,

    updated_at INTEGER NOT NULL
);
```

Index：

```sql
CREATE INDEX IF NOT EXISTS
server_sessions_updated
ON server_sessions(updated_at DESC);
```

---

# 22. server_runs

```sql
CREATE TABLE IF NOT EXISTS server_runs (
    id TEXT PRIMARY KEY,

    session_id TEXT NOT NULL
      REFERENCES server_sessions(session_id)
      ON DELETE CASCADE,

    lane_id TEXT NOT NULL,

    status TEXT NOT NULL
      CHECK(status IN (
        'accepted',
        'starting',
        'running',
        'completed',
        'failed',
        'cancelled',
        'interrupted'
      )),

    provider_id TEXT NOT NULL,

    model TEXT NOT NULL,

    input_hash TEXT NOT NULL,

    request_meta_json TEXT,

    result_json TEXT,

    error_json TEXT,

    created_at INTEGER NOT NULL,

    started_at INTEGER,

    completed_at INTEGER,

    updated_at INTEGER NOT NULL,

    version INTEGER NOT NULL DEFAULT 1
);
```

Indexes：

```sql
CREATE INDEX IF NOT EXISTS
server_runs_session_created
ON server_runs(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS
server_runs_recovery
ON server_runs(status, updated_at);

CREATE INDEX IF NOT EXISTS
server_runs_session_status
ON server_runs(session_id, status);
```

---

# 23. server_approvals

```sql
CREATE TABLE IF NOT EXISTS server_approvals (
    id TEXT PRIMARY KEY,

    session_id TEXT NOT NULL
      REFERENCES server_sessions(session_id)
      ON DELETE CASCADE,

    run_id TEXT NOT NULL
      REFERENCES server_runs(id)
      ON DELETE CASCADE,

    lane_id TEXT NOT NULL,

    status TEXT NOT NULL
      CHECK(status IN (
        'pending',
        'allowed',
        'denied',
        'expired',
        'interrupted'
      )),

    tool_call_id TEXT NOT NULL,

    tool_name TEXT NOT NULL,

    reason TEXT NOT NULL,

    request_hash TEXT NOT NULL,

    preview_json TEXT,

    decision TEXT
      CHECK(decision IS NULL OR decision IN ('allow', 'deny')),

    resolved_by TEXT,

    interrupted_reason TEXT,

    created_at INTEGER NOT NULL,

    resolved_at INTEGER,

    updated_at INTEGER NOT NULL,

    version INTEGER NOT NULL DEFAULT 1
);
```

Indexes：

```sql
CREATE INDEX IF NOT EXISTS
server_approvals_session_status
ON server_approvals(session_id, status);

CREATE INDEX IF NOT EXISTS
server_approvals_run
ON server_approvals(run_id);

CREATE INDEX IF NOT EXISTS
server_approvals_recovery
ON server_approvals(status, updated_at);
```

---

# 24. Schema Version

不要和 Runtime SQLite：

```text
PRAGMA user_version
```

共享。

`server-state.sqlite` 自己：

```text
PRAGMA user_version = 1
```

未来 migration：

```text
v1 -> v2
```

单独管理。

---

# 25. ServerStateStore 原子更新原则

虽然 Runtime Store 和 Server State Store 不能跨 Store ACID，

但是 Server State Store 自己内部必须保证：

```text
State Mutation
+
Session Revision
```

同事务提交。

例如：

```text
Run accepted
+
session revision +1
```

必须：

```sql
BEGIN IMMEDIATE;

INSERT INTO server_runs ...;

UPDATE server_sessions
SET revision = revision + 1,
    updated_at = ?
WHERE session_id = ?;

COMMIT;
```

不能两次独立写。

---

# 26. Session Revision 语义

当前：

```text
revision
```

是内存：

```text
Map<string, number>
```

新方案：

```text
server_sessions.revision
```

成为 durable。

但必须重新定义它：

> **revision 表示 Server Durable Projection Revision，而不是每个 Token Delta 的计数器。**

---

# 27. 哪些事件 bump revision

必须 bump：

```text
Metadata create
Metadata update

Run accepted
Run running
Run terminal
Run interrupted

Approval pending
Approval resolved
Approval expired
Approval interrupted
```

不要求每个：

```text
assistant.delta
tool.progress
usage.updated
```

都写 SQLite。

否则：

```text
每个 Token 一次磁盘写
```

不可接受。

---

# 28. Runtime Streaming 与 Revision

Streaming：

```text
RuntimeEventEnvelope.sequence
```

继续负责实时顺序。

Durable Snapshot：

```text
server_sessions.revision
```

负责 durable projection 版本。

因此：

```text
Runtime Event Seq
≠
Server Revision
```

---

# 29. Metadata 创建闭环

当前：

```text
runtime.openSession()
   ↓
metadata.set()
```

存在 crash window：

```text
Runtime Session 创建成功
   ↓
Server Crash
   ↓
title / labels 永久丢失
```

必须改。

---

# 30. Session 创建采用 Saga

推荐：

```text
Client
  │
  ▼
createSession
  │
  ▼
App Service 生成 sessionId
  │
  ▼
T1: ServerStateStore
    INSERT server_sessions
    state = creating
    title / labels persisted
  │
  ▼
runtime.openSession({
    id: sessionId
})
  │
  ▼
T2: ServerStateStore
    creating -> active
    revision++
  │
  ▼
return snapshot
```

---

# 31. 为什么 Session ID 必须由 App Service 提前生成

当前 Runtime 可以：

```text
openSession({ id?: string })
```

所以 App Service 应该从：

```text
让 Runtime 随机生成 id
```

改成：

```text
App Service 先生成 sessionId
```

这样：

```text
Server durable intent
Runtime durable session
```

有共同 Correlation ID。

---

# 32. Session 创建 Crash Matrix

## Case A

```text
Server row 还没写
↓
Crash
```

结果：

```text
什么都没有
```

安全。

## Case B

```text
server_sessions = creating
↓
runtime.openSession 尚未执行
↓
Crash
```

启动恢复：

```text
Runtime Session 不存在
```

则：

```text
删除 stale creating row
```

或者：

```text
标记 create_failed
```

V1 推荐直接删除。

## Case C

```text
Runtime Session 已创建
↓
Server row 仍 creating
↓
Crash
```

启动恢复：

```text
Runtime Session 存在
```

则：

```text
creating -> active
```

title / labels 不丢。

---

# 33. Legacy Runtime Session

可能存在：

```text
Runtime Session
但 server_sessions 无 row
```

例如旧版本升级。

启动：

```text
runtime.listSessions()
```

对每个不存在 Metadata Row 的 Session：

```text
INSERT OR IGNORE server_sessions(
    state='active',
    labels=[]
)
```

这样兼容当前已有数据。

---

# 34. Metadata Patch

新增：

```ts
export type PatchSessionMetadataInput = {
  title?: string | null;
  labels?: string[];
  favorite?: boolean;
  defaultProviderId?: string | null;
  defaultModel?: string | null;

  expectedRevision?: number;
};
```

Store：

```ts
patchSession(
  sessionId,
  patch,
  expectedRevision?
)
```

---

# 35. Metadata Optimistic Concurrency

如果 Client 带：

```text
expectedRevision
```

执行：

```sql
UPDATE server_sessions
SET ...,
    revision = revision + 1
WHERE session_id = ?
  AND revision = ?;
```

affected rows：

```text
0
```

则：

```text
409 revision_conflict
```

---

# 36. Run 持久化最大问题：当前 Run ID 生成太晚

当前：

```text
lane.run(request)
   ↓
Runtime 内部生成 runId
   ↓
返回 RunHandle.id
   ↓
RunRegistry.register()
```

这会出现：

```text
Runtime 已经开始
   ↓
Server Run Row 尚未持久化
   ↓
Process Crash
```

然后：

```text
Runtime Operation 存在
Server Run 不存在
```

---

# 37. P0 Runtime Contract 小改动：允许外部指定 runId

推荐扩展：

```ts
export type RunRequest = {
  runId?: string;

  input: RuntimeInput | string;

  providerId: string;

  model: string;

  ...
};
```

Runtime：

```ts
async startRun(
  sessionId,
  laneId,
  request
) {
  const runId =
    request.runId ?? this.idGenerator();

  ...
}
```

保证：

```text
RunHandle.id === request.runId
```

---

# 38. 为什么 runId 可以进入 Public Runtime Contract

这不是暴露：

```text
OperationState
```

而是暴露：

```text
Public Run Identity
```

Server、Desktop、CLI、Workflow 都可能需要：

```text
Correlation
Idempotency
Durable Recovery
```

因此合理。

---

# 39. Run Start 新流程

最终：

```text
Client
  │
  ▼
startRun
  │
  ▼
App Service 生成 runId
  │
  ▼
hash(input)
  │
  ▼
T1 Server State
  INSERT Run(accepted)
  revision++
  │
  ▼
transition accepted -> starting
  │
  ▼
lane.run({
   runId,
   ...
})
  │
  ▼
拿到 RunHandle
  │
  ▼
attach in-memory handle
  │
  ▼
T2 Server State
  starting -> running
  revision++
  │
  ▼
return RunSnapshot
```

---

# 40. RunRegistry 改造

当前：

```ts
RunRegistry
```

同时负责：

```text
Snapshot Store
Handle Store
```

以后应拆成：

```text
Durable RunStore
+
LiveRunRegistry
```

---

# 41. LiveRunRegistry

只保存：

```ts
type LiveRun = {
  runId: string;
  handle: RunHandle;
};
```

内存：

```ts
private readonly handles =
  new Map<string, RunHandle>();
```

它不再保存 authoritative snapshot。

---

# 42. Durable RunStore

Authoritative：

```text
RunSnapshot
```

来自：

```text
ServerStateStore.runs
```

即：

```text
GET /runs/:id
```

必须读：

```text
RunStore
```

而不是 Map。

---

# 43. Run 状态机

允许：

```text
accepted
   ↓
starting
   ↓
running
   ├── completed
   ├── failed
   ├── cancelled
   └── interrupted
```

特殊：

```text
accepted
   ↓
failed
```

例如：

```text
session not found
lane not found
lane busy
provider resolve failed before Runtime ownership
```

---

# 44. 禁止 Run 终态回退

Terminal：

```text
completed
failed
cancelled
interrupted
```

禁止：

```text
completed -> running
failed -> running
cancelled -> running
interrupted -> running
```

除非未来单独设计：

```text
new recovery attempt / resumed run
```

不能偷偷修改原 Run 历史。

---

# 45. Run Version CAS

每个 transition：

```sql
UPDATE server_runs
SET status = ?,
    version = version + 1,
    updated_at = ?
WHERE id = ?
  AND version = ?
  AND status IN (...expected);
```

这样防止：

```text
result callback
cancel callback
recovery coordinator
```

并发覆盖。

---

# 46. Run Start 失败

如果：

```text
lane.run()
```

抛出：

```text
runtime_lane_busy
runtime_session_not_found
provider error
```

必须：

```text
accepted/starting
    ↓
failed
```

并写：

```text
error_json
completed_at
```

不能把 Row 留在：

```text
accepted
```

---

# 47. Run Completion

`handle.result`：

```ts
void handle.result
  .then(async (result) => {
    const snapshot =
      await runStore.finishFromResult(
        handle.id,
        result
      );

    durableEvents.emit({
      type: 'run.updated',
      run: toRunSnapshot(snapshot)
    });
  })
  .finally(() => {
    liveRuns.delete(handle.id);
  });
```

注意：

```text
RunResult.status = failed
```

通常是 Promise resolve，

所以要按：

```text
result.status
```

映射。

---

# 48. Completion Persist 必须早于 Terminal Server Event

顺序：

```text
Runtime Result
   ↓
Persist terminal RunSnapshot
   ↓
Commit
   ↓
session revision++
   ↓
emit run.updated
   ↓
WS Client
```

禁止：

```text
先广播 completed
再异步落库
```

否则：

```text
Client 收到 completed
Server 立即 crash
GET /run 又显示 running
```

---

# 49. Runtime Event 与 RunStore 的职责

Runtime Event：

```text
run.started
run.completed
run.failed
run.cancelled
```

可以用于：

```text
Streaming
Observability
```

但 Durable Run Status 的权威写入：

```text
RunHandle.result
+
RunStore
```

不要单纯依赖：

```text
runtime.subscribe()
```

因为 Listener 当前不是 awaited durable sink。

---

# 50. Run Cancel

流程：

```text
Client cancel
  │
  ▼
RunStore get
  │
  ▼
LiveRunRegistry handle?
 ┌──────┴───────┐
 │              │
yes             no
 │              │
 ▼              ▼
handle.cancel   查询 Durable Status
 │              │
 ▼              ├── terminal -> idempotent success
Result callback │
最终写 cancelled└── running but no handle -> recovery required
```

不要：

```text
cancel API
直接把 DB status 改成 cancelled
```

因为 Runtime 可能还在执行。

---

# 51. Cancel Durable State

取消请求可以记录：

```text
cancel_requested_at
cancel_reason
```

可选新增字段。

但是：

```text
status = cancelled
```

必须来自：

```text
Runtime Result
```

或者明确的 Recovery Decision。

---

# 52. Run Restart Recovery

启动：

```text
RunRecoveryCoordinator
```

查询：

```text
accepted
starting
running
```

所有非终态 Run。

---

# 53. accepted Recovery

如果：

```text
Run = accepted
```

说明可能发生：

```text
DB intent 已写
但 Runtime 未取得 ownership
```

V1 保守策略：

```text
accepted
   ↓
interrupted
```

error：

```text
run_start_not_committed
```

---

# 54. starting Recovery

`starting` 表示：

```text
Runtime start 可能已经发生
但 App Service 没完成 running transition
```

仅靠 Server DB 无法判断真实状态。

因此需要 Runtime Query。

---

# 55. 推荐增加 Runtime Public Inspect API

为了精确闭环，建议增加：

```ts
export type RuntimeRunSnapshot = {
  id: string;

  sessionId: string;

  laneId: string;

  status:
    | 'running'
    | 'suspended'
    | 'completed'
    | 'failed'
    | 'cancelled';

  result?: RunResult;
};

export interface AgentRuntime {
  ...

  inspectRun(
    runId: string
  ): Promise<RuntimeRunSnapshot | undefined>;
}
```

它只暴露：

```text
Public Run State
```

不暴露：

```text
OperationState
Reducer
Effect State
Checkpoint
```

---

# 56. inspectRun 数据来源

Runtime 内部可以通过：

```text
AgentRuntimeStore.loadOperation(runId)
+
Session/Lane/Transcript
```

投影成：

```text
RuntimeRunSnapshot
```

但投影逻辑仍封装在：

```text
agent-runtime
```

Server 不允许直接调用 SPI。

---

# 57. Run Recovery Decision

启动：

```text
Persisted Run
   ↓
runtime.inspectRun(runId)
```

矩阵：

| Server 状态 | Runtime 状态 | 恢复 |
|---|---|---|
| accepted | missing | interrupted |
| starting | missing | interrupted |
| starting | running | running |
| starting | terminal | 同步 terminal |
| running | missing | interrupted |
| running | running | conservative: interrupted / optional safe resume |
| running | terminal | 同步 terminal |
| terminal | 任意 | 保持 terminal |

---

# 58. 默认不自动 Resume

虽然 Runtime 有：

```text
resumeOperation()
```

Server V1 启动默认：

```text
recoveryMode = conservative
```

也就是：

```text
发现旧 running
   ↓
不自动重放副作用
   ↓
interrupted
```

除非以后明确开启：

```text
safe-resume
```

并由 Runtime Replay Policy 保证安全。

---

# 59. 为什么 Interrupted 是正确状态

Crash 后如果无法证明：

```text
completed
failed
cancelled
```

就不能猜。

正确：

```text
interrupted
```

代表：

```text
执行结果未知 / 进程中断
```

这比：

```text
假装 failed
假装 completed
偷偷 retry
```

都更安全。

---

# 60. Approval Request 新流程

当前：

```text
requestApproval
  ↓
pending.set()
  ↓
emit approval.required
```

改为：

```text
requestApproval
  │
  ▼
sanitize approval
  │
  ▼
T1 ApprovalStore
  INSERT pending
  session revision++
  │
  ▼
pending.set(full request + settle)
  │
  ▼
emit approval.required
  │
  ▼
return Promise<boolean>
```

---

# 61. 为什么 Approval 必须先落库再 emit

禁止：

```text
emit approval.required
   ↓
Client 收到
   ↓
Server crash
   ↓
DB 没有 approval
```

必须：

```text
DB commit
   ↓
emit
```

---

# 62. Approval Full Request 内存态

保留：

```ts
type LivePendingApproval = {
  snapshot: PendingApprovalSnapshot;

  settle(decision: boolean): void;
};
```

它用于当前进程：

```text
resolve()
```

---

# 63. Approval Durable Summary

函数：

```ts
function persistableApproval(
  snapshot: PendingApprovalSnapshot
): PersistedApprovalRecord
```

只保留：

```text
requestId
session/lane/run
tool name
tool call id
reason
preview path
preview counts
request hash
```

不保存：

```text
call.input
preview.patch
```

---

# 64. Approval Hash

使用 canonical JSON：

```text
SHA-256(
  canonicalize({
    requestId,
    toolCallId,
    toolName,
    reason,
    previewMetadata
  })
)
```

如果未来同 ID 内容不同：

```text
approval_conflict
```

---

# 65. Approval Resolve 新流程

当前：

```text
pending.settle()
   ↓
delete pending
   ↓
emit
```

新流程必须：

```text
Client allow/deny
   │
   ▼
lookup live pending
   │
   ▼
T1 ApprovalStore
  pending -> allowed/denied
  resolvedBy
  resolvedAt
  revision++
   │
   ▼
commit
   │
   ▼
settle Runtime Promise
   │
   ▼
delete LivePending
   │
   ▼
emit approval.resolved
```

---

# 66. 为什么先 Persist Decision 再 settle

错误顺序：

```text
settle Runtime
   ↓
Tool 已继续执行
   ↓
Server crash
   ↓
Approval DB 仍 pending
```

这是不可接受的。

正确：

```text
Decision Durable
   ↓
Runtime Continue
```

---

# 67. Persist 成功但 settle 前 crash

此时：

```text
Approval = allowed
Run = running
Runtime Process crash
```

启动：

```text
Run Recovery
```

最终：

```text
interrupted
```

Approval 历史仍正确：

```text
allowed
```

不会回退成 pending。

---

# 68. Approval Resolve Idempotency

如果：

```text
allow
```

已提交，

再次：

```text
allow
```

可以：

```text
idempotent success
```

如果第一次：

```text
allow
```

第二次：

```text
deny
```

返回：

```text
409 approval_already_resolved
```

---

# 69. Approval Abort

Runtime signal abort：

```text
onAbort()
```

不能再简单：

```text
pending.delete()
```

必须：

```text
ApprovalStore
 pending -> interrupted
 reason = runtime_aborted
 revision++
```

然后：

```text
settle(false)
```

---

# 70. Approval Restart Recovery

Server startup：

```text
SELECT *
FROM server_approvals
WHERE status = 'pending';
```

因为 V1 没有 Durable Suspension：

```text
pending
   ↓
interrupted
```

reason：

```text
server_restart_without_durable_suspension
```

对应 Run：

```text
running/starting
   ↓
interrupted
```

---

# 71. 不允许 Restart 后 Resolve 旧 Pending

如果 Client 保存了旧：

```text
approvalId
```

重启后调用：

```text
POST /approvals/:id/resolve
```

推荐返回：

```text
409 approval_interrupted
```

---

# 72. Metadata + Run + Approval Revision 原子性

以下必须在 ServerStateStore 同一事务：

```text
Run transition
+
session revision bump
```

以及：

```text
Approval transition
+
session revision bump
```

Metadata：

```text
Metadata patch
+
revision bump
```

这样 Snapshot 不会出现：

```text
状态已经变
revision 没变
```

---

# 73. ServerSessionSnapshot 读取

当前：

```text
Runtime Snapshot
+
Metadata Map
+
RunRegistry Map
+
ApprovalBroker Map
```

改成：

```text
Runtime Snapshot
+
SessionMetadataStore
+
RunStore(active)
+
ApprovalBroker.livePending
+
Live Lease
```

Persisted Approval Store 主要负责：

```text
Recovery
History
Audit
```

当前 Pending UI 仍由：

```text
Live Approval Broker
```

提供完整 Request。

---

# 74. Snapshot Projection

```ts
async function getSession(
  ctx,
  sessionId
): Promise<ServerSessionSnapshot> {
  const runtimeSession =
    await runtime.getSession(sessionId);

  const metadata =
    await stateStore.sessions.get(sessionId);

  const runs =
    await stateStore.runs.list(
      sessionId,
      { activeOnly: true }
    );

  const approvals =
    approvalBroker.listLive(sessionId);

  ...
}
```

---

# 75. listSessions

流程：

```text
runtime.listSessions()
        +
bulk metadata read
        ↓
ServerSessionSummary[]
```

没有 metadata row：

```text
ensure legacy row
```

---

# 76. Metadata 不再存在默认内存 Map

删除：

```ts
private readonly metadata =
  new Map<string, SessionMetadata>();

private readonly revisions =
  new Map<string, number>();
```

改成：

```ts
constructor(
  runtime,
  {
    stateStore,
    ...
  }
)
```

---

# 77. RunRegistry 最终建议代码结构

```ts
export class LiveRunRegistry {
  private readonly handles =
    new Map<string, RunHandle>();

  attach(
    runId: string,
    handle: RunHandle
  ): void {
    this.handles.set(runId, handle);
  }

  getHandle(
    runId: string
  ): RunHandle | undefined {
    return this.handles.get(runId);
  }

  detach(
    runId: string
  ): void {
    this.handles.delete(runId);
  }

  clear(): void {
    this.handles.clear();
  }
}
```

Durable snapshot 不放这里。

---

# 78. RunService Skeleton

```ts
export class RunService {
  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: ServerStateStore,
    private readonly live: LiveRunRegistry,
    private readonly ids: IdGenerator
  ) {}

  async start(
    sessionId: string,
    input: StartRunInput
  ): Promise<RunSnapshot> {
    const runId = this.ids.next('run');

    await this.store.runs.createAccepted({
      id: runId,
      sessionId,
      laneId: input.laneId,
      providerId: input.providerId,
      model: input.model,
      inputHash: hashRuntimeInput(input.input),
      requestMeta: {
        budget: input.budget
      }
    });

    await this.store.runs.markStarting(runId);

    try {
      const session =
        await this.runtime.getSession(sessionId);

      if (!session) {
        throw new Error(
          `runtime_session_not_found: ${sessionId}`
        );
      }

      const lane =
        await session.getLane(input.laneId);

      const handle =
        await lane.run({
          runId,
          input: input.input,
          providerId: input.providerId,
          model: input.model,
          actor: { kind: 'main' },
          ...(input.instructions
            ? { instructions: input.instructions }
            : {}),
          ...(input.budget
            ? { budget: input.budget }
            : {})
        });

      this.live.attach(runId, handle);

      await this.store.runs.markRunning(runId);

      this.observe(handle);

      return toRunSnapshot(
        await this.store.runs.get(runId)
      );
    } catch (error) {
      await this.store.runs.markFailed(
        runId,
        toProtocolError(error)
      );

      throw error;
    }
  }
}
```

---

# 79. Event 发布原则

所有 App Service Durable Event：

```text
run.updated
approval.required
approval.resolved
metadata.updated
```

必须：

```text
Persist
   ↓
Commit
   ↓
Emit
```

Runtime streaming：

```text
assistant.delta
tool.progress
```

仍然可以即时转发。

---

# 80. Event 两类语义

明确：

```text
Durable Projection Event
```

例如：

```text
run.updated
approval.required
approval.resolved
session.metadata.updated
```

必须：

```text
commit-before-publish
```

而：

```text
Ephemeral Streaming Event
```

例如：

```text
assistant.delta
tool.progress
```

不要求先写 Server State Store。

---

# 81. ServerApprovalBroker Constructor

从：

```ts
new ServerApprovalBroker(now)
```

改成：

```ts
new ServerApprovalBroker({
  store: stateStore.approvals,
  now
})
```

更准确可以让：

```text
ApprovalService
```

负责 Store，Broker 只实现 Runtime Port。

---

# 82. AppService Options

建议：

```ts
export type JojoAppServiceOptions = {
  approvalBroker?: ServerApprovalBroker;

  stateStore: ServerStateStore;

  idGenerator?: () => string;

  now?: () => Date;

  recovery?: {
    mode:
      | 'conservative'
      | 'safe-resume';
  };
};
```

`stateStore` 产品模式必须提供。

测试可以：

```text
MemoryServerStateStore
```

---

# 83. MemoryServerStateStore

为了 unit test：

```text
packages/app-service/testing
```

或者：

```text
packages/storage/testing
```

提供：

```text
MemoryServerStateStore
```

实现和 SQLite 相同的：

```text
CAS
状态机
revision
```

不要让测试重新走旧 Map 逻辑。

---

# 84. SqliteServerStateStore

建议：

```ts
export class SqliteServerStateStore
  implements ServerStateStore {

  private readonly db: DatabaseSync;

  constructor(
    filename: string,
    clock: Clock
  ) {
    ...
  }
}
```

使用现有项目已经在使用的：

```text
node:sqlite
DatabaseSync
```

保持技术栈一致。

---

# 85. Transaction Helper

```ts
private transaction<T>(
  action: () => T
): T {
  this.db.exec('BEGIN IMMEDIATE');

  try {
    const result = action();

    this.db.exec('COMMIT');

    return result;
  } catch (error) {
    this.db.exec('ROLLBACK');

    throw error;
  }
}
```

所有：

```text
run transition + revision
approval transition + revision
metadata patch
```

通过它。

---

# 86. Run Transition SQL

示例：

```sql
UPDATE server_runs
SET
    status = ?,
    started_at = COALESCE(started_at, ?),
    updated_at = ?,
    version = version + 1
WHERE id = ?
  AND status IN ('accepted', 'starting')
  AND version = ?;
```

affectedRows：

```text
0
```

则重新读取。

如果已目标状态：

```text
idempotent success
```

否则：

```text
run_transition_conflict
```

---

# 87. Approval Transition SQL

```sql
UPDATE server_approvals
SET
    status = ?,
    decision = ?,
    resolved_by = ?,
    resolved_at = ?,
    updated_at = ?,
    version = version + 1
WHERE id = ?
  AND status = 'pending'
  AND version = ?;
```

---

# 88. Session Revision SQL

事务内：

```sql
UPDATE server_sessions
SET
    revision = revision + 1,
    updated_at = ?
WHERE session_id = ?;
```

必须检查：

```text
changes == 1
```

否则：

```text
server_session_metadata_missing
```

---

# 89. Server Startup 顺序

建议：

```text
1. Open Runtime Store
2. createJojoRuntime()
3. Open ServerStateStore
4. ServerStateStore schema migration
5. Session Metadata reconciliation
6. Approval reconciliation
7. Run reconciliation
8. createJojoAppService()
9. createJojoServerCore()
10. createJojoHttpServer()
11. readyz = ready
```

在 recovery 完成前：

```text
readyz = 503
```

---

# 90. 为什么 Recovery 必须在 Listen 前

否则可能：

```text
Client 请求 GET /run
   ↓
看到 running
   ↓
Recovery 随后把它改 interrupted
```

会产生启动瞬间假状态。

因此：

```text
Reconcile
   ↓
Ready
   ↓
Accept mutation
```

---

# 91. RecoveryCoordinator

建议：

```ts
export class ServerRecoveryCoordinator {
  async reconcile(): Promise<void> {
    await this.reconcileSessions();
    await this.reconcileApprovals();
    await this.reconcileRuns();
  }
}
```

顺序：

```text
Session
  ↓
Approval
  ↓
Run
```

---

# 92. 为什么 Approval 在 Run 前恢复

如果：

```text
Run running
+
Approval pending
```

我们已知：

```text
当前 V1 无 Durable Approval Suspension
```

所以 Approval 应先：

```text
pending -> interrupted
```

Run Recovery 随后可以使用更准确 error：

```text
approval_wait_interrupted
```

---

# 93. Recovery Error Codes

建议：

```text
run_start_not_committed
runtime_run_missing
runtime_interrupted
approval_wait_interrupted
server_restart
server_shutdown
run_state_inconsistent
revision_conflict
```

---

# 94. Graceful Shutdown

当前 close 以后不应简单：

```text
markInterrupted()
runtime.close()
```

推荐：

```text
server draining
  ↓
停止新 mutation
  ↓
等待 grace period
  ↓
cancel active Run
  ↓
等待 RunResult terminal persist
  ↓
仍未 terminal 的 Run
       ↓
mark interrupted
  ↓
pending approvals
       ↓
interrupt
  ↓
close Runtime
  ↓
close ServerStateStore
```

---

# 95. Graceful Shutdown 与 Approval

Pending：

```text
Server 正常退出
```

也无法跨进程继续等待。

因此：

```text
pending -> interrupted
reason = server_shutdown
```

然后：

```text
settle(false)
```

---

# 96. Idempotency 与 Run Persistence

当前 Server Core 已经有 mutation idempotency。

但是如果 Idempotency 只存在内存：

```text
Server Restart
   ↓
Client retry
   ↓
可能创建第二个 Run
```

所以真正 Run 持久化闭环建议同步把：

```text
run.start Idempotency
```

持久化。

---

# 97. 最小 Persistent Idempotency

可以先直接放 Run Row：

```text
principal_id
idempotency_key
request_hash
```

Unique：

```sql
CREATE UNIQUE INDEX
server_runs_idempotency
ON server_runs(principal_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

---

# 98. 更完整方案

长期建议单独：

```text
server_idempotency
```

因为不仅 Run：

```text
session create
approval resolve
metadata patch
workflow run
```

都需要。

本文不展开全部实现，

但：

> **Run Start 如果要实现跨 Server Restart 的 exactly-once-ish Remote Semantics，Persistent Idempotency 是 P0。**

---

# 99. Run Start Request Hash

Hash：

```text
principal
sessionId
laneId
providerId
model
runtime input canonical hash
budget
```

同：

```text
Idempotency-Key
```

不同 Hash：

```text
409 idempotency_conflict
```

---

# 100. Session Metadata Protocol 更新

当前 Create 已有：

```text
title
labels
```

建议增加：

```http
PATCH /api/v1/sessions/:sessionId
```

Schema：

```ts
export const PatchSessionMetadataInputSchema =
  z.object({
    title:
      z.string()
        .trim()
        .min(1)
        .max(500)
        .nullable()
        .optional(),

    labels:
      z.array(
        z.string()
          .trim()
          .min(1)
          .max(128)
      )
      .max(100)
      .optional(),

    favorite:
      z.boolean()
        .optional(),

    defaultProviderId:
      z.string()
        .min(1)
        .nullable()
        .optional(),

    defaultModel:
      z.string()
        .min(1)
        .nullable()
        .optional(),

    expectedRevision:
      z.number()
        .int()
        .nonnegative()
        .optional()
  })
  .strict();
```

---

# 101. RunSnapshot Protocol 建议补字段

建议：

```text
updatedAt
version
```

因此：

```ts
RunSnapshot = {
  ...
  updatedAt: string;
  version: number;
};
```

方便：

```text
Client stale detection
debug
recovery
```

不是绝对 P0，但推荐。

---

# 102. Approval Public History

当前 Remote API 只需要：

```text
PendingApprovalSnapshot
```

可以保持。

如果以后需要 Audit UI：

```text
ApprovalHistorySnapshot
```

单独增加。

不要让：

```text
PersistedApprovalRecord
```

直接变成 Wire DTO。

---

# 103. Security：RunResult

持久化：

```text
result_json
```

前要确认：

```text
RunResult
```

不包含：

```text
API Key
OAuth Token
raw provider header
```

Runtime Contract 已经应该保证这一点。

Server Store 不得接收：

```text
raw provider response object
```

---

# 104. Security：Approval

绝对禁止落盘：

```text
Authorization
Cookie
API Key
Password
Secret tool input
preview.patch 默认完整内容
```

持久化只保留：

```text
Tool Name
Reason
Path
Diff Counts
Decision
Principal
Timestamp
Hash
```

---

# 105. Security：Metadata

title / labels 属于：

```text
普通用户数据
```

仍要限制：

```text
长度
JSON 大小
UTF-8
```

不能作为：

```text
SQL identifier
filesystem path
```

直接使用。

---

# 106. Data Retention

Run：

```text
默认长期保留
```

可以未来配置：

```text
runHistoryDays
```

但 active / interrupted：

```text
不能被简单 TTL 删除
```

Approval：

```text
resolved/interrupted
```

可以长期作为 Audit。

Metadata：

```text
跟随 Session 生命周期
```

---

# 107. Failure Matrix：Run

| 故障点 | Durable 状态 | 恢复 |
|---|---|---|
| Run Row 写之前 crash | 无 Run | Client retry |
| accepted 后 crash | accepted | interrupted |
| starting 后 Runtime 未开始 | starting | interrupted |
| Runtime 开始后 crash | starting/running | inspect/reconcile |
| Runtime 完成但 Server terminal 未写 | running | inspectRun 同步 terminal；否则 interrupted |
| terminal commit 后 WS 未发 | terminal | Client GET Run 恢复 |
| terminal event 发后 crash | terminal | 状态一致 |

---

# 108. Failure Matrix：Approval

| 故障点 | Durable 状态 | 恢复 |
|---|---|---|
| pending DB 前 crash | 无 approval | Runtime 未正式等待 |
| pending DB 后 emit 前 crash | pending | restart -> interrupted |
| emit 后 Client disconnect | pending + Live Promise | reconnect 后继续 |
| decision commit 前 crash | pending | Client 可重试 |
| decision commit 后 settle 前 crash | allowed/denied | Run restart -> interrupted |
| settle 后 event 前 crash | decision durable | history 正确 |
| restart 有 pending | pending | interrupted |

---

# 109. Failure Matrix：Metadata

| 故障点 | Durable 状态 | 恢复 |
|---|---|---|
| creating row 前 crash | 无 | retry |
| creating 后 Runtime 前 crash | creating | cleanup |
| Runtime 后 active 前 crash | creating + Runtime exists | promote active |
| metadata patch commit 后 WS 前 crash | durable revision 新值 | snapshot 恢复 |
| legacy Runtime Session 无 metadata | none | ensure active default |

---

# 110. Test Plan：Session Metadata

必须测试：

```text
create persists title
create persists labels
restart keeps metadata
revision survives restart
patch increments revision
expectedRevision conflict
legacy runtime session creates default metadata
creating + runtime exists -> active
creating + runtime missing -> cleanup
```

---

# 111. Test Plan：Run

必须测试：

```text
accepted persisted before lane.run
runId supplied to Runtime
starting -> running
completed result persisted
failed result persisted
cancelled result persisted
RunResult query survives restart
terminal transition is immutable
CAS conflict
lane busy closes Run as failed
accepted startup -> interrupted
running startup -> interrupted or inspect recovery
terminal event only after commit
```

---

# 112. Test Plan：Approval

必须：

```text
pending persisted before required event
full request not persisted
call.input not persisted
preview.patch not persisted
allow persisted before settle
deny persisted before settle
duplicate same decision idempotent
opposite decision conflict
runtime abort -> interrupted
restart pending -> interrupted
old approval cannot resolve after restart
```

---

# 113. Integration Test：Server Restart

完整测试：

```text
Start Server A
   ↓
Create Session
   title = "test"
   ↓
Start Run
   ↓
Approval Required
   ↓
Kill Server A
   ↓
Start Server B
   ↓
GET Session
```

期望：

```text
title = "test"

Run.status =
  interrupted
  或精确 terminal

Approval durable history =
  interrupted

revision > 0
```

---

# 114. Integration Test：Terminal Run Restart

```text
Start Run
   ↓
Run completed
   ↓
persist result
   ↓
Kill server
   ↓
restart
   ↓
GET /runs/:id
```

必须：

```text
status = completed
finalText 不丢
```

---

# 115. Integration Test：Decision Ordering

构造 Fault Injection：

```text
ApprovalStore.resolve()
   ↓
commit
   ↓
模拟 crash before settle
```

重启：

```text
approval = allowed
run = interrupted
```

绝不能：

```text
approval = pending
```

---

# 116. Fault Injection Points

建议测试专门提供：

```text
after_session_intent
after_runtime_session_create

after_run_accepted
after_run_starting
after_runtime_run_start
after_run_terminal_commit

after_approval_pending_commit
after_approval_resolve_commit
before_approval_settle
```

方便验证 crash consistency。

---

# 117. Metrics

建议：

```text
jojo_server_runs_total{status}
jojo_server_runs_interrupted_total{reason}

jojo_server_approvals_total{status}
jojo_server_approval_pending

jojo_server_recovery_runs_total{decision}
jojo_server_recovery_approvals_total{decision}

jojo_server_state_write_errors_total
jojo_server_state_revision_conflicts_total
```

---

# 118. Audit

Run：

```text
runId
sessionId
laneId
principalId
providerId
model
status
timestamps
errorCode
```

Approval：

```text
approvalId
runId
toolName
decision
resolvedBy
```

Metadata：

```text
sessionId
changedFields
principalId
revision
```

不要 Audit：

```text
prompt full text
tool input
secret
preview patch
```

---

# 119. apps/server Composition

当前：

```text
createHeadlessServer()
```

需要增加 Server State Store。

示意：

```ts
export async function createHeadlessServer(
  options: HeadlessServerOptions
): Promise<HeadlessServer> {
  const stateStore =
    options.stateStore ??
    new SqliteServerStateStore(
      path.join(
        options.dataDir,
        'server-state.sqlite'
      )
    );

  const approvalBroker =
    new ServerApprovalBroker({
      store: stateStore.approvals,
      now: options.now
    });

  const runtime =
    await createJojoRuntime({
      ...options,
      approval: approvalBroker,
      host: {
        kind: 'server',
        ...(options.instanceId
          ? { instanceId: options.instanceId }
          : {})
      }
    });

  const recovery =
    new ServerRecoveryCoordinator({
      runtime,
      stateStore
    });

  await recovery.reconcile();

  const appService =
    createJojoAppService(runtime, {
      stateStore,
      approvalBroker,
      idGenerator: options.idGenerator,
      now: options.now
    });

  ...
}
```

---

# 120. data-dir

最终：

```text
~/.jojo/server/
├── server-state.sqlite
├── token
└── logs/
```

Runtime DB 如果 Server 使用 SQLite：

```text
~/.jojo/runtime/
└── runtime.sqlite
```

也可以都放：

```text
<data-dir>/
```

但逻辑 Store 仍分开。

---

# 121. Storage Export

`packages/storage` 新增：

```ts
export {
  SqliteServerStateStore
} from './sqlite-server-state-store.js';
```

Package 依赖需要增加：

```text
@desktop-agent/app-service
```

只用于：

```text
Persistence Port Types
```

App Service 不反向依赖 Storage。

---

# 122. 更干净的可选方案：server-state-contract

如果不希望：

```text
storage -> app-service
```

可以以后抽：

```text
packages/server-state-contract
```

包含：

```text
ServerStateStore
RunStore
ApprovalStore
SessionMetadataStore
Record Types
```

依赖：

```text
contracts
server-protocol
```

然后：

```text
app-service -> server-state-contract
storage -> server-state-contract
```

架构更纯。

但当前项目规模下：

```text
Port 定义在 app-service
```

已经足够。

---

# 123. 推荐当前不要额外建新 Package

为了减少重构量：

```text
packages/app-service/src/persistence.ts
```

定义 Ports，

```text
packages/storage
```

实现。

等 Server State 能力继续扩展：

```text
workflow
scheduler
browser remote state
```

再抽：

```text
server-state-contract
```

不迟。

---

# 124. Implementation Phase P0

先做：

```text
SessionMetadataStore
RunStore
ApprovalStore
SqliteServerStateStore
```

并提供：

```text
MemoryServerStateStore
```

用于同一套 Contract Test。

---

# 125. Implementation Phase P1

Metadata 切换：

```text
Map
   ↓
SessionMetadataStore
```

完成：

```text
restart persistence
revision
patch
legacy ensure
```

---

# 126. Implementation Phase P2

Run 切换：

```text
RunRegistry snapshots Map
   ↓
RunStore
```

保留：

```text
RunHandle Map
```

作为 Live Registry。

同时增加：

```text
RunRequest.runId
```

---

# 127. Implementation Phase P3

Approval 切换：

```text
Pending durable summary
+
Live Promise Map
```

实现：

```text
persist-before-emit
persist-decision-before-settle
restart pending interruption
```

---

# 128. Implementation Phase P4

Recovery：

```text
ServerRecoveryCoordinator
```

并使：

```text
readyz
```

等待 recovery 完成。

---

# 129. Implementation Phase P5

Runtime Inspect：

推荐增加：

```text
AgentRuntime.inspectRun()
```

实现：

```text
running / terminal
```

精确 Recovery。

在此之前：

```text
未知状态统一 interrupted
```

不要偷用 Runtime SPI。

---

# 130. Implementation Phase P6

Persistent Idempotency：

至少完成：

```text
run.start
session.create
approval.resolve
```

跨 Server Restart 幂等。

---

# 131. 文件级修改清单

## `packages/agent-runtime`

修改：

```text
src/public/run.ts
```

增加：

```text
RunRequest.runId?
```

推荐后续：

```text
AgentRuntime.inspectRun()
RuntimeRunSnapshot
```

---

## `packages/app-service`

新增：

```text
src/persistence.ts
src/session-metadata-service.ts
src/recovery-coordinator.ts
```

重构：

```text
src/run-registry.ts
src/approval-service.ts
src/jojo-app-service.ts
```

---

## `packages/storage`

新增：

```text
src/server-state-schema.ts
src/sqlite-server-state-store.ts
```

测试：

```text
test/sqlite-server-state-store.test.ts
```

---

## `packages/server-protocol`

增加：

```text
PatchSessionMetadataInput
revision_conflict
RunSnapshot.updatedAt
RunSnapshot.version
```

可选：

```text
ApprovalHistorySnapshot
```

---

## `packages/server-core`

让：

```text
PATCH session metadata
```

进入：

```text
CommandDispatcher
```

后续把：

```text
IdempotencyStore
```

切 Persistent。

---

## `packages/server-http`

增加：

```http
PATCH /api/v1/sessions/:sessionId
```

并保持：

```text
Zod validation
```

---

## `apps/server`

负责：

```text
SqliteServerStateStore
RecoveryCoordinator
Lifecycle
```

---

# 132. Acceptance Criteria

Run 闭环完成必须满足：

```text
Server restart 后 Run History 不丢
Terminal Result 不丢
Non-terminal Run 不会永久显示 running
不能静默自动重放未知副作用
Run transition 有 CAS
Run ID 在 Runtime / Server 一致
```

Approval 闭环完成：

```text
Approval required 先落库后发事件
Decision 先落库后继续 Runtime
Server restart 后 pending 不伪恢复
Approval History 不丢
Secret Tool Input 不落 Server State DB
```

Metadata 闭环完成：

```text
title / labels 重启不丢
revision 重启不归零
Session create crash 可收敛
Legacy Session 自动补 Metadata
Patch 支持 revision conflict
```

---

# 133. 最终状态模型

```text
                       Runtime Durable Domain
                      ┌──────────────────────┐
                      │ Session              │
                      │ Lane                 │
                      │ Operation            │
                      │ Transcript           │
                      │ Usage                │
                      └──────────┬───────────┘
                                 │
                                 ▼
                           AgentRuntime
                                 │
                                 ▼
                           JojoAppService
                                 │
            ┌────────────────────┼─────────────────────┐
            │                    │                     │
            ▼                    ▼                     ▼
        Session Meta            Run                 Approval
            │                    │                     │
            └────────────────────┼─────────────────────┘
                                 ▼
                        ServerStateStore
                                 │
                                 ▼
                      server-state.sqlite
```

---

# 134. 最终闭环

最终 Run：

```text
Remote Intent
   ↓ durable
Server Run accepted
   ↓
Runtime Run
   ↓ durable
Runtime Operation
   ↓
RunResult
   ↓ durable
Server terminal Run
   ↓
Client Query
```

最终 Approval：

```text
Runtime asks
   ↓
Approval pending durable
   ↓
Client sees
   ↓
Decision durable
   ↓
Runtime continues
```

如果 Crash：

```text
unknown
   ↓
interrupted
```

不伪造。

最终 Metadata：

```text
Session create intent durable
   ↓
Runtime Session durable
   ↓
Metadata active durable
   ↓
Patch + revision durable
   ↓
Snapshot
```

---

# 135. 最终结论

当前 Jojo Headless Server 的网络控制面已经基本打通。

下一步最重要的不是继续增加更多 Remote API，

而是先让：

```text
Run
Approval
Metadata
```

从：

```text
Process Memory State
```

升级为：

```text
Durable Application State
```

推荐最终方案：

```text
Runtime Store
负责执行事实

Server State Store
负责远程控制事实

两者之间
不做强行跨库事务

而使用：
Durable Intent
+
Stable Identity
+
CAS State Machine
+
Startup Reconciliation
```

其中最关键的三个实现约束：

```text
1. Run ID 必须在 Runtime 执行前确定并持久化。
2. Approval Decision 必须先持久化，再让 Runtime 继续。
3. Session Revision 必须和 Server-owned State Mutation 同事务递增。
```

对于无法在 Crash 后证明真实终态的状态：

```text
统一收敛为 interrupted
```

而不是：

```text
猜测成功
猜测失败
自动重放
```

一句话总结：

> **Jojo Server 持久化闭环的核心不是“把 Map 换成 SQLite”，而是让 Server Durable Intent、Runtime Durable Fact 和 Recovery Decision 三者形成可验证的状态机。**

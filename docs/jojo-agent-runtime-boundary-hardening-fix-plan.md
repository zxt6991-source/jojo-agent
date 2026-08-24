# Jojo Agent 并发、IPC 安全与 Electron E2E 加固修复方案

> 审计对象：`zxt6991-source/jojo-agent` `main` 分支  
> 审计基线：本次检查到的仓库树 SHA `8d45e560aa02520a2d697ba4b9a999a647ab026f`  
> 目标：核实并修复三个风险：运行中会话删除竞态、IPC 运行时校验缺口、离线 Electron E2E 缺失。

---

## 1. 结论

| 问题 | 当前结论 | 已有防护 | 剩余风险 | 优先级 |
|---|---|---|---|---|
| 删除运行中会话的 JSONL 竞态 | **存在，但已经部分缓解** | Main 删除前发 `session.stop`；Worker abort turn、等待 `turnTasks`，并 quiesce Sub-Agent / Workflow | `stop -> unlink` 之间仍有 TOCTOU；`JsonlSessionStore.delete()` 与 `append()` 没有统一生命周期互斥；`appendFile(..., flag:'a')` 可在删除后重新创建文件 | **P0：Server / Scheduler 前必须修** |
| Main / Preload / Worker IPC 运行时校验 | **存在，但不是全部 IPC 都没校验** | Renderer→Main 很多 invoke 已 Zod parse；Main 有 `assertTrusted()` | WorkerCommand / WorkerMessage 只是 TS union；Worker 入站、Main 收 Worker 消息、Preload push event 没有形成完整 runtime parse 链 | **P0：开放更多高权限 Tool 前必须修** |
| 离线 Electron E2E 冒烟 | **明确存在** | 单元/集成测试较多，也有 Worker-level `write-agent.e2e.test.ts` | 没有真正启动 Electron 验证 Main↔Preload↔Renderer↔Worker；CI 只 lint/typecheck/vitest/package | **P1：新 Step / 新 Tool 大量扩展前建立** |

总体判断：这三个问题都应该在 Jojo 从 Desktop Agent 向通用 Agent、HTTP Server、Scheduler、Browser Automation V2 扩展前补齐。

---

# 2. 问题一：删除运行中会话的 JSONL 竞态

## 2.1 当前实现

当前 `packages/storage/src/index.ts` 中，`JsonlSessionStore` 使用进程内 Set 阻止同一 Session 同时运行两个 Turn：

```ts
private readonly locks = new Set<string>();

acquire(sessionId: string): () => void {
  if (this.locks.has(sessionId)) {
    throw new Error('A turn is already running for this session.');
  }
  this.locks.add(sessionId);
  return () => this.locks.delete(sessionId);
}
```

但写入和删除没有共享该生命周期状态：

```ts
private async append(sessionId: string, record: SessionRecord): Promise<void> {
  await appendFile(this.file(sessionId), `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  });
}

async delete(sessionId: string): Promise<void> {
  try { await unlink(this.file(sessionId)); }
  catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
```

这里的 `locks` 只能理解为 **duplicate turn guard**，不能理解为 Session 全局生命周期锁。

更重要的是 Desktop Main 和 Worker 是两个进程，它们各自实例化自己的 Store 时，内存里的：

```text
MainStore.locks !== WorkerStore.locks
```

因此 Storage 的 Set 无法形成 Main↔Worker 的跨进程互斥。

---

## 2.2 当前已经做对的一部分

当前 `apps/desktop/src/main/main.ts` 删除并不是直接 unlink：

```ts
await stopSessionRuntime(sessionId);
await sessionStore.delete(sessionId);
```

Worker 的 `stopSession()` 当前会：

```text
abort current turn
      ↓
resolve pending approvals as deny
      ↓
await turnTasks.wait(sessionId)
      ↓
subAgentManager.quiesceSession(sessionId)
workflowManager.quiesceSession(sessionId)
      ↓
delete agent runtime state
      ↓
clear memory/session hook runtime
```

这说明截图中“完全可以边运行边直接删除”的描述已经不是当前代码的完整情况。

正确结论是：

> **Jojo 已经有 stop/quiesce，但还没有形成原子的 Session Delete Lifecycle。**

---

## 2.3 仍然存在的 TOCTOU

Main 的删除流程：

```text
stopSessionRuntime(A)
        ↓
Worker 回 session.stopped
        ↓
sessionStore.delete(A)
```

Main 的 `startTurn` 同时是：

```text
sessionStore.get(A)
      ↓
存在就 worker.postMessage(turn.start)
```

因此存在如下序列：

```text
T0  Turn A 正在运行
T1  用户 Delete A
T2  Main -> Worker: session.stop(A)
T3  Worker abort + wait + quiesce
T4  Worker -> Main: session.stopped(A)

    ---- 竞态窗口 ----

T5  另一个请求 startTurn(A)
T6  sessionStore.get(A) 仍然成功，因为 JSONL 还没 unlink
T7  Main -> Worker: turn.start(A)
T8  Main unlink(A.jsonl)
T9  新 Turn 后续 append(A.jsonl)
```

由于当前 append 使用：

```ts
flag: 'a'
```

文件不存在时可以重新创建，所以最终可能出现：

```text
A.jsonl 被删
   ↓
晚到的新任务 append
   ↓
A.jsonl 重新出现
```

而新文件可能只有后续 message，没有最初的 `meta` record，形成 orphan / partial JSONL。

未来增加 HTTP API、Scheduler、Browser、Workflow、IM、多客户端后，这种 race 的发生概率会明显上升。

---

# 3. 问题一修复方案：Session Lifecycle Authority

## 3.1 核心不变量

必须建立两个系统不变量：

```text
DELETE STARTED
    => no new mutation may begin
```

```text
DELETED
    => no late writer may recreate durable session
```

不要仅依赖 Renderer 把按钮禁用，也不要只给 `JsonlSessionStore.delete()` 加一个 `locks.has()`。

---

## 3.2 新增 SessionLifecycleManager

短期可放：

```text
apps/desktop/src/main/session-lifecycle.ts
```

长期随 HTTP Server 的 App Service 抽到：

```text
packages/app-service/src/session-lifecycle.ts
```

建议状态：

```ts
type SessionLifecycleState =
  | 'active'
  | 'stopping'
  | 'deleting'
  | 'deleted';
```

接口示意：

```ts
interface SessionLifecycle {
  assertMutable(sessionId: string): void;
  beginDelete(sessionId: string): DeleteLease;
  state(sessionId: string): SessionLifecycleState;
}

interface DeleteLease {
  commit(): void;
  rollback(): void;
}
```

最关键的一点：

```ts
const lease = lifecycle.beginDelete(sessionId);
```

必须发生在第一个 `await` 之前。

正确顺序：

```ts
async function deleteSession(sessionId: string) {
  const lease = lifecycle.beginDelete(sessionId);

  try {
    await runtimeHost.stopSession(sessionId);
    await sessionStore.deleteExclusive(sessionId);
    lease.commit();
  } catch (error) {
    lease.rollback();
    throw error;
  }
}
```

一旦 `beginDelete()` 成功，`startTurn`、Workflow resume、bind project、rename 等新的 mutation 都必须立即拒绝。

---

## 3.3 所有 Session Mutation 都必须过同一个 Gate

至少包括：

```text
startTurn
renameSession
bindSessionProject
workflow start / resume
subagent start
browser replay / session-bound browser operation
appendMessage
session metadata mutation
```

长期不要把这些判断散落在 `ipcMain.handle()` 中，而是统一为：

```text
Desktop IPC / HTTP / CLI
        ↓
SessionService
        ↓
SessionLifecycleManager
        ↓
Runtime + Storage
```

这样未来 HTTP Server 不会再复制一遍删除逻辑。

---

## 3.4 Storage 层增加第二道防线

App Service 管生命周期，Storage 仍需 fail closed。

建议至少让 Storage 支持：

```text
active
vs
tombstoned/deleting
```

删除后的旧 writer 不允许继续 append。

更稳健的长期方案是为写操作引入 Session Generation：

```text
Session A generation = 7
Turn 获取 lease(A, 7)

Delete A
=> generation 7 tombstoned

晚到的 append(A, 7)
=> reject
```

这样即使旧 Promise、重试、异步 callback 晚到，也不能“复活”已经删除的会话。

---

## 3.5 JSONL 删除采用 Tombstone + Rename

可以把：

```text
A.jsonl
```

先 rename 为：

```text
.trash/A.<deleteId>.jsonl
```

再异步清理。

流程：

```text
mark deleting
      ↓
quiesce all session tasks
      ↓
rename active JSONL -> .trash
      ↓
clear runtime state
      ↓
unlink trash
      ↓
mark deleted
```

但注意：**rename 本身不能替代 Lifecycle Gate**。如果旧 writer 还能 `appendFile(A.jsonl, flag:'a')`，它仍然会重新创建旧路径。

---

## 3.6 必须增加的 Race Tests

新增：

```text
packages/storage/test/session-delete-race.test.ts
```

至少覆盖：

```text
1. deleting/deleted session append 必须失败
2. delete 完成后 JSONL 不允许再次出现
3. duplicate delete 幂等或返回明确状态
4. delete 与 append 人为 barrier 并发时不会产生 partial JSONL
```

App Service 级测试：

```text
delete begin
   ↓ PAUSE
startTurn same session
   ↓
必须返回 session_deleting / session_unavailable
```

Electron E2E 再增加：

```text
long turn
  ↓
delete session
  ↓
并发触发 send
  ↓
重启应用
  ↓
session 不复活，JSONL 不复活
```

---

# 4. 问题二：IPC 运行时校验缺口

## 4.1 当前不是“Main 全没校验”

这一点需要纠正。

当前 Renderer→Main 的很多 handler 已经：

```ts
assertTrusted(event);
SomeInputSchema.parse(raw);
```

例如：

```text
StartTurnInputSchema
CreateSessionInputSchema
RenameSessionInputSchema
BindSessionProjectInputSchema
ApprovalInputSchema
WorkflowRunActionInputSchema
Memory/Hook/Browser input schemas
```

Main 还通过 `assertTrusted()` 检查 sender/origin。

所以这一部分是当前 Jojo 的优点。

---

## 4.2 真正缺的是 Main↔Worker Runtime Schema

`packages/contracts/src/desktop.ts` 当前的：

```ts
export type WorkerCommand = ...
export type WorkerMessage = ...
```

只是 TypeScript union。

TS 编译后不提供任何运行时保护。

Worker 当前的入站模式类似：

```ts
parentPort.on('message', (event) => {
  const command = event.data;
  if (command.type === 'turn.start') ...
});
```

Main 当前的 Worker 消息处理类似：

```ts
worker.on('message', (message: WorkerMessage) => {
  if (message.type === 'agent.event') {
    sendToRenderer(IPC.agentEvent, message.event);
  }
});
```

二者都没有：

```ts
WorkerCommandSchema.safeParse(...)
WorkerMessageSchema.safeParse(...)
```

---

## 4.3 Preload Push Event 也主要依赖 TS 类型

当前：

```ts
onAgentEvent: (listener) => {
  const handler = (_event, value: AgentEvent) => listener(value);
  ipcRenderer.on(IPC.agentEvent, handler);
};
```

这里的：

```ts
value: AgentEvent
```

仍然只是编译期声明。

同类还有：

```text
OrchestrationEvent
BrowserDockState
BrowserSecretRequest
```

其中 `OrchestrationEventSchema` 其实已经存在，可以直接复用；`AgentEvent` 当前则还是纯类型，需要补 Schema。

---

# 5. 问题二修复方案：每个跨进程边界都 Parse

原则：

> **任何跨 privilege/process boundary 的数据，在 parse 成功前都视为 `unknown`。**

目标链路：

```text
Renderer
   ↓ validated invoke input
Main
   ↓ validated WorkerCommand
Worker
   ↓ validated WorkerMessage
Main
   ↓ validated push event
Preload
   ↓ validated event
Renderer
```

---

## 5.1 新增 AgentEventSchema

当前 `packages/contracts/src/agent.ts` 中 `AgentEvent` 是纯 type。

改为 Zod-derived type：

```ts
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.started'),
    sessionId: z.string().min(1),
    turnId: z.string().min(1)
  }).strict(),

  z.object({
    type: z.literal('text.delta'),
    text: z.string().max(100_000)
  }).strict(),

  // ...
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
```

跨 IPC 的 `tool.started.input` 不建议永久保持 `unknown`，应收敛成有深度/大小限制的 JSON-compatible value。

---

## 5.2 新增 WorkerCommandSchema / WorkerMessageSchema

建议拆出：

```text
packages/contracts/src/desktop-ipc.ts
```

例如：

```ts
export const WorkerCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn.start'),
    payload: StartTurnInputSchema
  }).strict(),

  z.object({
    type: z.literal('turn.cancel'),
    sessionId: SessionIdSchema
  }).strict(),

  z.object({
    type: z.literal('session.stop'),
    requestId: RequestIdSchema,
    sessionId: SessionIdSchema
  }).strict(),

  // ...
]);
```

`WorkerMessageSchema`：

```ts
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),

  z.object({
    type: z.literal('agent.event'),
    event: AgentEventSchema
  }).strict(),

  z.object({
    type: z.literal('orchestration.event'),
    event: OrchestrationEventSchema
  }).strict(),

  // ...
]);
```

对 IPC boundary 推荐 `.strict()`，不要默默接受未知字段。

---

## 5.3 Worker 入站类型必须改为 unknown

不要：

```ts
event.data: WorkerCommand
```

要：

```ts
event.data: unknown
```

并立即：

```ts
parentPort.on('message', (event) => {
  const parsed = WorkerCommandSchema.safeParse(event.data);

  if (!parsed.success) {
    reportProtocolViolation('main_to_worker', parsed.error);
    return;
  }

  dispatchWorkerCommand(parsed.data);
});
```

类型来源必须是 `safeParse()` 的结果，而不是对外部值做类型声明。

---

## 5.4 Main 收 Worker 消息必须 parse

```ts
worker.on('message', (raw: unknown) => {
  const parsed = WorkerMessageSchema.safeParse(raw);

  if (!parsed.success) {
    reportWorkerProtocolViolation(parsed.error);
    return;
  }

  dispatchWorkerMessage(parsed.data);
});
```

非法消息不得继续转 Renderer。

---

## 5.5 Main 发 Worker 前也校验

建立：

```ts
function postWorkerCommand(command: WorkerCommand): void {
  const valid = WorkerCommandSchema.parse(command);
  worker?.postMessage(valid);
}
```

这样可以提前发现 Main 与 contracts 版本漂移。

---

## 5.6 Preload Push Event 再次 parse

例如：

```ts
onOrchestrationEvent: (listener) => {
  const handler = (_event, raw: unknown) => {
    const parsed = OrchestrationEventSchema.safeParse(raw);
    if (!parsed.success) return;
    listener(parsed.data);
  };

  ipcRenderer.on(IPC.orchestrationEvent, handler);
  return () => ipcRenderer.removeListener(IPC.orchestrationEvent, handler);
};
```

Agent、BrowserDock、BrowserSecret 等同理。

对结构复杂或高权限的 `ipcRenderer.invoke()` response，也建议逐步加入 response schema 校验。

---

## 5.7 IPC Size Guard

新增：

```text
MAX_WORKER_MESSAGE_BYTES
MAX_AGENT_EVENT_BYTES
MAX_ORCHESTRATION_EVENT_BYTES
```

尤其防止：

```text
巨大 tool output
巨大 workflow snapshot
巨大 browser diagnostics
```

拖死 Main / Renderer。

Protocol violation 日志不要输出完整 payload，只记录：

```text
direction
message type
issue path
requestId
serialized size
```

避免 prompt/tool input/secret-like data 进入日志。

---

## 5.8 IPC Contract Tests

新增：

```text
packages/contracts/test/desktop-ipc.test.ts
```

覆盖：

```text
每一个 WorkerCommand branch
每一个 WorkerMessage branch
unknown type reject
unknown field reject
nested malformed payload reject
NaN/Infinity reject
oversized field reject
invalid approval reject
```

再增加 Worker boundary integration test，验证 malformed command：

```text
不会执行 Tool
不会 resolve Approval
不会启动 Turn
```

---

# 6. 问题三：缺少真正的离线 Electron E2E

## 6.1 当前已有很多测试，但不是 Electron E2E

当前仓库已经有：

```text
Agent / Agent Runtime unit tests
Storage tests
Memory tests
Workflow Engine / Sub-Agent tests
Renderer state tests
Worker browser-tools tests
Worker orchestration-runtime tests
```

并且存在：

```text
apps/desktop/src/worker/write-agent.e2e.test.ts
```

这个测试有价值，但它仍属于 Worker/Runtime 层，并没有真正验证：

```text
Electron
  ↓
Main
  ↓
Preload
  ↓
Renderer
  ↓
IPC
  ↓
UtilityProcess Worker
```

完整链路。

---

## 6.2 当前 CI 没有启动 Electron

Root scripts 主要是：

```text
lint
typecheck
vitest
build/package
```

Desktop scripts 只有：

```text
start
package
make
```

CI 当前执行：

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @desktop-agent/desktop package
```

`package` 只能证明能打包，不能证明真实 App 能启动，更不能验证 Main/Preload/Worker 的 runtime contract。

---

# 7. 问题三修复方案：Playwright Electron Offline Smoke

## 7.1 目录建议

```text
apps/desktop/e2e/
├── fixtures/
│   └── workspace/
├── helpers/
│   ├── launch-electron.ts
│   ├── wait-for-agent.ts
│   └── temp-data-dir.ts
├── smoke.spec.ts
├── approval.spec.ts
├── session-delete.spec.ts
├── workflow.spec.ts
└── tools.spec.ts

apps/desktop/playwright.electron.config.ts
```

使用：

```text
@playwright/test
Playwright Electron support
```

---

## 7.2 必须完全离线

E2E 不允许依赖：

```text
OpenAI / Anthropic
真实 API key
公网 MCP
真实 Chrome 登录
互联网
```

建议：

```text
JOJO_E2E=1
```

下注入 deterministic Scripted Provider。Jojo 已有 `packages/agent/src/scripted-provider.ts`，可以复用这个思路。

例如：

```text
E2E: text
=> 固定输出 hello

E2E: approval
=> 固定触发 write_file tool call

E2E: slow
=> 固定等待，允许测试 Cancel/Delete
```

测试必须使用临时：

```text
userData
workspace
data dir
```

避免污染真实用户配置。

---

## 7.3 PR 必跑最小 Smoke

### E2E-01 Boot

验证：

```text
Main 启动
Preload expose 成功
Renderer 首屏正常
Worker ready
无 boot error
```

### E2E-02 Session + Prompt

```text
Create Session
Send Prompt
Scripted Provider response
text.delta
turn.completed
```

验证 UI 与 durable session。

### E2E-03 Approval Allow / Deny

固定触发一个 mutating tool：

```text
approval.required
      ↓
UI Allow
      ↓
Tool side effect
      ↓
tool.finished
```

再跑 Deny，确保文件没有改变。

### E2E-04 Cancel

```text
slow turn
  ↓
Stop
  ↓
turn.cancelled
```

并确保后续副作用不再发生。

### E2E-05 Delete Running Session

直接验证问题一：

```text
start slow turn
  ↓
delete session
  ↓
并发尝试 send
  ↓
等待删除完成
  ↓
重启 Electron
```

断言：

```text
session 不在 list
JSONL 不复活
runtime DB 无 active operation
无 active Sub-Agent / Workflow
```

---

# 8. 新 Workflow Step / 新 Tool 的集成准入规则

以后新增 Workflow Step，不能只满足“Schema + Engine 单测”。

必须至少包含：

```text
1. Contract Schema Test
2. Executor Unit Test
3. Workflow Engine Test
4. Worker Wiring Test
5. Renderer State/Snapshot Test
6. Electron Smoke Path
```

新增高权限 Tool：

```text
1. Input Schema Test
2. Tool Execution Test
3. Permission Policy Test
4. Worker Registry Test
5. Approval Electron Smoke
6. interruption/replay test（长任务时）
```

这样新 Step、新工具不会在最后 Main/Preload/Worker 接线上才暴雷。

---

# 9. CI 建议

Root：

```json
{
  "scripts": {
    "test:e2e:electron": "pnpm --filter @desktop-agent/desktop test:e2e"
  }
}
```

Desktop：

```json
{
  "scripts": {
    "test:e2e": "playwright test -c playwright.electron.config.ts"
  }
}
```

Linux CI：

```yaml
- name: Electron E2E smoke
  run: xvfb-run -a pnpm test:e2e:electron
```

建议两层：

```text
PR:
Fast Electron Smoke on Ubuntu

Nightly / Release:
Packaged Electron Smoke
Ubuntu + Windows + macOS
```

现有 `electron-forge package` 继续保留，不应被 E2E 替换。

---

# 10. 三个问题的统一修复架构

这三个问题本质上都属于 **Runtime Boundary Hardening**：

```text
                    Renderer
                       │
                 validated IPC
                       │
                    Preload
                       │
                 validated IPC
                       │
                      Main
                       │
                  App Service
                       │
            Session Lifecycle Authority
                       │
                 Runtime Bridge
                       │
                 validated IPC
                       │
                     Worker
                       │
        Agent / Workflow / Browser / Memory
                       │
                guarded persistence
```

核心原则：

```text
Session lifecycle is explicit.

IPC payloads are untrusted until parsed.

Deleted sessions cannot be resurrected by late writers.

Every privileged cross-process feature has an offline Electron smoke path.
```

---

# 11. 建议新增一个前置阶段：S0 Runtime Boundary Hardening

在继续 HTTP Server / Browser V2 / Scheduler 前，增加：

## S0.1 IPC Runtime Schema — P0

修改：

```text
packages/contracts/src/agent.ts
packages/contracts/src/desktop.ts
packages/contracts/src/desktop-ipc.ts      NEW
```

实现：

```text
AgentEventSchema
WorkerCommandSchema
WorkerMessageSchema
BrowserSecretRequestSchema
必要的 JSON bounded schema
```

## S0.2 Main / Preload / Worker Parse — P0

修改：

```text
apps/desktop/src/main/main.ts
apps/desktop/src/preload/preload.ts
apps/desktop/src/worker/worker.ts
```

原则：所有 inbound payload 先 `unknown`，再 `safeParse()`。

## S0.3 Session Lifecycle — P0

新增：

```text
packages/app-service/src/session-lifecycle.ts
```

如果 App Service 尚未落地，可暂存在 Desktop Main，随后迁移。

实现：

```text
active / deleting / deleted
mutation gate
exclusive delete
late-writer rejection
```

## S0.4 JSONL Race Tests — P0

新增：

```text
packages/storage/test/session-delete-race.test.ts
```

## S0.5 Electron Offline Smoke — P1

新增：

```text
apps/desktop/e2e/
playwright.electron.config.ts
```

---

# 12. 推荐实施顺序

| Phase | 内容 | Priority |
|---|---|---|
| R1 | `AgentEventSchema` / `WorkerCommandSchema` / `WorkerMessageSchema` | P0 |
| R2 | Main / Worker / Preload runtime parse | P0 |
| R3 | SessionLifecycleManager + delete tombstone | P0 |
| R4 | Storage append-after-delete 防御 / generation | P0 |
| R5 | deterministic delete race tests | P0 |
| R6 | Playwright Electron offline harness | P1 |
| R7 | Boot / Prompt / Approval / Cancel smoke | P1 |
| R8 | Running-session Delete smoke | P1 |
| R9 | Workflow / Tool smoke | P1 |
| R10 | CI PR gate + packaged nightly smoke | P1 |

建议 **R1~R5 完成后再继续大规模推进 HTTP Server H4+、Browser Automation B3+、Scheduler 或更多高权限 Tool**。

---

# 13. 验收标准

## IPC

必须满足：

```text
malformed WorkerCommand
=> Worker 不执行

malformed WorkerMessage
=> Main 不转发

malformed Preload push event
=> Renderer listener 不被调用
```

## Session Delete

必须满足：

```text
deleting session
=> startTurn rejected

deleted session
=> append rejected

delete complete
=> JSONL cannot resurrect

delete complete
=> no active runtime operation

delete complete
=> no active workflow/subagent
```

## Electron Smoke

每个 PR 至少验证：

```text
Boot
Create Session
Prompt
Approval Allow
Approval Deny
Cancel
Delete Running Session
```

---

# 14. 不推荐的“假修复”

不要只做：

```text
Renderer 禁用 Delete 按钮
```

UI 不是并发不变量。

不要只做：

```text
JsonlSessionStore.delete() 检查 locks.has()
```

Main 和 Worker 的 Set 不共享。

不要：

```text
sleep(100ms) 再 unlink
```

时间延迟不能解决 race。

不要继续只依赖：

```ts
message: WorkerMessage
```

TS 类型不是 Runtime Validation。

也不要把：

```text
apps/desktop/src/worker/write-agent.e2e.test.ts
```

当作 Electron E2E；它覆盖不到 Main / Preload / Renderer / packaged app。

---

# 15. 最终判断

三个问题的最终结论是：

```text
1. JSONL 删除竞态：
   存在。
   当前已有 stop/quiesce，
   但缺少 Session 生命周期原子性和 late-writer 防护。

2. IPC 校验：
   存在。
   Main invoke 输入做得相对好，
   但 Main↔Worker 和 push-event 边界仍主要靠 TypeScript。

3. Electron E2E：
   存在。
   已有大量 unit/integration，
   但没有真正 Electron process smoke。
```

因此最合适的处理不是三个零散 patch，而是统一建设：

# S0 — Runtime Boundary Hardening

完成它以后再继续：

```text
HTTP Server
Browser Automation V2
Scheduler
更多 Workflow Step
更多高权限 Tool
```

Jojo 后续扩展时会少掉一大类“单测全绿、真实运行却竞态/接线失败”的问题。

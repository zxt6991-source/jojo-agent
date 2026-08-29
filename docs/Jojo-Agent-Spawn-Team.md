# Jojo Agent Spawn / Team 具体实现设计

> 建议文件：`docs/spawn-team-implementation-design.md`  
> 基线：最新 `main`  
> 状态：Implementation Design  
> 目标：在现有 Sub-Agent / AgentRuntime / Workflow / Permission Governance 基础上，实现通用 Agent 所需的 Spawn 与 Persistent Team 能力。

---

# 1. 背景

Jojo 当前已经存在一套比较完整的 Sub-Agent 基础设施：

```text
Main Agent
   │
   ├── sub_agent_start
   ├── sub_agent_wait
   ├── sub_agent_status
   ├── sub_agent_send
   ├── sub_agent_cancel
   └── sub_agent_close
            │
            ▼
      SubAgentManager
            │
            ▼
      LeafAgentRunner
            │
            ▼
       AgentRuntime
            │
            ▼
       agent:<id> Lane
```

并已经支持：

- 独立 Agent Profile；
- 独立 Model；
- 独立 Tool Policy；
- 独立 Runtime Lane；
- Usage；
- Timeout；
- Continuation；
- Worktree Isolation；
- Memory Binding；
- Provider Semaphore；
- Resource Group；
- Global Agent Scheduler；
- Structured Output；
- Hooks；
- Permission Governance。

因此：

> Spawn 不应该重新实现一套 Agent Runtime。

正确方案是：

```text
现有 Sub-Agent
        ↓
抽象成 Spawn Primitive
```

Team 则建立在：

```text
AgentRuntime Persistent Lane
+
Agent Profile
+
Durable Team Store
+
Inbox
+
Spawn
```

之上。

---

# 2. Spawn 与 Team 的职责必须分开

首先明确两个概念。

## Spawn

Spawn 是：

```text
一次临时委派
```

生命周期：

```text
spawn
  ↓
queued
  ↓
running
  ↓
idle / completed
  ↓
close
```

适合：

- 搜索代码；
- 调查问题；
- Code Review；
- 临时修改代码；
- 并行研究；
- 一次性分析。

Spawn 默认是：

```text
Ephemeral Agent
```

---

## Team

Team 是：

```text
长期存在的 Agent Identity
```

例如：

```text
team: backend

members:

architect
backend-dev
reviewer
researcher
```

这些成员：

- 有稳定 ID；
- 有稳定 Profile；
- 有自己的 Runtime Lane；
- 有自己的上下文；
- 有自己的 Inbox；
- App 重启后仍然存在；
- 可以被反复委派任务。

因此：

```text
Spawn = temporary worker

Team Member = persistent worker identity
```

不要把两者混成同一个生命周期。

---

# 3. 最终目标架构

```text
                         Main Agent
                             │
                ┌────────────┴─────────────┐
                │                          │
                ▼                          ▼
              Spawn                      Team
                │                          │
                ▼                          ▼
        Ephemeral Agent             Persistent Members
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                         architect      developer    reviewer
                              │            │            │
                              └────────────┼────────────┘
                                           │
                                           ▼
                                     AgentRuntime
                                           │
                     ┌─────────────────────┼────────────────────┐
                     ▼                     ▼                    ▼
                agent:sa_xxx        team:xxx:architect   team:xxx:reviewer
                                           │
                                           ▼
                                  Permission Governance
                                           │
                                           ▼
                                      Tool Runtime
```

---

# 4. 设计原则

## 4.1 Spawn 复用 SubAgentManager

不要新建：

```text
SpawnEngine
```

然后重新实现：

```text
scheduler
provider semaphore
worktree
timeout
usage
output schema
```

第一阶段直接：

```text
SubAgentManager
      ↓
演进为 Spawn Runtime
```

---

# 5. Team 不使用“永远运行的 Agent”

Persistent Team 不代表：

```text
每个成员一直占一个线程
```

或者：

```text
每个成员一直跑一个 LLM loop
```

正确模型：

```text
Team Member
   │
   ├── persistent identity
   ├── persistent lane
   ├── persistent inbox
   │
   └── dormant
         │
         │ delegate
         ▼
       wake
         │
         ▼
     Agent run
         │
         ▼
       idle
```

因此 Team 可以长期存在，而几乎不消耗运行资源。

---

# 6. 当前代码与新架构映射

现有：

```text
SubAgentManager
```

继续负责：

```text
Ephemeral Spawn
```

现有：

```text
LeafAgentRunner
```

重构成通用：

```text
OrchestratedAgentRunner
```

供：

```text
Spawn
Team
Workflow
```

复用。

现有：

```text
AgentProfileRegistry
```

继续负责：

```text
Spawn Profile
Team Member Profile
Workflow Agent Profile
```

现有：

```text
AgentExecutionScheduler
ProviderSemaphore
ResourceGroupLimiter
```

由：

```text
Spawn
Workflow
Team
```

共享。

---

# 7. 第一项核心重构：LeafAgentRunner 泛化

当前名字：

```ts
LeafAgentRunner
```

已经开始限制架构表达。

Team Member 并不是：

```text
Leaf Sub-Agent
```

所以应该新增：

```ts
OrchestratedAgentRunner
```

---

# 8. OrchestratedAgentRunRequest

建议：

```ts
export type OrchestratedActor =
  | {
      kind: 'subagent';
      id: string;
      profile: string;
    }
  | {
      kind: 'team_member';
      id: string;
      profile: string;
      teamId: string;
      memberId: string;
    }
  | {
      kind: 'workflow';
      id: string;
      profile: string;
      workflowId: string;
      stepId?: string;
    };
```

通用 Request：

```ts
export type OrchestratedAgentRunRequest = {
  id: string;

  sessionId: string;

  laneId: string;

  parentLaneId?: string;

  workingDirectory: string;

  task: string;

  actor: OrchestratedActor;

  profile: SubAgentProfile;

  providerId: string;

  model: string;

  maxIterations: number;

  timeoutMs: number;

  tools?: AgentToolPolicy;

  readOnly?: boolean;

  outputSchema?: Record<string, unknown>;

  memoryBinding?:
    | SubAgentMemoryBinding
    | WorkflowMemoryBinding
    | TeamMemberMemoryBinding;

  hooks?: HookRuntime;
};
```

---

# 9. Runner 接口

```ts
export interface OrchestratedAgentRunner {

  run(
    request: OrchestratedAgentRunRequest,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<OrchestratedAgentRunResult>;

}
```

不再需要：

```ts
continue()
```

---

# 10. 为什么应该逐步去掉 continuationId

当前 Desktop Runner 有：

```text
continuations = new Map()
```

其作用本质上只是保存：

```text
continuationId -> LeafAgentRunRequest
```

但真正的 Agent Conversation 已经存在：

```text
AgentRuntime Lane
```

中。

例如：

```text
agent:sa_xxx
```

Runtime Lane 已经可以：

```ts
lane.run(...)
```

多次运行。

因此正确的“继续 Agent”模型应该是：

```text
相同 Lane
+
新的 Input
```

而不是：

```text
随机 continuationId
+
内存 Map
```

---

# 11. 改造后的 SubAgent send

现在：

```text
SubAgentManager.send()
    ↓
runner.continue(continuationId)
```

改为：

```text
SubAgentManager.send()
    ↓
runner.run({
    laneId: `agent:${id}`,
    task: message,
    ...
})
```

这样：

```text
Runtime Lane
```

本身就是 Continuation。

---

# 12. 直接收益

删除：

```text
continuations Map
```

之后：

- Runtime 上下文不再依赖 Worker 内存；
- Team Member 可以天然复用；
- App 重启后 Lane 仍然存在；
- Headless Daemon 更容易实现；
- Team 不需要另一套 conversation store。

---

# 13. 兼容现有 LeafAgentRunner

第一阶段不要直接删除。

增加：

```ts
export function createLeafAgentRunnerAdapter(
  runner: OrchestratedAgentRunner
): LeafAgentRunner
```

现有：

```text
SubAgentManager
WorkflowEngine
```

可以逐步迁移。

---

# 14. Runtime Actor 扩展

当前：

```ts
type RuntimeActor = {
  kind:
    | 'main'
    | 'subagent'
    | 'workflow';
}
```

增加：

```ts
export type RuntimeActor = {
  kind:
    | 'main'
    | 'subagent'
    | 'workflow'
    | 'team_member';

  id?: string;

  profile?: string;
};
```

---

# 15. 增加 RuntimeTeamContext

不要把所有 Team 信息塞进：

```text
actor.id
```

增加：

```ts
export type RuntimeTeamContext = {
  id: string;

  memberId: string;

  taskId?: string;
};
```

`RunRequest`：

```ts
export type RunRequest = {

  ...

  actor?: RuntimeActor;

  workflow?: RuntimeWorkflowContext;

  team?: RuntimeTeamContext;

};
```

---

# 16. RuntimeResolutionContext

增加：

```ts
export type RuntimeResolutionContext = {

  ...

  actor?: RuntimeActor;

  workflow?: RuntimeWorkflowContext;

  team?: RuntimeTeamContext;

};
```

这样：

```text
Permission Governance
Hooks
Telemetry
MCP
Audit
```

都可以知道：

```text
这个 Tool 是哪个 Team Member 调的
```

---

# 17. Spawn V1 的定位

Spawn V1 不需要把 Tool 名立刻从：

```text
sub_agent_start
```

改成：

```text
agent_spawn
```

因为会造成：

- Prompt 兼容变化；
- 文档变化；
- Workflow/Tests 大量修改；
- 两组 Tool 同时存在时增加模型困惑。

因此 M1 建议：

```text
产品语义 = Spawn

Tool Name = 暂时保留 sub_agent_*
```

内部代码开始使用：

```text
spawn
```

术语。

---

# 18. 可选的最终 Tool Naming

未来 v1 API 稳定后：

```text
agent_spawn
agent_wait
agent_status
agent_send
agent_cancel
agent_close
```

代替：

```text
sub_agent_*
```

但不是当前优先级。

---

# 19. Spawn Parent 信息

当前 `SubAgentStartRequest` 只有：

```ts
depth?: number
```

建议改成：

```ts
export type SpawnParent = {
  actor:
    | 'main'
    | 'team_member'
    | 'workflow'
    | 'subagent';

  actorId?: string;

  teamId?: string;

  parentSpawnId?: string;

  depth: number;
};
```

然后：

```ts
SubAgentStartRequest {
  ...

  parent: SpawnParent;
}
```

---

# 20. SpawnSnapshot 增加 Lineage

增加：

```ts
parent?: {
  actor: string;
  actorId?: string;
  teamId?: string;
};

depth: number;
```

后续 UI 可以展示：

```text
Main
 └─ architect
      └─ explore-1
```

---

# 21. Nested Spawn 策略

当前明确：

```text
depth >= 1
→ nested_subagent_forbidden
```

M1 建议仍然保持：

```text
Spawn Agent = Leaf
```

即：

```text
Main
  └─ Spawn

Team Member
  └─ Spawn
```

允许。

但：

```text
Spawn
  └─ Spawn
```

先不允许。

---

# 22. 为什么先不开放无限递归

否则非常容易出现：

```text
A spawns B
B spawns C
C spawns D
...
```

带来：

- Token 爆炸；
- Provider 并发爆炸；
- Worktree 爆炸；
- Permission 审批链复杂化；
- Parent Cancel 传播复杂。

所以：

```text
Team Member
```

可以作为稳定 Coordinator。

临时 Spawn 仍然保持 Leaf。

---

# 23. Team 核心模型

Team 需要区分：

```text
Team Definition
```

和：

```text
Team Runtime State
```

---

# 24. TeamDefinition

```ts
export type TeamDefinition = {
  id: string;

  name: string;

  description?: string;

  workspace: string;

  members: TeamMemberDefinition[];

  maxConcurrency: number;

  createdAt: string;

  updatedAt: string;
};
```

---

# 25. TeamMemberDefinition

```ts
export type TeamMemberDefinition = {
  id: string;

  name: string;

  description?: string;

  profile: SubAgentProfile;

  providerId?: string;

  model?: string;

  systemPrompt?: string;

  readOnly?: boolean;

  tools?: AgentToolPolicy;

  spawn?: {
    enabled: boolean;

    profiles?: string[];

    maxActive?: number;
  };
};
```

---

# 26. 示例 Team

```yaml
id: engineering
name: Engineering Team

members:

  - id: architect
    name: Architect
    profile: explore

    systemPrompt: >
      Focus on architecture, interfaces,
      dependency boundaries and design risks.

    spawn:
      enabled: true
      profiles:
        - explore

  - id: developer
    name: Developer
    profile: general

  - id: reviewer
    name: Reviewer
    profile: code-review
```

---

# 27. Team Member 不应该复制 Profile

TeamMemberDefinition：

```text
引用 Profile
+
覆盖少量字段
```

例如：

```text
profile=explore
+
systemPrompt overlay
+
model override
```

不要：

```text
Team Member
拥有另一套完整 Tool/Profile 系统
```

---

# 28. Effective Team Member Config

计算：

```text
Agent Profile
       +
Team Member Overrides
       +
Runtime Request
       ↓
EffectiveAgentConfig
```

建议增加：

```ts
export type EffectiveAgentConfig = {
  profile: AgentProfileDefinition;

  model: string;

  readOnly: boolean;

  allowedTools: string[];

  systemPrompt: string;

  maxIterations: number;

  timeoutMs: number;
};
```

让 Spawn 和 Team 共用。

---

# 29. Team 的 Runtime Session 选择

这里不建议把 Team Member Lane 放进普通聊天 Session：

```text
session abc
  main
  team:architect
```

因为 Team 是长期对象。

如果用户删除聊天 Session：

```text
Team context
```

不应该一起消失。

---

# 30. 推荐：Team 使用隐藏 Runtime Session

一个 Workspace Team：

```text
teamId = engineering
```

建立：

```text
Runtime Session:

team:<workspaceHash>:engineering
```

例如：

```text
session:
team:2f36bd:engineering
```

里面：

```text
main
member:architect
member:developer
member:reviewer
```

---

# 31. Team Runtime 结构

```text
Runtime Session
team:<workspace>:engineering
│
├── main
│
├── member:architect
│
├── member:developer
│
└── member:reviewer
```

这里：

```text
main
```

不是用户 Main Agent。

只是：

```text
Team Runtime Root Lane
```

用于 Lane ancestry。

---

# 32. Team Member Lane

稳定：

```text
member:<memberId>
```

比如：

```text
member:architect
```

每次 Delegate：

```ts
const lane =
  await teamSession.getLane(
    'member:architect'
  );

await lane.run({
  input: task,
  ...
});
```

自然继承全部历史上下文。

---

# 33. Team Member 不需要 continuationId

因为：

```text
Team Member Identity
      ↓
Stable Runtime Lane
```

就是持久 Continuation。

---

# 34. TeamStore

新增：

```ts
export interface TeamStore {

  createTeam(
    definition: TeamDefinition
  ): Promise<TeamRecord>;

  getTeam(
    id: string
  ): Promise<TeamRecord | undefined>;

  listTeams(
    workspace?: string
  ): Promise<TeamRecord[]>;

  updateTeam(...): Promise<TeamRecord>;

  deleteTeam(...): Promise<void>;

  createTask(...): Promise<TeamTaskRecord>;

  updateTask(...): Promise<TeamTaskRecord>;

  enqueueMessage(...): Promise<TeamMessageRecord>;

  listInbox(...): Promise<TeamMessageRecord[]>;

  markMessageRead(...): Promise<void>;

}
```

---

# 35. Persistence

新增：

```text
packages/storage/src/sqlite-team-store.ts
```

数据库建议：

```text
runtime/teams.sqlite
```

---

# 36. teams 表

```sql
CREATE TABLE teams (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    description TEXT,

    workspace_key TEXT NOT NULL,

    runtime_session_id TEXT NOT NULL,

    max_concurrency INTEGER NOT NULL,

    revision INTEGER NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

---

# 37. team_members

```sql
CREATE TABLE team_members (
    id TEXT NOT NULL,

    team_id TEXT NOT NULL,

    name TEXT NOT NULL,

    description TEXT,

    profile TEXT NOT NULL,

    provider_id TEXT,

    model TEXT,

    system_prompt TEXT,

    read_only INTEGER,

    tool_policy_json TEXT,

    spawn_policy_json TEXT,

    lane_id TEXT NOT NULL,

    state TEXT NOT NULL,

    revision INTEGER NOT NULL,

    created_at TEXT NOT NULL,

    updated_at TEXT NOT NULL,

    PRIMARY KEY (
      team_id,
      id
    )
);
```

---

# 38. Team Member State

成员不是：

```text
running forever
```

状态：

```ts
type TeamMemberState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'disabled'
  | 'error';
```

---

# 39. team_tasks

每一次 Delegate 单独记录：

```sql
CREATE TABLE team_tasks (
    id TEXT PRIMARY KEY,

    team_id TEXT NOT NULL,

    member_id TEXT NOT NULL,

    parent_session_id TEXT,

    parent_run_id TEXT,

    runtime_run_id TEXT,

    input TEXT NOT NULL,

    status TEXT NOT NULL,

    result TEXT,

    error_code TEXT,

    error TEXT,

    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);
```

---

# 40. TeamTaskState

```ts
type TeamTaskState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
```

---

# 41. 为什么 TeamTask 要单独存

Runtime 已经存：

```text
Run
Transcript
Usage
```

TeamTask 不是重复 Runtime。

它负责：

```text
Who delegated?
Which team?
Which member?
Which user session?
Which parent run?
```

即：

```text
Orchestration Relationship
```

---

# 42. Inbox

Persistent Team 必须有：

```text
Inbox
```

否则 Team 只是：

```text
几个持久 Lane
```

而不是团队。

---

# 43. team_messages

```sql
CREATE TABLE team_messages (
    id TEXT PRIMARY KEY,

    team_id TEXT NOT NULL,

    sender_kind TEXT NOT NULL,

    sender_id TEXT,

    recipient_member_id TEXT NOT NULL,

    message_kind TEXT NOT NULL,

    subject TEXT,

    content TEXT NOT NULL,

    task_id TEXT,

    status TEXT NOT NULL,

    created_at TEXT NOT NULL,
    read_at TEXT
);
```

---

# 44. MessageKind

```ts
type TeamMessageKind =
  | 'task'
  | 'note'
  | 'question'
  | 'result'
  | 'system';
```

---

# 45. Inbox 原则

非常重要：

```text
Message != Execution
```

例如：

```text
reviewer
   ↓
team_send
   ↓
developer inbox
```

不应该立刻：

```text
自动唤醒 Developer
```

否则很容易形成：

```text
A → B
B → A
A → B
...
```

Agent Storm。

---

# 46. 唯一主动唤醒入口

第一版只有：

```text
team_delegate
```

可以唤醒 Team Member。

而：

```text
team_send
```

只写 Inbox。

---

# 47. TeamManager

新增：

```text
packages/orchestration/src/team/manager.ts
```

核心：

```ts
export class TeamManager {

  constructor(
    private readonly store: TeamStore,

    private readonly runner:
      OrchestratedAgentRunner,

    private readonly scheduler:
      AgentExecutionScheduler,

    private readonly providers:
      ProviderSemaphore,

    private readonly resourceGroups:
      ResourceGroupLimiter,

    private readonly profileRegistry:
      AgentProfileRegistry,

    private readonly emit:
      (event: OrchestrationEvent) => void
  ) {}

}
```

---

# 48. TeamManager 核心接口

```ts
create(...)

get(...)

list(...)

delegate(...)

wait(...)

cancel(...)

sendMessage(...)

listInbox(...)

markMessageRead(...)

enableMember(...)

disableMember(...)
```

---

# 49. Delegate

```ts
async delegate(
  request: TeamDelegateRequest
): Promise<TeamTaskSnapshot>
```

---

# 50. TeamDelegateRequest

```ts
export type TeamDelegateRequest = {
  teamId: string;

  memberId: string;

  task: string;

  parent: {
    sessionId: string;
    runId?: string;
    actorId?: string;
  };

  timeoutMs?: number;

  maxIterations?: number;

  outputSchema?: Record<string, unknown>;
};
```

---

# 51. Delegate 生命周期

```text
team_delegate
      │
      ▼
TeamStore.createTask()
      │
      ▼
queued
      │
      ▼
Per-member queue
      │
      ▼
Global AgentExecutionScheduler
      │
      ▼
ProviderSemaphore
      │
      ▼
member Runtime Lane
      │
      ▼
run()
      │
      ▼
completed / failed
```

---

# 52. 每个 Member 必须串行

同一个 Runtime Lane：

```text
member:architect
```

不能同时：

```text
Run A
Run B
```

因此：

```text
member-level concurrency = 1
```

---

# 53. 不同成员可以并行

例如：

```text
architect ─────► Task A
developer ─────► Task B
reviewer  ─────► Task C
```

继续受：

```text
AgentExecutionScheduler
ProviderSemaphore
Team maxConcurrency
```

控制。

---

# 54. Team Concurrency

Team 建议有：

```ts
maxConcurrency: 3
```

实现方式直接复用：

```text
ResourceGroupLimiter
```

Group：

```text
team:<teamId>
```

例如：

```text
team:engineering
```

---

# 55. Team Member 执行

伪代码：

```ts
private async executeTask(
  team: TeamRecord,
  member: TeamMemberRecord,
  task: TeamTaskRecord,
  signal: AbortSignal
) {

  const profile =
    this.profileRegistry.get(
      member.profile,
      team.workspace
    );

  const effective =
    resolveEffectiveAgentConfig(
      profile,
      member
    );

  const result =
    await this.runner.run({

      id: member.id,

      sessionId:
        team.runtimeSessionId,

      laneId:
        member.laneId,

      parentLaneId: 'main',

      workingDirectory:
        team.workspace,

      task:
        buildTeamMemberPrompt(
          task,
          member
        ),

      actor: {
        kind: 'team_member',
        id: member.id,
        profile: member.profile,
        teamId: team.id,
        memberId: member.id
      },

      ...
    }, signal, event => {

      this.emit({
        type: 'team.member.event',
        teamId: team.id,
        memberId: member.id,
        taskId: task.id,
        event
      });

    });

}
```

---

# 56. Team Prompt

每一次执行不应该把整个 Team 状态硬塞到 System Prompt。

只增加稳定身份：

```text
You are a persistent member of the
"Engineering Team".

Member:
architect

Role:
Architecture analysis.

You maintain conversation history
across delegated tasks.

Use your own previous findings when
relevant, but prioritize the current
delegated task.
```

---

# 57. Inbox 注入

每轮可注入：

```text
Unread team messages:
```

但必须有上限。

例如：

```text
max 20 messages
max 20 KB
```

更大量的信息通过：

```text
team_inbox
```

工具读取。

---

# 58. Team Member Tools

Team Member 除 Profile Tools 外，可以额外获得：

```text
team_inbox
team_send
```

如果允许 Spawn：

```text
sub_agent_start
sub_agent_wait
sub_agent_status
```

---

# 59. 不建议给 Member Team 管理权限

普通 Member 不应该拥有：

```text
team_create
team_delete
team_add_member
team_remove_member
```

否则：

```text
成员自己修改组织结构
```

权限太大。

---

# 60. Spawn Policy

Team Member：

```yaml
spawn:
  enabled: true

  profiles:
    - explore

  maxActive: 2
```

例如 Architect 可以：

```text
architect
   │
   ├── spawn explore A
   └── spawn explore B
```

但 Spawn Agent 本身仍是 Leaf。

---

# 61. Team 内 Spawn Parent

```ts
parent: {
  actor: 'team_member',
  actorId: 'architect',
  teamId: 'engineering',
  depth: 0
}
```

方便：

- Audit；
- Usage；
- UI；
- Cancel propagation。

---

# 62. Spawn Ownership

SubAgentSnapshot 增加：

```ts
owner?: {
  kind:
    | 'main'
    | 'team_member'
    | 'workflow';

  id?: string;

  teamId?: string;
};
```

---

# 63. Cancel Propagation

如果：

```text
Team Task
   ↓
spawn A
spawn B
```

Team Task 被 Cancel：

```text
Task Cancel
    ↓
Cancel owned spawn A
Cancel owned spawn B
    ↓
Cancel member run
```

因此 SubAgentManager 增加：

```ts
cancelOwnedBy(
  owner: SpawnOwner
): void
```

---

# 64. Team Tool API

Main Agent 建议增加：

```text
team_list
team_status
team_delegate
team_wait
team_send
team_inbox
```

Team 创建/编辑第一版可以由 UI/配置完成。

不要一开始给模型增加十几个管理工具。

---

# 65. team_list

```ts
{
  workspace?: string
}
```

返回：

```json
{
  "teams": [
    {
      "id": "engineering",
      "name": "Engineering Team",
      "members": [
        {
          "id": "architect",
          "state": "idle"
        }
      ]
    }
  ]
}
```

---

# 66. team_status

```ts
{
  teamId: string
}
```

返回：

```text
members
active tasks
queued tasks
unread inbox count
recent results
```

---

# 67. team_delegate

```ts
{
  teamId: string;

  memberId: string;

  task: string;

  timeoutMs?: number;

  outputSchema?: object;
}
```

立即返回：

```json
{
  "taskId": "tt_xxx",
  "state": "queued"
}
```

与：

```text
sub_agent_start
```

一样，默认异步。

---

# 68. team_wait

```ts
{
  taskIds: string[];

  timeoutMs?: number;
}
```

和：

```text
sub_agent_wait
```

行为一致。

---

# 69. team_send

用途：

```text
给某成员发一条持久消息
```

```ts
{
  teamId: string;

  memberId: string;

  message: string;

  kind?:
    | 'note'
    | 'question';
}
```

不触发 Agent Run。

---

# 70. team_inbox

Main Agent：

```text
读取 Team Inbox / Member Message
```

Team Member：

```text
读取自己 Inbox
```

同一个 Tool 可以根据：

```text
RuntimeActor
```

决定视图。

---

# 71. 为什么不做 team_broadcast V1

模型完全可以：

```text
team_send architect
team_send developer
team_send reviewer
```

先避免：

```text
broadcast
auto wake
fan-out
```

防止工具语义过快膨胀。

---

# 72. Team Definition 保存位置

建议 Team Definition 本身先存 SQLite。

不要第一版同时实现：

```text
~/.jojo/teams/*.yaml
.jojo/teams/*.yaml
SQLite
```

三套来源。

先：

```text
SQLite
```

稳定 Schema。

之后再加：

```text
TeamDefinitionRegistry
```

支持：

```text
builtin
extension
user
project
```

类似 AgentProfileRegistry。

---

# 73. Workspace Identity

Team 不能只保存：

```text
/path/to/project
```

推荐使用现有：

```text
ProjectIdentity
```

或者稳定 Workspace Key：

```text
canonical path
+
repository identity
```

最终：

```text
Team belongs to ProjectIdentity
```

而不是某一个聊天 Session。

---

# 74. Memory

Team Member 有两层记忆：

```text
Runtime Lane Transcript
+
Jojo Memory Runtime
```

Lane 负责：

```text
这个 teammate 自己以前做过什么
```

Memory Runtime 负责：

```text
项目长期知识
```

---

# 75. TeamMemberMemoryBinding

增加：

```ts
export type TeamMemberMemoryBinding = {
  projectIdentity?: ProjectIdentity;

  teamId: string;

  memberId: string;

  memorySnapshotId: string;

  mode:
    | 'project-minimal'
    | 'none';
};
```

---

# 76. 为什么不直接复用 SubAgentMemoryBinding

虽然字段很像，但语义不同。

SubAgent：

```text
child snapshot
```

是一次临时派生。

Team Member：

```text
persistent identity
```

不应该伪装成 Child Sub-Agent。

---

# 77. Team Member Memory 更新

第一阶段：

```text
Team Member Runtime Lane
```

承担成员历史。

无需每轮自动向长期 Memory 写大量内容。

只在：

- 明确 memory candidate；
- 用户确认；
- 现有自动 Memory pipeline；

中进入长期 Memory。

避免 Team Member 自己不断污染全局记忆。

---

# 78. Worktree 与 Persistent Team

这是 Team 中需要特别处理的一点。

不要让：

```text
Developer Member
```

创建 Team 时就永久占一个 Git Worktree。

否则：

```text
Team 长期存在
→ Worktree 长期存在
→ Branch 长期漂移
```

非常难维护。

---

# 79. 正确模型

Team Member：

```text
Persistent Context
```

但 Worktree：

```text
Task Scoped
```

---

# 80. Read-only Team Task

直接：

```text
workspace
```

执行。

---

# 81. Writable Team Task

如果：

```text
profile=general
```

则：

```text
Task
 ↓
create worktree
 ↓
run member
 ↓
produce diff
 ↓
retain reviewable changes
```

与现有 general Sub-Agent 一致。

---

# 82. 一个重要限制

如果 Writable Task 完成后 Worktree 有未合并修改：

下一次该 Member 的普通任务不能假设：

```text
这些修改已经进入主 Workspace
```

因此 TeamTask Result 必须明确返回：

```text
isolation
branch
changedFiles
diffStat
```

和现在 SubAgentSnapshot 保持一致。

---

# 83. M2 可做 Persistent Workspace

未来如果确实需要：

```text
developer
连续多轮在自己的分支开发
```

可以实现：

```text
TeamWorkspaceManager
```

提供：

```text
persistent member worktree
```

但不放进 Spawn/Team M1。

---

# 84. Permission Governance

最新代码已经支持：

```text
GovernanceRuntimePermissionGate
```

Team 必须直接复用。

---

# 85. Team Member Governance Context

例如：

```ts
{
  actor: {
    kind: 'team_member',
    id: 'architect',
    profile: 'explore'
  },

  team: {
    id: 'engineering',
    memberId: 'architect',
    taskId: 'tt_xxx'
  }
}
```

---

# 86. Governance Rule 可以匹配 Team

后续 Permission Policy：

```yaml
- id: allow-reviewer-read
  effect: allow

  match:
    actors:
      - team_member

    team:
      id: engineering
      member: reviewer

    operations:
      - read
```

---

# 87. Team 不能绕过 Permission

错误：

```text
Persistent Teammate
=
Trusted
=
Allow Everything
```

必须仍然：

```text
Tool
 ↓
Domain Security
 ↓
Permission Governance
 ↓
Sandbox
```

---

# 88. AUTO / YOLO

Team Member 也继承：

```text
ASK
AUTO
YOLO
```

但可以额外配置：

```text
team-member policy
```

用于限制无人值守行为。

例如：

```text
Team Member
+
Scheduler Trigger
```

默认不能：

```text
secret + network
```

自动执行。

---

# 89. Approval

Team Task 遇到 ASK：

```text
running
 ↓
waiting_approval
```

TeamTask Store：

```text
status = waiting_approval
```

Approval Broker 完成后：

```text
running
```

继续。

这样以后 Team 可以直接服务：

```text
Daemon
Scheduler
Automation
```

---

# 90. Hooks

新增 Hooks 可以先不做。

现有：

```text
SubagentStop
```

不要硬套给 Team Member。

M1 先增加事件：

```text
TeamTaskStarted
TeamTaskFinished
```

如果 Hooks 架构已经稳定，再扩展正式 Hook Schema。

---

# 91. OrchestrationEvent

增加：

```ts
type OrchestrationEvent =
  | ...
  | {
      type: 'team.changed';
      team: TeamSnapshot;
    }
  | {
      type: 'team.member.changed';
      teamId: string;
      member: TeamMemberSnapshot;
    }
  | {
      type: 'team.task.changed';
      task: TeamTaskSnapshot;
    }
  | {
      type: 'team.message.created';
      message: TeamMessageSnapshot;
    };
```

---

# 92. Desktop UI

左侧或右侧增加：

```text
Team
```

面板：

```text
Engineering Team

● Architect
  idle

● Developer
  running
  Refactor auth module

● Reviewer
  idle
```

---

# 93. Team Member Detail

点击 Member：

```text
Profile
Model
Current Task
Recent Tasks
Unread Messages
Runtime Transcript
Spawned Workers
Usage
```

---

# 94. Spawn UI

现有 Sub-Agent UI 可以保留。

逐渐把文案：

```text
Sub-Agent
```

调整为：

```text
Workers
```

或者：

```text
Spawned Agents
```

Team Member 单独显示。

---

# 95. 不要把 Team 与 Workflow 混在一起

Workflow：

```text
预定义 DAG
```

Team：

```text
长期 Agent Identity
```

Spawn：

```text
动态临时委派
```

三者分别解决不同问题。

---

# 96. 三者关系

```text
             Orchestration
                   │
       ┌───────────┼───────────┐
       │           │           │
       ▼           ▼           ▼
     Spawn        Team      Workflow
       │           │           │
 temporary     persistent   predefined
 dynamic       identities      DAG
```

---

# 97. Team 可以启动 Workflow 吗

M1：

```text
NO
```

普通 Team Member 不暴露：

```text
workflow_start
```

避免：

```text
Team
  ↓
Workflow
  ↓
Agents
```

造成层级与 Budget 难以管理。

---

# 98. Main Agent 仍然可以

```text
Main
 ├─ team_delegate
 ├─ sub_agent_start
 └─ workflow_start
```

由 Main 选择：

```text
临时问题 → Spawn

长期专家 → Team

复杂确定流程 → Workflow
```

---

# 99. Team Member 可以 Spawn

推荐支持：

```text
Main
  ↓
Team Architect
  ↓
Spawn Explore
```

这是非常实用的两层结构。

---

# 100. Team Member 不可以创建 Team

保持：

```text
Team Structure
```

属于 Control Plane。

---

# 101. Team Recovery

Worker/App 启动：

```text
TeamManager.initialize()
```

读取：

```text
teams
members
queued tasks
running tasks
```

---

# 102. Crash Recovery

如果数据库里：

```text
task.status = running
```

启动时检查：

```text
runtime_run_id
```

通过：

```text
AgentRuntime.inspectRun()
```

判断。

---

# 103. 已完成 Runtime Run

如果：

```text
runtime completed
```

恢复：

```text
TeamTask → completed
```

---

# 104. Running Operation 可 Resume

如果 Runtime Operation：

```text
recoverable
```

则使用现有：

```text
resumeOperation()
```

恢复。

---

# 105. 无法恢复

标记：

```text
interrupted
```

不要静默重新执行任务。

否则带 Side Effect 的 Team Task 可能：

```text
执行两遍
```

---

# 106. Inbox Recovery

Inbox 本来就是 SQLite：

```text
unread
```

因此天然恢复。

---

# 107. Spawn 是否需要持久化

M1：

```text
Spawn = Ephemeral
```

不要求 App 重启后恢复。

这是 Spawn 与 Team 一个重要区别。

---

# 108. 但 Runtime Lane 可以保留

即使 SpawnManager 丢失：

```text
agent:sa_xxx
```

Lane Transcript 可以继续存在于 Runtime Store。

未来可以实现：

```text
Durable Spawn Recovery
```

但不阻塞 Team M1。

---

# 109. Team Error Codes

新增：

```ts
TeamErrorCodeSchema = z.enum([
  'team_not_found',
  'team_exists',
  'team_member_not_found',
  'team_member_disabled',
  'team_member_busy',
  'team_task_not_found',
  'team_task_cancelled',
  'team_runtime_failed',
  'team_store_failed',
  'team_message_not_found',
  'team_concurrency_limit'
]);
```

---

# 110. Spawn Error 扩展

建议增加：

```text
spawn_owner_cancelled
spawn_limit_reached
spawn_profile_not_allowed
```

逐渐淡化：

```text
nested_subagent_forbidden
```

这个 Coding Agent 导向的名称。

---

# 111. Package 目录

建议：

```text
packages/orchestration/src/
├── spawn/
│   ├── manager.ts
│   ├── types.ts
│   ├── tools.ts
│   ├── ownership.ts
│   └── policy.ts
│
├── team/
│   ├── manager.ts
│   ├── types.ts
│   ├── store.ts
│   ├── tools.ts
│   ├── inbox.ts
│   ├── prompt.ts
│   ├── recovery.ts
│   └── effective-config.ts
│
├── agent/
│   ├── runner.ts
│   └── types.ts
│
├── workflow/
│
└── isolation/
```

---

# 112. 不建议立即移动现有 subagent/

为了降低 Diff：

M1 先：

```text
subagent/
team/
```

等 Team 完成之后：

```text
subagent/
```

再逐渐 rename：

```text
spawn/
```

不要在一个 PR 同时：

```text
rename 全目录
+
修改行为
+
新增 Team
```

非常难 Review。

---

# 113. Contracts 修改

`packages/contracts/src/orchestration.ts`

增加：

```text
TeamDefinitionSchema
TeamMemberDefinitionSchema
TeamSnapshotSchema
TeamMemberSnapshotSchema
TeamTaskSnapshotSchema
TeamMessageSchema
TeamMemberMemoryBindingSchema
```

---

# 114. Agent Runtime 修改

`packages/agent-runtime/src/public/run.ts`

修改：

```text
RuntimeActor
```

增加：

```text
team_member
```

并新增：

```text
RuntimeTeamContext
```

---

# 115. Runtime Core

把：

```text
request.team
```

写进：

```text
RuntimeResolutionContext
```

并传递到：

```text
permissions
tools
hooks
telemetry
runContext
```

---

# 116. Permission Governance 修改

Governance Context 增加：

```ts
team?: {
  id: string;
  memberId: string;
  taskId?: string;
};
```

Policy Matcher 后续支持：

```text
team
member
```

---

# 117. Desktop Composition

当前：

```text
SubAgentManager
WorkflowManager
```

旁边增加：

```text
TeamManager
```

共享：

```text
AgentExecutionScheduler
ResourceGroupLimiter
ProviderSemaphore
AgentProfileRegistry
OrchestratedAgentRunner
Permission Governance
Memory Runtime
```

---

# 118. Composition 最终形态

```ts
const agentRunner =
  createDesktopOrchestratedAgentRunner({
    runtimeService,
    profileRegistry,
    governance,
    memoryRuntime,
    ...
  });

const subAgentManager =
  new SubAgentManager(
    createLeafAgentAdapter(agentRunner),
    executionScheduler,
    emit,
    ...
  );

const teamManager =
  new TeamManager({
    runner: agentRunner,
    store: teamStore,
    scheduler: executionScheduler,
    providers: providerSemaphore,
    resourceGroups,
    profileRegistry,
    emit
  });
```

---

# 119. Tools Composition

Main Agent：

```ts
[
  ...nativeTools,

  ...memoryTools,

  ...browserTools,

  ...subAgentTools,

  ...teamTools,

  ...workflowTools
]
```

---

# 120. Team Member Tool Snapshot

Team Member：

```ts
[
  ...profileNativeTools,

  teamInboxTool,

  teamSendTool,

  ...(spawnPolicy.enabled
      ? spawnTools
      : [])
]
```

不要默认加入：

```text
workflow
team management
browser
MCP
```

除非 Profile/Policy 明确允许。

---

# 121. Tool Policy

现有：

```text
resolveAgentToolPolicy()
```

应继续作为：

```text
Capability Boundary
```

流程：

```text
Available Tools
      ↓
Profile allow/deny
      ↓
Member allow/deny
      ↓
Spawn policy
      ↓
Effective Tools
      ↓
Permission Governance
```

---

# 122. Resource Limits

默认建议：

```text
Global agent concurrency = 4

Max active spawn/session = 8

Team max concurrency = 3

Member concurrency = 1

Member spawn max active = 2
```

全部可配置。

---

# 123. Budget

TeamTask 后续增加：

```ts
budget?: {
  maxIterations?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
};
```

M1 可先复用：

```text
maxIterations
```

---

# 124. Team Usage

TeamTask 完成后关联：

```text
Runtime Usage
```

Team Status 可以汇总：

```text
today
session
team total
member total
```

但不要复制所有 token event 到 Team DB。

Runtime Usage Store 仍为 source of truth。

---

# 125. Team 与 Scheduler

这套架构完成后：

```text
Scheduler
   ↓
team_delegate
```

就天然成立。

例如：

```text
Every morning
   ↓
delegate researcher
   ↓
Research overnight changes
```

不需要 Scheduler 再实现 Agent 生命周期。

---

# 126. Team 与 Daemon

未来：

```text
jojo serve
```

启动：

```text
TeamManager
```

Team 存在于 Runtime/SQLite。

Desktop 只是：

```text
Control Plane
```

这非常符合后续通用 Agent 架构。

---

# 127. 开发阶段

## PR 1 — Runner Generalization

完成：

```text
OrchestratedAgentRunner
```

并：

```text
LeafAgentRunner
→ Adapter
```

同时去除新的设计对：

```text
continuationId
```

的依赖。

验收：

- 原有 Sub-Agent 全部测试不变；
- `sub_agent_send` 继续工作；
- 同 Lane 多轮上下文保持。

---

# 128. PR 2 — Runtime Team Context

增加：

```text
RuntimeActor.team_member
RuntimeTeamContext
```

贯穿：

```text
RuntimeResolutionContext
Permission Governance
Telemetry
```

但暂时不创建 Team。

---

# 129. PR 3 — Team Contracts + Store

实现：

```text
Team schemas
TeamStore
SqliteTeamStore
```

只做 CRUD 与 Inbox。

---

# 130. PR 4 — TeamManager

实现：

```text
team
member
delegate
wait
cancel
recovery
```

并跑：

```text
persistent member lane
```

---

# 131. PR 5 — Team Tools

增加：

```text
team_list
team_status
team_delegate
team_wait
team_send
team_inbox
```

---

# 132. PR 6 — Team Member Spawn

让 Team Member 可以获得：

```text
spawn tools
```

同时：

```text
spawn owner
cancel propagation
maxActive
profile allowlist
```

落地。

---

# 133. PR 7 — UI

Team：

```text
create/edit
member state
task history
inbox
usage
```

---

# 134. PR 8 — Recovery / Daemon Readiness

完善：

```text
running task reconciliation
Runtime resumeOperation
approval recovery
interrupted state
```

---

# 135. 测试

新增：

```text
packages/orchestration/test/team/
```

至少：

```text
team-manager.test.ts

team-store.test.ts

team-delegate.test.ts

team-inbox.test.ts

team-concurrency.test.ts

team-recovery.test.ts

team-spawn.test.ts

team-cancel-propagation.test.ts
```

---

# 136. Spawn 回归测试

必须继续通过：

```text
start
wait
status
cancel
send
close
worktree
structured output
resource group
provider semaphore
timeout
usage
memory binding
hooks
```

---

# 137. Team Context Persistence Test

流程：

```text
delegate architect:
"Remember architecture uses EventStore."

↓ complete

destroy TeamManager

↓ recreate

delegate architect:
"What storage did we decide?"

↓
must have previous lane context
```

这是 Team 最关键测试之一。

---

# 138. Inbox Persistence Test

```text
send message

↓
restart

↓
team_inbox

must return unread message
```

---

# 139. Member Serialization Test

同时：

```text
delegate architect A
delegate architect B
```

必须：

```text
A running
B queued
```

而不是并行同 Lane。

---

# 140. Cross-member Parallel Test

```text
architect A
developer B
```

允许并行。

---

# 141. Permission Test

Team Member：

```text
terminal network=host
```

必须仍然进入：

```text
Governance
```

不能因为 Team Member 是 Persistent Identity 就跳过审批。

---

# 142. Spawn Ownership Test

```text
architect
   ↓
spawn explore
```

Cancel Architect Task：

```text
owned spawn
```

必须一起 Cancel。

---

# 143. Recovery Safety Test

Runtime 重启时：

```text
TeamTask = running
```

如果无法确认 Run 是否安全恢复：

```text
interrupted
```

不能直接重新执行。

---

# 144. M1 验收标准

Spawn：

- [ ] 现有 Sub-Agent 行为完全兼容。
- [ ] Continuation 逐步转为 Lane-based。
- [ ] Spawn 有明确 Owner。
- [ ] Main 可以 Spawn。
- [ ] Team Member 可以 Spawn Leaf Worker。
- [ ] Spawn Cancel 可以按 Owner 传播。

Team：

- [ ] Team 持久化。
- [ ] Member 持久化。
- [ ] 每个 Member 有稳定 Runtime Lane。
- [ ] App 重启后 Member Context 仍存在。
- [ ] Inbox 持久化。
- [ ] TeamTask 持久化。
- [ ] 同 Member Task 串行。
- [ ] 不同 Member 可并行。
- [ ] Team 使用现有 Profile Registry。
- [ ] Team 使用现有 Permission Governance。
- [ ] Team 使用现有 Agent Scheduler。
- [ ] Team 使用现有 Provider Semaphore。
- [ ] Writable Task 使用 Worktree。
- [ ] Team Member 默认不能修改 Team。
- [ ] Team Member 默认不能启动 Workflow。
- [ ] Peer Message 默认不会自动唤醒对方。

---

# 145. 最终形态

```text
                       Jojo Agent
                           │
                           ▼
                     Main Agent
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
        Spawn             Team          Workflow
          │                │                │
          │          ┌─────┼─────┐          │
          │          ▼     ▼     ▼          │
          │         A     B     C           │
          │          │                       │
          │          └──── Spawn             │
          │                                  │
          └────────────────┬─────────────────┘
                           ▼
                 OrchestratedAgentRunner
                           │
                           ▼
                     AgentRuntime
                           │
              ┌────────────┼─────────────┐
              ▼            ▼             ▼
          Spawn Lane    Team Lane    Workflow Lane
                           │
                           ▼
                 Permission Governance
                           │
                           ▼
                     Tool Runtime
                           │
                           ▼
                  Sandbox / MCP / Browser
```

---

# 146. 核心结论

Jojo 目前已经拥有：

```text
SubAgent
Agent Runtime Lane
Profile
Scheduler
Worktree
Memory Binding
Workflow
Permission Governance
```

因此 Spawn/Team 不应该开发成：

```text
第三套 Agent Engine
```

最合理的演进路径是：

```text
SubAgent
   ↓
Spawn Primitive
```

以及：

```text
Persistent Runtime Lane
   +
Team Identity
   +
Durable Inbox
   +
Durable Task Store
   ↓
Persistent Team Member
```

其中最关键的一次底层重构是：

> **把“Agent 是否可以继续运行”的身份从内存 `continuationId` 转移到持久化的 Runtime Lane。**

完成这一点后：

```text
Spawn
Team
Daemon
Scheduler
Automation
```

都会共享同一个 Agent Runtime 模型。

最终 Jojo 的多 Agent 能力应该明确分成三种：

```text
Spawn
=
动态、临时、一次性并行 Worker

Team
=
长期、有身份、有上下文、有 Inbox 的 Teammate

Workflow
=
声明式、可恢复、确定性的 DAG
```

这三个 Primitive 共同组成 Jojo 面向通用 Agent 的 Orchestration Layer。
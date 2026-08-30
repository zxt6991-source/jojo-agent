# Jojo Agent Durable Scheduler 具体实现设计

> 建议文件：`docs/Jojo-Agent-Scheduler.md`  
> 基线：`main@97f9dd13287cf4fdf62377cfa0f856dda9c003d2`  
> 状态：Implementation Design  
> 目标：在现有 AgentRuntime、Permission Governance、Persistent Team、Workflow、Headless Server 基础上，实现持久化、可恢复、Daemon-ready 的时间调度能力。

---

# 1. 背景

Jojo 当前已经具备：

```text
AgentRuntime
├── Session
├── Lane
├── Run
├── RuntimeActor
├── Permission Governance
├── Approval
└── Runtime Recovery

Orchestration
├── Spawn
├── Persistent Team
├── Workflow DAG
├── AgentExecutionScheduler
├── ProviderSemaphore
└── ResourceGroupLimiter

Server
├── JojoAppService
├── Durable Run Store
├── Durable Approval Store
├── RecoveryCoordinator
├── Headless Server
├── REST / WebSocket
└── Idempotency
```

因此，现在已经具备实现真正 Scheduler 的基础条件。

---

# 2. 首先明确：当前已有的 Scheduler 不是本设计的 Scheduler

当前：

```text
packages/orchestration/src/subagent/scheduler.ts
```

中的：

```ts
AgentExecutionScheduler
```

本质是：

```text
Concurrency Semaphore
```

负责：

```text
最多同时运行 N 个 Agent
```

它解决的是：

```text
HOW MANY
```

本设计中的 Scheduler 解决：

```text
WHEN
```

即：

```text
什么时候创建新的 Agent / Workflow / Team Task
```

因此不要：

```text
扩展 AgentExecutionScheduler
```

去实现 Cron。

两者应长期并存：

```text
Durable Scheduler
      │
      ▼
创建 Target Execution
      │
      ▼
AgentExecutionScheduler
      │
      ▼
控制实际并发
```

---

# 3. Scheduler 的定位

Scheduler 应该是：

```text
Execution Trigger Layer
```

而不是 Agent Engine。

最终生命周期：

```text
              Time
               │
               ▼
          Schedule Engine
               │
               ▼
         Schedule Run
               │
               ▼
       Target Dispatcher
         /      |      \
        /       |       \
       ▼        ▼        ▼
    Agent    Workflow   Team Member
      │          │          │
      └──────────┼──────────┘
                 ▼
          Existing Runtime
                 │
                 ▼
       Permission Governance
                 │
                 ▼
        Tool / Sandbox / MCP
```

Scheduler 永远不能：

```text
Scheduler
   ↓
terminal.execute()
```

也不能：

```text
Scheduler
   ↓
MCP Tool
```

只能：

```text
Scheduler
   ↓
Agent / Workflow / Team Task
```

---

# 4. 核心原则

## 4.1 Schedule 与 ScheduleRun 必须分离

Schedule 表示：

```text
规则
```

例如：

```text
每天 08:00
```

ScheduleRun 表示：

```text
2026-08-31 08:00
这一具体执行实例
```

关系：

```text
Schedule
   │
   ├── ScheduleRun 1
   ├── ScheduleRun 2
   ├── ScheduleRun 3
   └── ...
```

绝对不要把：

```text
lastResult
running
error
```

直接作为 Schedule 的核心运行状态。

---

# 5. 不新增全局 Job 系统

以前可以考虑：

```text
Scheduler
  ↓
Job
  ↓
Agent / Workflow
```

但最新代码已经存在三个成熟执行模型：

```text
Agent Run
Workflow Run
Team Task
```

现在再增加：

```text
Generic Job Runtime
```

会形成第四套生命周期。

因此 M1 不建议。

正确模型：

```text
ScheduleRun
    │
    ├── targetKind = agent
    │      └── Agent Run
    │
    ├── targetKind = workflow
    │      └── Workflow Run
    │
    └── targetKind = team_member
           └── Team Task
```

`ScheduleRun` 只负责：

```text
为什么执行
原计划什么时候执行
谁触发
对应哪个底层 Execution
最终状态是什么
```

不复制底层 Agent Runtime。

---

# 6. 新 Package

建议新增：

```text
packages/scheduler/
```

不要放：

```text
packages/orchestration/src/scheduler/
```

避免与：

```text
AgentExecutionScheduler
```

混淆。

目录：

```text
packages/scheduler/
├── package.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   │
│   ├── engine.ts
│   ├── service.ts
│   ├── store.ts
│   ├── calculator.ts
│   ├── recovery.ts
│   │
│   ├── dispatch/
│   │   ├── dispatcher.ts
│   │   ├── registry.ts
│   │   ├── agent.ts
│   │   ├── workflow.ts
│   │   └── team-member.ts
│   │
│   ├── policy/
│   │   ├── misfire.ts
│   │   └── concurrency.ts
│   │
│   └── events.ts
│
└── test/
    ├── calculator.test.ts
    ├── engine.test.ts
    ├── service.test.ts
    ├── recovery.test.ts
    ├── misfire.test.ts
    ├── concurrency.test.ts
    └── dispatch.test.ts
```

---

# 7. 核心数据类型

## 7.1 ScheduleSpec

```ts
export type ScheduleSpec =
  | {
      kind: 'once';

      /**
       * RFC3339 absolute time.
       */
      runAt: string;
    }

  | {
      kind: 'interval';

      /**
       * Fixed UTC duration.
       * M1 minimum: 60 seconds.
       */
      intervalMs: number;

      /**
       * Stable anchor used to avoid drift.
       */
      anchorAt: string;
    }

  | {
      kind: 'cron';

      /**
       * M1: standard 5-field cron.
       */
      expression: string;

      /**
       * IANA timezone.
       *
       * e.g.
       * Asia/Shanghai
       * America/Los_Angeles
       */
      timezone: string;
    };
```

---

# 8. 为什么 Cron 必须保存 Timezone

不能只保存：

```text
0 8 * * *
```

因为：

```text
08:00
```

到底是哪一个时区？

Scheduler Host 从：

```text
西安机器
```

迁移到：

```text
美国服务器
```

后不应该改变行为。

因此必须：

```yaml
schedule:
  kind: cron
  expression: "0 8 * * *"
  timezone: "Asia/Shanghai"
```

数据库内部：

```text
next_run_at
```

统一保存 UTC Timestamp。

---

# 9. Cron 计算

推荐使用成熟 Parser：

```text
cron-parser
```

但只让它负责：

```text
parse
validate
next()
```

不要使用第三方 Cron Library 自己管理：

```text
timer
job lifecycle
persistence
retry
```

即：

```text
cron-parser
    ↓
NextOccurrenceCalculator
```

真正调度：

```text
Jojo DurableScheduleEngine
```

自己掌握。

---

# 10. ScheduleTarget

M1 定义三个正式 Target：

```ts
export type ScheduleTarget =
  | AgentScheduleTarget
  | WorkflowScheduleTarget
  | TeamMemberScheduleTarget;
```

---

# 11. Agent Target

```ts
export type AgentScheduleTarget = {
  kind: 'agent';

  /**
   * M1 绑定已有 Session。
   *
   * 这样审批、Workspace、
   * Provider 环境以及远程控制均可复用
   * 现有 Jojo Session 模型。
   */
  sessionId: string;

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

  /**
   * M1 默认使用 Scheduler 独立 Lane，
   * 不污染用户 main transcript。
   */
  lane?: {
    mode: 'dedicated' | 'main';
    id?: string;
  };
};
```

---

# 12. Agent 默认使用独立 Lane

例如 Schedule：

```text
sch_daily_review
```

默认 Lane：

```text
schedule:sch_daily_review
```

Runtime：

```text
Session ABC
│
├── main
│
├── agent:...
│
└── schedule:sch_daily_review
```

好处：

### 不污染用户主聊天

定时任务不会每天往：

```text
main
```

里塞一轮对话。

### 保留 Scheduler 上下文

每天运行：

```text
检查代码库今天有什么变化
```

可以读取前一天自己的 Lane History。

### 不和主聊天抢 Lane

主聊天：

```text
main
```

仍然可以运行。

---

# 13. Agent Schedule Context

默认：

```text
contextMode = persistent
```

即：

```text
同一个 Schedule
    ↓
同一个 Lane
```

M2 可以增加：

```text
contextMode = fresh
```

每次生成：

```text
schedule:<scheduleId>:<runId>
```

但 M1 暂不增加。

---

# 14. Workflow Target

```ts
export type WorkflowScheduleTarget = {
  kind: 'workflow';

  sessionId: string;

  workingDirectory: string;

  providerId: string;

  model: string;

  workflow:
    | {
        kind: 'saved';
        name: string;
        args?: Record<string, unknown>;
      }

    | {
        kind: 'inline';
        definition: unknown;
        args?: Record<string, unknown>;
      };
};
```

直接适配：

```ts
WorkflowManager.start()
```

现有：

```text
Persistence
Resume
DAG
Retry
Budget
Resource Groups
```

全部继续使用。

Scheduler 不参与 Workflow Step 调度。

---

# 15. Team Member Target

```ts
export type TeamMemberScheduleTarget = {
  kind: 'team_member';

  teamId: string;

  memberId: string;

  task: string;

  /**
   * 用于 trace / audit。
   */
  parentSessionId: string;

  providerId?: string;

  model?: string;

  timeoutMs?: number;

  maxIterations?: number;

  outputSchema?: Record<string, unknown>;
};
```

直接：

```text
Schedule
   ↓
TeamManager.delegate()
```

TeamManager 自己负责：

```text
member serialization
team maxConcurrency
provider semaphore
global agent scheduler
worktree
waiting approval
inbox
runtime lane
```

Scheduler 不重复这些逻辑。

---

# 16. Schedule

```ts
export type Schedule = {
  id: string;

  name: string;

  description?: string;

  enabled: boolean;

  spec: ScheduleSpec;

  target: ScheduleTarget;

  misfire: MisfirePolicy;

  concurrency: ScheduleConcurrencyPolicy;

  nextRunAt?: string;

  lastRunAt?: string;

  revision: number;

  createdBy: string;

  createdAt: string;

  updatedAt: string;

  deletedAt?: string;
};
```

---

# 17. MisfirePolicy

```ts
export type MisfirePolicy =
  | {
      kind: 'skip';
    }

  | {
      kind: 'fire_once';

      graceMs: number;
    };
```

---

# 18. 什么是 Misfire

例如：

```text
Schedule：

每天 08:00

程序：

07:30 停止
09:00 启动
```

08:00 已经错过。

怎么办？

---

# 19. skip

```text
08:00 missed
   ↓
SKIPPED
   ↓
next = 明天 08:00
```

适合：

```text
每小时状态检查
```

---

# 20. fire_once

例如：

```text
grace = 24h
```

09:00 启动：

```text
08:00 missed by 1h
       ↓
立即补跑一次
```

但是：

```text
不会把昨天所有小时任务
全部重新执行一遍
```

---

# 21. M1 默认 Misfire

建议：

```ts
{
  kind: 'fire_once',
  graceMs: 24 * 60 * 60 * 1000
}
```

用户体验更符合：

```text
“电脑刚刚关机了，
开机后把今天的日报补一下。”
```

---

# 22. 禁止 Misfire Replay Storm

假设：

```text
每 5 分钟执行
```

程序停了两天。

不能：

```text
启动
 ↓
补跑 576 次
```

M1 永远：

```text
最多补跑一次
```

然后：

```text
next_run_at
```

跳到：

```text
now 之后的第一个正常时间点
```

---

# 23. ScheduleConcurrencyPolicy

```ts
export type ScheduleConcurrencyPolicy =
  | 'skip'
  | 'queue'
  | 'allow';
```

---

# 24. skip

如果上一轮仍然：

```text
running
waiting_approval
dispatching
```

新 occurrence：

```text
SKIPPED
reason = overlap
```

推荐默认：

```text
skip
```

---

# 25. queue

新 occurrence：

```text
pending
```

直到前一轮结束。

但 M1 应增加：

```text
maxQueuedOccurrences = 1
```

避免：

```text
任务卡住 3 天
   ↓
队列积累 100 个执行
```

后续 occurrence 直接：

```text
skipped
reason = queue_coalesced
```

---

# 26. allow

允许同一 Schedule 多个 Run 同时执行。

但需要注意：

### Agent Dedicated Lane

同 Lane 的 Runtime：

```text
concurrency = 1
```

所以 Agent Target M1：

```text
allow
```

应拒绝配置。

只允许：

```text
skip
queue
```

### Workflow

可以：

```text
allow
```

由 WorkflowManager 自身的：

```text
maxPerSession
```

继续限制。

### Team Member

同一个 Member 已经：

```text
member concurrency = 1
```

因此 Scheduler `allow` 最终仍会进入 Team Queue。

推荐 Team 默认：

```text
skip
```

---

# 27. ScheduleRun

```ts
export type ScheduleRunStatus =
  | 'pending'
  | 'dispatching'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'interrupted';
```

---

# 28. ScheduleRun 模型

```ts
export type ScheduleRun = {
  id: string;

  scheduleId: string;

  /**
   * 唯一 occurrence identity。
   */
  occurrenceKey: string;

  scheduledFor: string;

  trigger:
    | 'timer'
    | 'misfire'
    | 'manual';

  status: ScheduleRunStatus;

  targetKind:
    | 'agent'
    | 'workflow'
    | 'team_member';

  /**
   * 对应：
   *
   * Agent Run ID
   * Workflow Run ID
   * Team Task ID
   */
  targetExecutionId?: string;

  claimedBy?: string;

  claimExpiresAt?: string;

  createdAt: string;

  startedAt?: string;

  finishedAt?: string;

  errorCode?: string;

  error?: string;

  resultPreview?: string;

  targetSnapshot: ScheduleTarget;
};
```

---

# 29. occurrenceKey

Timer：

```text
timer:<scheduledForEpochMs>
```

例如：

```text
timer:1788144000000
```

Manual：

```text
manual:<uuid>
```

数据库：

```text
UNIQUE(schedule_id, occurrence_key)
```

---

# 30. 为什么 occurrenceKey 非常关键

发生：

```text
Timer fire
   ↓
DB 写入成功
   ↓
进程 crash
   ↓
restart
```

Scheduler 再次看到：

```text
nextRunAt <= now
```

时不能重新创建第二条。

Unique Key 保证：

```text
同一个逻辑时间点
最多创建一个 ScheduleRun
```

---

# 31. Storage

新增：

```text
packages/storage/src/sqlite-schedule-store.ts
```

数据库：

```text
<dataDir>/runtime/scheduler.sqlite
```

或者 Headless：

```text
<dataDir>/scheduler.sqlite
```

建议统一：

```text
<dataDir>/runtime/scheduler.sqlite
```

---

# 32. schedules 表

```sql
CREATE TABLE schedules (
    id TEXT PRIMARY KEY,

    name TEXT NOT NULL,

    description TEXT,

    enabled INTEGER NOT NULL,

    schedule_kind TEXT NOT NULL,

    schedule_json TEXT NOT NULL,

    target_kind TEXT NOT NULL,

    target_json TEXT NOT NULL,

    misfire_json TEXT NOT NULL,

    concurrency_policy TEXT NOT NULL,

    next_run_at INTEGER,

    last_run_at INTEGER,

    revision INTEGER NOT NULL,

    created_by TEXT NOT NULL,

    created_at INTEGER NOT NULL,

    updated_at INTEGER NOT NULL,

    deleted_at INTEGER
);
```

索引：

```sql
CREATE INDEX idx_schedules_due
ON schedules(
    enabled,
    next_run_at
);
```

---

# 33. schedule_runs 表

```sql
CREATE TABLE schedule_runs (
    id TEXT PRIMARY KEY,

    schedule_id TEXT NOT NULL,

    occurrence_key TEXT NOT NULL,

    scheduled_for INTEGER NOT NULL,

    trigger_kind TEXT NOT NULL,

    status TEXT NOT NULL,

    target_kind TEXT NOT NULL,

    target_execution_id TEXT,

    target_snapshot_json TEXT NOT NULL,

    claimed_by TEXT,

    claim_expires_at INTEGER,

    created_at INTEGER NOT NULL,

    started_at INTEGER,

    finished_at INTEGER,

    error_code TEXT,

    error TEXT,

    result_preview TEXT,

    version INTEGER NOT NULL,

    UNIQUE(
      schedule_id,
      occurrence_key
    )
);
```

索引：

```sql
CREATE INDEX idx_schedule_runs_active
ON schedule_runs(
    schedule_id,
    status
);
```

```sql
CREATE INDEX idx_schedule_runs_recovery
ON schedule_runs(
    status,
    claim_expires_at
);
```

---

# 34. ScheduleStore

```ts
export interface ScheduleStore {

  create(
    schedule: Schedule
  ): Promise<Schedule>;

  get(
    id: string
  ): Promise<Schedule | undefined>;

  list(
    options?: {
      includeDeleted?: boolean;
    }
  ): Promise<Schedule[]>;

  update(
    schedule: Schedule,
    expectedRevision?: number
  ): Promise<Schedule>;

  softDelete(
    id: string
  ): Promise<void>;

  listDue(
    now: number,
    limit: number
  ): Promise<Schedule[]>;

  claimOccurrence(
    input: ClaimOccurrenceInput
  ): Promise<
    | { claimed: true; run: ScheduleRun }
    | { claimed: false }
  >;

  getRun(
    id: string
  ): Promise<ScheduleRun | undefined>;

  listRuns(
    scheduleId: string,
    options?: ScheduleRunListOptions
  ): Promise<ScheduleRun[]>;

  listRecoverableRuns():
    Promise<ScheduleRun[]>;

  transitionRun(
    ...
  ): Promise<ScheduleRun>;
}
```

---

# 35. 一个最关键的事务

Timer 到点时不能：

```text
先运行 Agent
再更新 next_run_at
```

正确顺序：

```text
BEGIN TRANSACTION

1. read schedule
2. verify due
3. INSERT schedule_run
4. UPDATE schedule.next_run_at
5. once schedule → enabled=false

COMMIT

6. dispatch target
```

这样即使：

```text
COMMIT 后立即 crash
```

也不会再次认为该 occurrence 没发生。

---

# 36. 时间计算接口

```ts
export interface ScheduleCalculator {

  validate(
    spec: ScheduleSpec
  ): void;

  nextAfter(
    spec: ScheduleSpec,
    after: Date
  ): Date | undefined;

}
```

---

# 37. once

```ts
nextAfter(
  { kind: 'once', runAt },
  after
)
```

如果：

```text
runAt > after
```

返回：

```text
runAt
```

否则：

```text
undefined
```

---

# 38. interval

不要：

```text
执行完
 +
 interval
```

否则任务耗时会导致漂移。

错误：

```text
08:00 start
08:10 finish

interval = 1h

next = 09:10
```

正确：

```text
anchor = 08:00

08:00
09:00
10:00
11:00
```

公式：

```ts
const elapsed =
  afterMs - anchorMs;

const n =
  Math.floor(
    elapsed / intervalMs
  ) + 1;

return new Date(
  anchorMs + n * intervalMs
);
```

---

# 39. Cron

```ts
CronExpressionParser.parse(
  expression,
  {
    currentDate: after,
    tz: timezone,
    strict: true
  }
).next();
```

M1 强制：

```text
5-field Cron
```

不要开放秒级 Cron。

---

# 40. 最小周期

建议：

```text
interval >= 60 seconds
```

Cron：

```text
minimum effective interval = 1 minute
```

避免：

```text
Agent every second
```

导致 Provider/Token 爆炸。

---

# 41. Timezone 验证

使用：

```ts
new Intl.DateTimeFormat(
  'en-US',
  { timeZone }
);
```

无效：

```text
Asia/Xian123
```

直接：

```text
schedule_invalid_timezone
```

---

# 42. DurableScheduleEngine

```ts
export class DurableScheduleEngine {

  constructor(
    private readonly store:
      ScheduleStore,

    private readonly calculator:
      ScheduleCalculator,

    private readonly dispatcher:
      ScheduleTargetDispatcher,

    private readonly instanceId:
      string,

    private readonly now:
      () => Date = () => new Date()
  ) {}

  initialize(): Promise<void>;

  poke(): void;

  close(): Promise<void>;

}
```

---

# 43. Engine 不应该一个 Schedule 一个 setInterval

不要：

```ts
setInterval(...)
setInterval(...)
setInterval(...)
```

然后 Schedule 数量增长。

正确模型：

```text
DB
 ↓
找最近 next_run_at
 ↓
一个 Timer
 ↓
wake
 ↓
批量 claim due schedules
 ↓
dispatch
 ↓
重新计算最近时间
```

---

# 44. Main Loop

逻辑：

```ts
async wake(): Promise<void> {

  while (!closed) {

    const now =
      this.now();

    const due =
      await store.listDue(
        now.getTime(),
        100
      );

    if (!due.length)
      break;

    for (const schedule of due) {

      await this.processDueSchedule(
        schedule,
        now
      );

    }

  }

  this.armNextTimer();

}
```

---

# 45. Timer Safety

Node Timer 有最大延迟限制。

不要直接：

```ts
setTimeout(fn, monthsInMs)
```

建议：

```ts
MAX_SLEEP_MS =
  5 * 60 * 1000;
```

即使最近任务在一周后：

```text
每 5 分钟醒一次
```

检查 DB。

代价很小，同时允许：

- 外部数据库修改；
- Clock Change；
- Sleep/Wake；
- Laptop Suspend；

更容易恢复。

---

# 46. poke()

Schedule 创建/编辑/启用后：

```text
ScheduleService
   ↓
engine.poke()
```

立即：

```text
cancel current timer
重新计算最近任务
```

所以正常情况下不用等 5 分钟。

---

# 47. Laptop Sleep

setTimeout 不保证：

```text
电脑睡眠期间准确执行
```

电脑恢复：

```text
wake()
```

发现：

```text
next_run_at < now
```

进入：

```text
Misfire Policy
```

这正是持久 Scheduler 必须基于 DB 而不是 Timer 的原因。

---

# 48. Misfire 算法

```ts
async processDueSchedule(
  schedule: Schedule,
  now: Date
) {

  const due =
    new Date(schedule.nextRunAt!);

  const lateness =
    now.getTime() -
    due.getTime();

  if (lateness <= 0)
    return;

  if (
    schedule.misfire.kind === 'skip'
  ) {

    await recordSkipped(
      'misfire_skip'
    );

    await advance(schedule, now);

    return;
  }

  if (
    lateness >
    schedule.misfire.graceMs
  ) {

    await recordSkipped(
      'misfire_grace_exceeded'
    );

    await advance(schedule, now);

    return;
  }

  await claimAndDispatch(
    schedule,
    due,
    'misfire'
  );
}
```

---

# 49. next_run_at 更新

Cron / Interval Misfire 后不要：

```text
next = missed + one interval
```

否则：

```text
仍然可能在过去
```

必须：

```text
advanceUntilAfter(now)
```

但不循环创建 Runs。

只计算时间。

---

# 50. Concurrency 判断

在 claim occurrence 前：

```ts
const active =
  await store.listRuns(
    schedule.id,
    {
      states: [
        'pending',
        'dispatching',
        'running',
        'waiting_approval'
      ]
    }
  );
```

---

# 51. skip overlap

```text
active exists
+
policy=skip
```

创建：

```text
ScheduleRun {
  status: skipped,
  errorCode:
    "schedule_overlap"
}
```

然后继续 advance schedule。

---

# 52. queue overlap

创建：

```text
pending
```

不 dispatch。

当前 active Run terminal 后：

```text
drainPending(scheduleId)
```

---

# 53. queue coalescing

M1：

```text
每个 Schedule
最多 1 个 pending occurrence
```

第二个 pending：

```text
SKIPPED
queue_coalesced
```

---

# 54. Manual Run

接口：

```ts
runNow(
  scheduleId: string,
  options?: {
    respectConcurrency?: boolean;
  }
)
```

默认：

```text
respectConcurrency=true
```

Manual occurrence：

```text
manual:<uuid>
```

并且：

```text
不修改 next_run_at
```

---

# 55. Target Dispatcher

Scheduler Core 不 import：

```text
AgentRuntime
WorkflowManager
TeamManager
```

全部通过抽象：

```ts
export interface ScheduleTargetDispatcher {

  dispatch(
    input: ScheduleDispatchRequest
  ): Promise<TargetExecutionSnapshot>;

  inspect(
    reference: TargetExecutionReference
  ): Promise<
    TargetExecutionSnapshot | undefined
  >;

  cancel(
    reference: TargetExecutionReference
  ): Promise<void>;

  subscribe(
    listener:
      (event: TargetExecutionEvent) => void
  ): () => void;

}
```

---

# 56. Unified Target Snapshot

```ts
export type TargetExecutionState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TargetExecutionSnapshot = {
  kind:
    | 'agent'
    | 'workflow'
    | 'team_member';

  id: string;

  state: TargetExecutionState;

  resultPreview?: string;

  errorCode?: string;

  error?: string;
};
```

---

# 57. DispatcherRegistry

```ts
export class ScheduleDispatcherRegistry {

  register(
    kind: ScheduleTarget['kind'],
    dispatcher:
      TypedScheduleTargetDispatcher
  ): void;

}
```

这样：

```text
Desktop
```

可以支持：

```text
agent
workflow
team_member
```

而早期：

```text
Headless Server
```

可以先只注册：

```text
agent
```

而不阻塞 Scheduler Core。

---

# 58. AgentScheduleDispatcher

推荐组合：

```text
AgentScheduleDispatcher
     │
     ├── AgentRuntime
     ├── JojoAppService
     └── RuntimeEnvironment
```

---

# 59. Agent Lane 初始化

第一次执行：

```ts
const session =
  await runtime.getSession(
    target.sessionId
  );

const laneId =
  target.lane?.mode === 'main'
    ? 'main'
    : target.lane?.id
      ?? `schedule:${scheduleId}`;
```

如果 Lane 不存在：

```ts
await session.createLane({
  id: laneId,
  parentLaneId: 'main'
});
```

---

# 60. Scheduler Run ID 与 Runtime Run ID

非常推荐使用稳定映射：

```text
ScheduleRun:
sr_abc

Agent Runtime Run:
srr_sr_abc
```

例如：

```ts
const runtimeRunId =
  `schedrun:${scheduleRun.id}`;
```

原因：

```text
Scheduler crash
 ↓
restart
 ↓
可以直接 inspectRun(runtimeRunId)
```

而不是在数据库里猜哪个 Agent Run 属于它。

---

# 61. App Service 需要小改

当前：

```ts
JojoAppService.startRun()
```

自己创建 Run ID，并且固定：

```ts
actor: {
  kind: 'main'
}
```

Scheduler 接入建议增加内部 options：

```ts
type StartRunOptions = {
  runId?: string;

  trigger?: RuntimeTriggerContext;

  metadata?: {
    scheduleId?: string;
    scheduleRunId?: string;
  };
};
```

接口：

```ts
startRun(
  ctx,
  sessionId,
  input,
  options?
)
```

Server HTTP：

```text
永远不允许客户端自己提供
runId / scheduler trigger
```

只允许内部 Scheduler 调用。

---

# 62. Run Persistence 增加 Origin

当前：

```ts
RunRequestMeta
```

扩展：

```ts
export type RunRequestMeta = {

  budget?: ...;

  origin?: {
    kind:
      | 'user'
      | 'api'
      | 'scheduler';

    scheduleId?: string;

    scheduleRunId?: string;
  };

};
```

这样 Run History 可以直接知道：

```text
这次 Agent Run
来自哪个 Schedule
```

---

# 63. Runtime Trigger 是 Scheduler M1 的必做项

当前 Permission Governance 已经有：

```ts
trigger: {
  kind:
    | 'user'
    | 'api'
    | 'workflow'
    | 'subagent'
    | 'team_member'
    | 'scheduler'
    | 'resume';
}
```

但是 Runtime 当前没有真正携带。

必须补：

```ts
export type RuntimeTriggerContext = {
  kind:
    | 'user'
    | 'api'
    | 'workflow'
    | 'subagent'
    | 'team_member'
    | 'scheduler'
    | 'resume';

  id?: string;
};
```

---

# 64. RunRequest

修改：

```ts
export type RunRequest = {

  ...

  actor?: RuntimeActor;

  trigger?: RuntimeTriggerContext;

  workflow?: RuntimeWorkflowContext;

  team?: RuntimeTeamContext;

};
```

---

# 65. RuntimeResolutionContext

增加：

```ts
trigger?: RuntimeTriggerContext;
```

然后传递到：

```text
ToolResolver
PermissionGate
HookResolver
RunContext
Telemetry
```

---

# 66. Permission Normalizer

当前逻辑：

```text
actor=workflow
→ trigger=workflow

actor=subagent
→ trigger=subagent

actor=team_member
→ trigger=team_member

else
→ user
```

改成：

```ts
const trigger =
  context.trigger
  ?? inferTrigger(context);
```

Scheduler：

```ts
trigger: {
  kind: 'scheduler',
  id: scheduleRun.id
}
```

---

# 67. interactive

必须改：

```ts
interactive =
  actor.kind === 'main'
  &&
  trigger.kind === 'user';
```

Scheduler Main Agent：

```text
actor = main
trigger = scheduler
interactive = false
```

---

# 68. Scheduler 不新增自动 Allow Rule

不要因为：

```text
trigger=scheduler
```

就自动：

```text
ALLOW
```

Permission Governance 仍然：

```text
Hard Floor
    ↓
User DENY
    ↓
Mandatory Approval
    ↓
Policy
    ↓
Grant
    ↓
Mode
```

Scheduler 只是：

```text
执行来源
```

不是权限升级。

---

# 69. Scheduled Main Agent 遇到 ASK

流程：

```text
ScheduleRun
   ↓
Agent Run
   ↓
Tool
   ↓
Permission Governance
   ↓
ASK
   ↓
ApprovalBroker
```

Scheduler Run：

```text
running
   ↓
waiting_approval
```

---

# 70. Approval 完成

```text
approval.resolved
      ↓
ScheduleRun
waiting_approval
      ↓
running
```

底层 Agent 不需要 Scheduler 手动 Resume：

```text
ApprovalBroker Promise
```

自己恢复。

---

# 71. Team Target

TeamManager 已经有：

```text
queued
running
waiting_approval
completed
failed
cancelled
interrupted
```

所以：

```text
TeamScheduleDispatcher
```

只是状态映射。

---

# 72. Team Delegate

```ts
const task =
  await teamManager.delegate({

    teamId:
      target.teamId,

    memberId:
      target.memberId,

    task:
      target.task,

    parent: {
      sessionId:
        target.parentSessionId,
      actorId:
        `schedule:${scheduleId}`
    },

    ...
  });
```

---

# 73. Team Task ID 建议支持外部注入

当前：

```text
TeamManager.delegate()
```

内部生成：

```text
tt_<uuid>
```

为了 Scheduler Crash Recovery 更强，建议：

```ts
TeamDelegateRequest {
  taskId?: string;
}
```

Scheduler：

```text
tt_sched_<scheduleRunId>
```

TeamStore：

```text
相同 taskId
+
相同 request hash
=
idempotent
```

不同内容：

```text
team_task_conflict
```

---

# 74. Workflow Run ID 同样建议可注入

当前 Workflow：

```text
wf_<uuid>
```

建议：

```ts
WorkflowStartRequest {
  id?: string;
}
```

Scheduler：

```text
wf_sched_<scheduleRunId>
```

这样 Recovery 可以：

```text
ScheduleRun
  ↓
直接 workflowManager.get(id)
```

---

# 75. 为什么 Stable Target ID 很重要

最危险的 Crash Window：

```text
Scheduler
  ↓
dispatch workflow
  ↓
Workflow 真正开始
  ↓
进程 crash
  ↓
Scheduler 还没保存 workflowId
```

如果重新 dispatch：

```text
可能重复执行 Side Effect
```

Stable ID 后：

```text
第二次 start
  ↓
发现相同 Execution ID
  ↓
inspect/recover
```

避免重复。

---

# 76. ScheduleRun 状态映射

Agent：

```text
accepted / starting
→ dispatching

running
→ running

approval.required
→ waiting_approval

completed
→ completed

failed
→ failed

cancelled
→ cancelled

interrupted
→ interrupted
```

---

# 77. Workflow

```text
running
→ running

completed
→ completed

failed / timed_out
→ failed

cancelled
→ cancelled

interrupted / suspended
→ interrupted
```

---

# 78. Team

```text
queued
→ pending

running
→ running

waiting_approval
→ waiting_approval

completed
→ completed

failed
→ failed

cancelled
→ cancelled

interrupted
→ interrupted
```

---

# 79. ScheduleRun 不复制完整 Result

不要把：

```text
完整 Transcript
完整 Workflow Snapshot
完整 Diff
```

复制进：

```text
scheduler.sqlite
```

ScheduleRun 只保存：

```text
targetExecutionId
resultPreview
error
```

详情从：

```text
Agent Runtime
Workflow Store
Team Store
```

读取。

---

# 80. resultPreview

限制：

```text
4 KB
```

用于 Scheduler UI：

```text
Last result:
3 tests failed...
```

不是 Source of Truth。

---

# 81. Recovery

Scheduler 启动：

```text
initialize()
   │
   ├── recoverScheduleRuns()
   │
   ├── processMisfires()
   │
   └── armTimer()
```

---

# 82. Recovery 原则必须延续 Jojo 当前风格

当前 Jojo 已经采用：

```text
不能证明安全恢复
→ interrupted
```

而不是：

```text
自动重新执行
```

Scheduler 必须坚持同样原则。

---

# 83. Recover dispatching

ScheduleRun：

```text
dispatching
```

先：

```text
dispatcher.inspect(
  deterministicTargetId
)
```

---

## 找到 Target

绑定：

```text
targetExecutionId
```

并镜像状态。

---

## 找不到 Target

如果 Target Dispatcher 支持：

```text
idempotent dispatch
```

才允许再次 dispatch。

否则：

```text
interrupted
errorCode =
  schedule_dispatch_uncertain
```

绝对不要猜。

---

# 84. Recover running

调用：

```text
dispatcher.inspect()
```

---

## Agent

可以：

```text
AgentRuntime.inspectRun()
```

---

## Workflow

先：

```text
WorkflowManager.restore()
```

然后：

```text
workflowManager.get()
```

---

## Team

TeamManager：

```text
initialize()
```

已经会安全处理中断 Task。

Scheduler 再读取：

```text
TeamStore.getTask()
```

即可。

---

# 85. Recovery 初始化顺序

非常重要。

Desktop Worker：

```text
1. Storage
2. Runtime
3. Permission Governance
4. WorkflowManager.restore()
5. TeamManager.initialize()
6. SchedulerService.initialize()
```

Scheduler 必须最后。

否则：

```text
Scheduler inspect workflow/team
```

时底层还没恢复。

---

# 86. Shutdown 顺序

```text
1. SchedulerEngine.close()
2. stop accepting new occurrences
3. existing target execution remains owned by target runtime
4. quiesce Team / Workflow / Agent Runtime
5. close stores
```

不要 Shutdown 时：

```text
Scheduler 又恰好 fire 一个新任务
```

---

# 87. Scheduler 自己的 Recovery 不自动 Retry Failure

M1：

```text
Agent failed
Workflow failed
Team failed
```

Scheduler：

```text
记录 failed
```

不：

```text
5 秒后自动再跑
```

原因：

```text
可能已经产生外部 Side Effect
```

下一 Cron occurrence：

```text
正常按时间再次执行
```

用户也可以：

```text
Run Now
```

---

# 88. 后续 Retry Policy

M2 再考虑：

```ts
retry?: {
  maxAttempts: number;
  backoffMs: number;
  retryOn: string[];
}
```

并要求 Dispatcher 标记：

```text
safeToRetry
```

M1 不做。

---

# 89. Scheduler Lease

Headless Server 与 Desktop 以后可能：

```text
同时指向同一 Data Directory
```

因此需要避免：

```text
两个 Engine
同时 fire
```

---

# 90. 不复用 Server LeaseManager

当前 Server Lease 是：

```text
Session Client Control Lease
```

而且：

```text
in-memory
```

作用：

```text
哪个 Remote Client 可以控制 Session
```

与 Scheduler Ownership 完全不同。

不要复用。

---

# 91. scheduler_leases

SQLite：

```sql
CREATE TABLE scheduler_leases (
    key TEXT PRIMARY KEY,

    owner_id TEXT NOT NULL,

    expires_at INTEGER NOT NULL,

    version INTEGER NOT NULL
);
```

固定：

```text
key = "engine"
```

---

# 92. Engine Lease

每：

```text
10 seconds
```

renew。

TTL：

```text
30 seconds
```

---

# 93. Leader

只有 Lease Owner：

```text
process due schedules
```

其他 Engine：

```text
standby
```

---

# 94. Lease 不是最终幂等保障

即使有 Lease：

```text
occurrence UNIQUE constraint
```

仍然必须存在。

最终保护层：

```text
Lease
+
Occurrence Unique Key
+
Stable Target Execution ID
```

三层。

---

# 95. ScheduleService

面向 Host：

```ts
export interface ScheduleService {

  list():
    Promise<Schedule[]>;

  get(
    id: string
  ): Promise<Schedule>;

  create(
    input: CreateScheduleInput,
    principal: SchedulePrincipal
  ): Promise<Schedule>;

  update(
    id: string,
    input: UpdateScheduleInput
  ): Promise<Schedule>;

  setEnabled(
    id: string,
    enabled: boolean
  ): Promise<Schedule>;

  delete(
    id: string
  ): Promise<void>;

  runNow(
    id: string
  ): Promise<ScheduleRun>;

  listRuns(
    id: string
  ): Promise<ScheduleRun[]>;

  cancelRun(
    runId: string
  ): Promise<void>;

  subscribe(
    listener:
      (event: ScheduleEvent) => void
  ): () => void;

}
```

---

# 96. ScheduleEvent

```ts
export type ScheduleEvent =
  | {
      type: 'schedule.changed';
      schedule: Schedule;
    }

  | {
      type: 'schedule.deleted';
      scheduleId: string;
    }

  | {
      type: 'schedule.run.changed';
      run: ScheduleRun;
    };
```

---

# 97. Update 使用 Revision

与现有 Team / Session 风格保持一致：

```ts
update(
  id,
  patch,
  expectedRevision
)
```

冲突：

```text
schedule_revision_conflict
```

避免：

```text
两个 UI 窗口覆盖彼此修改
```

---

# 98. Schedule 编辑后 next_run_at

修改：

```text
cron
timezone
interval
runAt
```

必须立即：

```text
recalculate from now
```

然后：

```text
engine.poke()
```

---

# 99. Disable

```text
enabled=false
```

表示：

```text
不产生新的 ScheduleRun
```

默认：

```text
不会 cancel 正在运行的任务
```

---

# 100. Cancel Active

单独：

```text
Cancel Run
```

不要把：

```text
Disable
```

隐式解释成：

```text
杀死 Agent
```

---

# 101. Delete

建议：

```text
Soft Delete
```

保留：

```text
ScheduleRun History
```

删除时：

```text
enabled=false
deletedAt=now
```

默认不 cancel active run。

---

# 102. Schedule Target Validation

创建 Schedule 前立即验证。

---

## Agent

检查：

```text
session exists
lane can be created
provider/model format valid
```

---

## Workflow

检查：

```text
saved workflow exists
or inline schema valid

args valid
workspace valid
```

---

## Team Member

检查：

```text
team exists
member exists
member not disabled
```

---

# 103. Target 后续失效

例如：

```text
Schedule
→ Team reviewer

用户删除 reviewer
```

下一次：

```text
ScheduleRun
→ failed
→ schedule_target_not_found
```

M1 不自动删除 Schedule。

但在 UI 显示：

```text
Target invalid
```

M2 可以在 Team 删除时主动标记相关 Schedules。

---

# 104. Scheduler Target 与 Permission 的关系

Schedule Creation：

```text
不等于预授权所有未来操作
```

这是非常重要的安全原则。

错误：

```text
用户创建了每日任务
=
以后所有 Terminal 都自动允许
```

正确：

```text
Schedule
   ↓
每一次 Agent Run
   ↓
每一个 Tool Call
   ↓
Permission Governance
```

---

# 105. Permission Profile

M1 不需要给 Schedule 自己再造：

```text
permissionMode
```

直接使用：

```text
当前 Global / Workspace Permission Policy
```

和：

```text
trigger=scheduler
```

进行规则匹配。

---

# 106. 后续 Schedule-specific Policy

未来可以让 Policy Match：

```yaml
match:
  triggers:
    - scheduler
```

例如：

```yaml
- id: scheduled-read-only
  effect: deny

  match:
    triggers:
      - scheduler

    operations:
      - write
```

Scheduler 不需要额外 Permission System。

---

# 107. Approval 与 Scheduler UI

Schedule Run：

```text
WAITING_APPROVAL
```

UI：

```text
Daily Code Review
Waiting for approval

terminal
git fetch
network: host
```

点击：

```text
Review Approval
```

跳转现有 Approval UI。

不要开发第二套 Approval Modal。

---

# 108. Scheduler 与 Team Approval

TeamManager 已经会：

```text
approval.required
↓
TeamTask.waiting_approval
```

ScheduleRun：

```text
监听 TeamTask
↓
同步 waiting_approval
```

无需修改 Permission。

---

# 109. Scheduler 与 Workflow Approval

Workflow Run 本身可保持：

```text
running
```

Scheduler 可以通过 Target Adapter 收到：

```text
approval.required
```

从而把外层：

```text
ScheduleRun
```

标记：

```text
waiting_approval
```

底层 Workflow 状态不需要为了 Scheduler 修改。

---

# 110. Desktop 集成

新增：

```text
apps/desktop/src/renderer/components/SchedulerSettings.tsx
```

设置页：

```text
Automations
```

或者：

```text
Scheduler
```

推荐产品名称：

```text
Automations
```

底层模块仍叫：

```text
Scheduler
```

---

# 111. Scheduler List UI

每条：

```text
Daily code review

Every day at 08:00
Asia/Shanghai

Target:
Team / reviewer

Next:
Tomorrow 08:00

Last:
Completed 2h ago

[Run now] [···] [Enabled]
```

---

# 112. Edit UI

三个 Trigger：

```text
Once
Every interval
Cron
```

普通用户默认图形化。

Advanced：

```text
Cron expression
Timezone
```

---

# 113. Target UI

```text
Run:

○ Agent
○ Workflow
○ Team Member
```

---

# 114. Agent

选择：

```text
Session / Workspace
Model
Prompt
```

默认：

```text
Dedicated schedule lane
```

---

# 115. Workflow

选择：

```text
Saved Workflow
Args
Provider
Model
```

---

# 116. Team

选择：

```text
Team
Member
Task
```

---

# 117. History

```text
Runs

Aug 30 08:00  Completed
Aug 29 08:00  Completed
Aug 28 08:00  Waiting approval
Aug 27 08:00  Skipped — app offline too long
```

---

# 118. Desktop IPC

Contracts 增加：

```text
scheduler.list
scheduler.get
scheduler.save
scheduler.delete
scheduler.enabled
scheduler.run-now
scheduler.run.cancel
scheduler.runs.list
```

与 Team 当前 IPC 风格保持一致。

---

# 119. Worker 集成

Worker：

```text
runtime
 ↓
workflowManager
teamManager
 ↓
scheduleService
```

新增：

```text
apps/desktop/src/worker/scheduler-runtime.ts
```

负责组合：

```text
SqliteScheduleStore
DefaultScheduleCalculator
DispatcherRegistry
DurableScheduleEngine
ScheduleService
```

不要把 Engine 逻辑写进：

```text
worker.ts
```

---

# 120. Headless Server

最新代码已经有：

```text
apps/server
```

因此 Scheduler Core 从第一天就不要 import Electron。

Headless：

```text
createHeadlessServer()
       │
       ├── runtime
       ├── appService
       ├── core
       └── scheduleService
```

---

# 121. Headless M1 Target

建议 Headless Scheduler 第一阶段先支持：

```text
agent
```

因为：

```text
JojoAppService
Runtime Run Store
Approval Store
```

已经完整存在。

---

# 122. Workflow / Team Headless

等：

```text
WorkflowManager
TeamManager
```

正式进入 Server Host Composition 后，再注册：

```text
WorkflowScheduleDispatcher
TeamMemberScheduleDispatcher
```

Scheduler Core 不需要改。

---

# 123. Server Capabilities

未来：

```ts
scheduler: {
  enabled: true;

  targets: [
    'agent',
    'workflow',
    'team_member'
  ];
}
```

不要只有：

```text
scheduler: true
```

否则 Client 不知道具体 Target 是否可用。

---

# 124. Server Scopes

建议：

```text
schedules:read
schedules:write
schedules:run
schedules:cancel
```

---

# 125. HTTP

建议：

```text
GET    /v1/schedules
POST   /v1/schedules

GET    /v1/schedules/:id
PATCH  /v1/schedules/:id
DELETE /v1/schedules/:id

POST   /v1/schedules/:id/run

GET    /v1/schedules/:id/runs

GET    /v1/schedule-runs/:runId
POST   /v1/schedule-runs/:runId/cancel
```

---

# 126. Scheduler HTTP 不需要 Session Control Lease

创建：

```text
Schedule
```

是 Automation Control Plane 操作。

因此用：

```text
schedules:write
```

授权。

不要要求：

```text
session control lease
```

---

# 127. 但是 Scheduler 内部启动 Agent Run 时

也不要：

```text
Scheduler
 ↓
ServerCore.startRun()
 ↓
require remote control lease
```

Scheduler 是服务内部 Actor。

应该调用：

```text
JojoAppService
```

或者：

```text
Agent Schedule Dispatcher
```

内部入口。

Server Lease 只约束：

```text
Remote Client
```

不是内部 Service。

---

# 128. Scheduler Principal

内部：

```ts
const schedulerPrincipal = {
  id: `scheduler:${instanceId}`,

  type: 'service',

  scopes: [
    'runs:start'
  ]
};
```

用于：

```text
Audit
Run origin
```

不是权限绕过。

Agent Tool Permission 仍由：

```text
Permission Governance
```

决定。

---

# 129. Server Protocol 版本

如果 Scheduler API 直接加入当前 strict：

```text
ServerCapabilitiesSchema
ClientCommandSchema
```

建议评估：

```text
JOJO_SERVER_PROTOCOL_VERSION
```

升级。

因为旧 Client 使用 strict Zod 时：

```text
额外字段
```

可能导致兼容问题。

不要偷偷改变 Protocol v1 语义。

---

# 130. Heartbeat 不放进 M1

Scheduler：

```text
确定性时间触发
```

Heartbeat：

```text
周期性唤醒 Agent
让 Agent 判断是否需要做事
```

这两个概念仍然分开。

---

# 131. 但 Heartbeat 未来可以复用 Scheduler

实现：

```text
HeartbeatService
    ↓
创建内部 Interval Schedule
    ↓
Agent Target
```

Scheduler Core 不需要知道：

```text
Heartbeat
```

是什么。

---

# 132. Scheduler 也可以驱动内部 Maintenance

未来可以增加 Internal Target：

```ts
{
  kind: 'maintenance',

  task:
    | 'memory_compaction'
    | 'memory_embedding'
    | 'workspace_reindex'
}
```

但 M1 不开放。

M1 Target 只：

```text
agent
workflow
team_member
```

---

# 133. 错误码

建议：

```text
schedule_not_found

schedule_invalid_spec
schedule_invalid_timezone
schedule_invalid_cron
schedule_interval_too_short

schedule_target_invalid
schedule_target_not_found

schedule_overlap
schedule_queue_coalesced

schedule_misfire_skipped
schedule_misfire_grace_exceeded

schedule_dispatch_failed
schedule_dispatch_uncertain

schedule_run_not_found
schedule_run_not_cancellable

schedule_revision_conflict

scheduler_not_leader
scheduler_store_failed
```

---

# 134. Metrics

后续可增加：

```text
scheduler_occurrences_total {
  target,
  result
}
```

```text
scheduler_dispatch_latency_ms
```

```text
scheduler_misfires_total {
  policy
}
```

```text
scheduler_waiting_approval_total
```

```text
scheduler_active_runs {
  target
}
```

---

# 135. Tests：时间计算

必须覆盖：

```text
once future
once past

interval exact boundary
interval after boundary
interval no drift

cron daily
cron weekday
cron month boundary

timezone Shanghai
timezone Los Angeles
DST spring forward
DST fall back
```

---

# 136. DST

例如：

```text
America/Los_Angeles
02:30 daily
```

DST 切换日：

```text
02:30 可能不存在
```

行为必须交给：

```text
cron parser
```

并固定测试预期。

不要自己：

```text
+24h
```

计算 Cron。

---

# 137. Misfire Tests

```text
skip

fire_once inside grace

fire_once outside grace

multiple missed occurrences
→ exactly one fire
```

---

# 138. Concurrency Tests

```text
previous running
+
skip
→ skipped
```

```text
previous running
+
queue
→ pending
```

```text
two queued occurrences
→ second coalesced
```

---

# 139. Crash Tests

## Crash after claim

```text
schedule_run inserted
next_run_at advanced
↓
crash before dispatch
```

Restart：

```text
不创建 duplicate occurrence
```

---

# 140. Crash after target start

```text
Target started
↓
crash before targetExecutionId persisted
```

如果 deterministic Target ID：

```text
inspect
→ recover correlation
```

否则：

```text
interrupted
```

绝不重新执行未知 Side Effect。

---

# 141. Approval Tests

Scheduled Agent：

```text
trigger=scheduler
```

Tool ASK：

```text
ScheduleRun
→ waiting_approval
```

批准：

```text
→ running
→ completed
```

拒绝：

底层 Agent 继续得到：

```text
user_denied
```

ScheduleRun 最终根据 Agent Result 更新。

---

# 142. Permission Tests

必须验证：

```text
scheduler trigger
```

不会被误识别为：

```text
user
```

---

# 143. Hard Deny

即使：

```text
Schedule
+
YOLO
```

也必须：

```text
Hard Floor DENY
```

---

# 144. Team Scheduler Tests

```text
cron
↓
team_delegate reviewer
↓
TeamTask queued
↓
running
↓
completed
```

ScheduleRun：

```text
targetExecutionId == TeamTask.id
```

---

# 145. Team overlap

每日：

```text
reviewer
```

上一轮仍 waiting approval。

下一 occurrence：

默认：

```text
skip
```

不要向 TeamManager 再堆任务。

---

# 146. Workflow Scheduler Tests

```text
saved workflow
↓
Scheduler
↓
WorkflowManager.start
↓
workflow run id persisted
```

Workflow interrupted：

```text
ScheduleRun
→ interrupted
```

不自动 resume。

---

# 147. Manual Run Test

```text
Run Now
```

不改变：

```text
next_run_at
```

---

# 148. Update Test

Cron：

```text
08:00
```

改为：

```text
09:00
```

立即重新计算：

```text
next_run_at
```

不会遗留旧 Timer。

---

# 149. Disable Test

Disable 后：

```text
existing running continues
new occurrence does not fire
```

---

# 150. Delete Test

Soft Delete：

```text
schedule disappears
history remains
active execution continues
```

---

# 151. 建议实施 PR 顺序

## PR 1 — Runtime Trigger

先做：

```text
RuntimeTriggerContext
```

贯穿：

```text
RunRequest
RuntimeResolutionContext
Permission Normalizer
Audit
Telemetry
```

并修复：

```text
API / Scheduler / Resume
```

Trigger 语义。

这个应该在 Scheduler Engine 前完成。

---

# 152. PR 2 — Scheduler Contracts + Calculator

新增：

```text
packages/scheduler
```

先完成：

```text
ScheduleSpec
ScheduleTarget
Schedule
ScheduleRun
ScheduleCalculator
```

以及：

```text
once
interval
cron
timezone
```

纯单元测试。

---

# 153. PR 3 — SQLite Store

实现：

```text
SqliteScheduleStore
```

包括：

```text
revision
occurrence unique
claim transaction
run transitions
recovery query
```

---

# 154. PR 4 — Durable Engine

实现：

```text
DurableScheduleEngine
```

包括：

```text
single timer
poke
due scan
misfire
overlap
queue
leader lease
```

此阶段 Dispatcher 可用 Fake。

---

# 155. PR 5 — Agent Target

第一条真正可用链路：

```text
Cron
 ↓
ScheduleRun
 ↓
Agent
 ↓
Permission Governance
 ↓
Approval
```

实现：

```text
AgentScheduleDispatcher
```

和：

```text
Dedicated Schedule Lane
```

---

# 156. PR 6 — Desktop UI / IPC

增加：

```text
Automations Settings
Schedule List
Editor
Run History
Run Now
Enable / Disable
Cancel
```

做到这里 Scheduler 已经真正可用。

---

# 157. PR 7 — Team Target

实现：

```text
TeamMemberScheduleDispatcher
```

并给：

```text
TeamDelegateRequest
```

增加稳定：

```text
taskId?
```

---

# 158. PR 8 — Workflow Target

实现：

```text
WorkflowScheduleDispatcher
```

并给：

```text
WorkflowStartRequest
```

增加稳定：

```text
id?
```

---

# 159. PR 9 — Headless Scheduler

在：

```text
apps/server
```

组合：

```text
ScheduleService
ScheduleEngine
AgentScheduleDispatcher
```

Server：

```text
scheduler capability
REST
WebSocket
scopes
```

---

# 160. PR 10 — Recovery Hardening

增加：

```text
leader failover
dispatch crash tests
stable target id
uncertain dispatch handling
```

---

# 161. M1 最小可交付范围

如果希望尽快完成，可以把第一版控制在：

```text
Trigger
├── once
├── interval
└── cron

Target
└── agent

Persistence
├── schedules
└── schedule_runs

Policies
├── misfire skip/fire_once
└── overlap skip

Actions
├── create
├── update
├── enable
├── disable
├── run now
├── history
└── cancel
```

即：

> 先把 Agent 定时执行做成真正 durable。

---

# 162. M1.5

然后加：

```text
Team Member Target
```

当前 Team 底座已经成熟，所以成本并不会特别高。

---

# 163. M2

再加：

```text
Workflow Target
queue policy
Headless Server API
```

---

# 164. M3

以后：

```text
Heartbeat
Event Trigger
Webhook Trigger
Connector Trigger
Conditional Watch
Natural Language Automation Builder
```

全部可以继续复用：

```text
ScheduleRun / Target Dispatcher
```

---

# 165. 最终架构

```text
                       Trigger Layer
                            │
              ┌─────────────┼─────────────┐
              │             │             │
             Time        Manual          Future
              │                         Webhook/Event
              ▼
                    Durable Scheduler
                            │
                            ▼
                       ScheduleRun
                            │
                            ▼
                   Target Dispatcher
              ┌─────────────┼──────────────┐
              │             │              │
              ▼             ▼              ▼
          Agent Run    Workflow Run     Team Task
              │             │              │
              └─────────────┼──────────────┘
                            ▼
                      Agent Runtime
                            │
                  ┌─────────┴─────────┐
                  │                   │
             Runtime Lane       Orchestration
                  │                   │
                  └─────────┬─────────┘
                            ▼
                 Permission Governance
                            │
                            ▼
                    Approval Broker
                            │
                            ▼
                       Tool Broker
                            │
                            ▼
             Sandbox / MCP / Browser / FS
```

---

# 166. 与现有 AgentExecutionScheduler 的关系

最终：

```text
DurableScheduleEngine
```

负责：

```text
WHEN
```

现有：

```text
AgentExecutionScheduler
```

负责：

```text
HOW MANY
```

例如：

```text
08:00
Durable Scheduler
     │
     ├── schedule A
     ├── schedule B
     └── schedule C
             │
             ▼
      AgentExecutionScheduler
        maxConcurrent = 4
             │
             ▼
       实际 Agent Runtime
```

两者不要合并。

---

# 167. 与 Team 的关系

最新 Persistent Team 已经解决：

```text
WHO
```

Scheduler：

```text
WHEN
```

于是：

```text
WHEN
 ↓
Scheduler

WHO
 ↓
Team Member

HOW
 ↓
Agent Runtime

CAN IT
 ↓
Permission Governance
```

这几个层次现在已经非常清晰。

---

# 168. 与 Workflow 的关系

Workflow：

```text
WHAT STEPS / DEPENDENCIES
```

Scheduler：

```text
WHEN TO START
```

因此：

```text
Cron
 ↓
Workflow DAG
 ↓
Agent A
Agent B
Synthesize
```

Scheduler 永远不理解 DAG。

---

# 169. 与 Daemon 的关系

Scheduler Core 从一开始就：

```text
无 Electron 依赖
```

因此：

```text
Electron Worker
        │
        ├────────┐
        ▼        ▼
Scheduler    Runtime
```

以后：

```text
jojo server / daemon
        │
        ├────────┐
        ▼        ▼
Scheduler    Runtime
```

不需要重写 Scheduler。

---

# 170. 最关键的实现决定

本方案建议明确做以下六个决定：

### 1

不把现有：

```text
AgentExecutionScheduler
```

扩展成 Cron Scheduler。

### 2

不新造统一 Job Runtime。

使用：

```text
ScheduleRun
→ Agent Run / Workflow Run / Team Task
```

### 3

Schedule occurrence：

```text
先持久化并 advance next_run_at
再 dispatch
```

### 4

所有 Target 尽可能使用：

```text
deterministic execution ID
```

保证 Crash Recovery。

### 5

任何不确定是否已经产生 Side Effect 的执行：

```text
interrupted
```

而不是自动 replay。

### 6

真正把：

```text
trigger=scheduler
```

贯穿 Runtime 与 Permission Governance。

---

# 171. 最终建议

基于当前最新 main：

```text
Permission Governance
        ✓

Spawn
        ✓

Persistent Team
        ✓

Stable Team Lane
        ✓

Workflow Persistence
        ✓

Runtime Run ID
        ✓

Server Run Persistence
        ✓

Approval Persistence
        ✓

Headless Host
        ✓
```

因此现在已经非常适合开始 Scheduler。

推荐开发顺序：

```text
Runtime Trigger
      ↓
Scheduler Contracts
      ↓
SQLite Schedule Store
      ↓
Durable Engine
      ↓
Agent Target
      ↓
Desktop UI
      ↓
Team Target
      ↓
Workflow Target
      ↓
Headless Server
```

其中真正的第一个 PR 不是 Cron，而应该是：

```text
RuntimeTriggerContext
```

因为它会把：

```text
user
api
scheduler
workflow
subagent
team_member
resume
```

正式变成 Runtime 的一等执行来源。

完成后，Jojo 的执行模型可以稳定为：

```text
Trigger
  ↓
Execution
  ↓
Actor
  ↓
Permission
  ↓
Tool
```

也就是：

```text
谁（Actor）
因为什么（Trigger）
在什么时候（Scheduler）
执行什么（Agent / Team / Workflow）
能不能执行（Permission Governance）
```

这基本就是 Jojo 从“桌面对话 Agent”迈向“通用持续运行 Agent Runtime”的最后一块核心执行基础设施。
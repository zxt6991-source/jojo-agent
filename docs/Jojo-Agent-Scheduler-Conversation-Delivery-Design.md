# Jojo-Agent Scheduler 对话投递体验改造方案

> 目标：解决“用户在对话中创建定时任务，但任务执行结果只能在 `Settings -> Automations` 运行历史中查看”的体验问题。  
> 核心原则：**Automations 页面负责管理与审计，Conversation 负责结果交付。**

---

## 1. 背景

当前 Jojo-Agent 已经具备 Durable Scheduler 能力，支持：

- 单次执行（once）
- 固定间隔（interval）
- Cron + 时区
- Schedule 持久化
- ScheduleRun 运行历史
- Agent / Workflow / Team Member 调度
- misfire / concurrency
- 手动立即执行
- Scheduler Settings 管理页面

同时，Main Agent 已经可以通过对话调用 Scheduler Tool 创建定时任务。

当前交互示例：

```text
用户：
5 分钟后提醒我看一下天气情况

Agent：
已为您设置好提醒。
```

任务到期后，Scheduler 能正常执行，`ScheduleRun.resultPreview` 也能产生结果。

但当前结果主要显示在：

```text
Settings
  -> Automations
      -> 运行历史
          -> 查看结果
```

这会产生明显的用户体验问题：

> 用户明明是在“对话”中创建的提醒，却需要主动进入“设置页面”才能看到执行结果。

---

## 2. 当前问题

当前实际链路接近：

```text
Conversation
    │
    │ schedule_create
    ▼
ScheduleService
    ▼
Durable Scheduler
    ▼
ScheduleDispatcher
    ▼
Scheduled Agent
    ▼
ScheduleRun.resultPreview
    ▼
Automations Settings
```

其中缺少一层：

```text
ScheduleRun
    ↓
Delivery
    ↓
Conversation / Notification
```

因此目前 Scheduler 更接近“后台 Cron 控制台”，而不是面向最终用户的 Agent Automation。

### 2.1 用户体验问题

当前设计存在以下问题：

1. 对话创建、设置页收结果，入口和出口不一致。
2. 用户需要主动打开 Automations 页面确认任务是否执行。
3. Automations 页面承担了“消息收件箱”的职责。
4. 后台执行失败时，用户可能完全不知道。
5. `waiting_approval` 状态缺乏直接触达用户的入口。
6. App 不在前台时，结果没有自然的通知路径。
7. `resultPreview` 被当作最终用户交付界面，而不是运行审计信息。

---

# 3. 改造目标

改造后的目标体验：

## 3.1 创建任务

用户：

```text
5 分钟后提醒我看一下天气情况
```

Agent：

```text
好的，5 分钟后提醒你。
```

## 3.2 到期执行

5 分钟后，在**原来的对话中自动出现一条新消息**：

```text
⏰ 提醒时间到了

你让我 5 分钟后查看天气情况。
```

如果任务需要 Agent 执行，例如：

```text
每天早上 8 点帮我看看西安今天的天气
```

则执行完成后在原对话中出现：

```text
☀️ 今日天气
自动化 · 今天 08:00

西安今天晴到多云，最高温度 34℃……
```

## 3.3 Automations 页面

Automations 页面只负责：

- 查看任务
- 编辑任务
- 启停
- 删除
- 立即执行
- 查看下次运行时间
- 查看运行历史
- 查看投递状态
- 调试执行结果

而不再作为主要的结果展示入口。

---

# 4. 核心设计原则

整个 Scheduler 建议明确拆成三个概念：

```text
Schedule
   ↓
ScheduleRun
   ↓
Delivery
```

分别对应：

| 层 | 负责内容 |
|---|---|
| Schedule | 什么时候运行 |
| ScheduleRun | 实际执行发生了什么 |
| Delivery | 执行结果交付给谁 |

---

# 5. 总体架构

推荐改造后的架构：

```text
                         User
                          │
                          ▼
                   Main Conversation
                          │
                    schedule_create
                          │
                          ▼
                   ScheduleService
                          │
                          ▼
                  Durable Scheduler
                          │
                          ▼
                ScheduleDispatcher
                          │
             ┌────────────┴────────────┐
             │                         │
       Reminder Target            Agent Target
             │                         │
             │                   Dedicated Lane
             │                         │
             └────────────┬────────────┘
                          │
                          ▼
                    ScheduleRun
                          │
                          ▼
                  DeliveryService
                    │           │
                    ▼           ▼
              Conversation   Notification
                    │
                    ▼
                   User


Automations Settings
        │
        ├── CRUD
        ├── enabled
        ├── nextRun
        ├── run history
        ├── delivery status
        └── 查看对应对话
```

---

# 6. Schedule 增加 Delivery 配置

当前 Schedule 主要描述：

- spec
- target
- misfire
- concurrency
- enabled
- revision

建议新增：

```ts
delivery
```

## 6.1 M1 最小版本

第一阶段可以使用简单设计：

```ts
export interface ScheduleDelivery {
  mode: 'conversation' | 'silent';
  sessionId?: string;
}
```

对话中创建的 Schedule 默认：

```ts
delivery: {
  mode: 'conversation',
  sessionId: context.sessionId
}
```

## 6.2 推荐的可扩展版本

更建议直接采用：

```ts
export interface ScheduleDelivery {
  conversation?: {
    enabled: boolean;
    sessionId: string;
  };

  notification?: {
    enabled: boolean;
  };
}
```

例如：

```ts
delivery: {
  conversation: {
    enabled: true,
    sessionId: context.sessionId
  },
  notification: {
    enabled: true
  }
}
```

这样以后可以继续扩展：

```ts
delivery: {
  conversation: {...},
  notification: {...},
  email: {...},
  webhook: {...},
  slack: {...}
}
```

---

# 7. 对话创建的任务自动绑定来源 Session

模型不应该负责传：

```text
sessionId
providerId
model
```

这些都应该由 Scheduler Tool Adapter 自动补齐。

例如模型只调用：

```json
{
  "name": "5分钟后提醒查看天气",
  "schedule": {
    "kind": "once",
    "runAt": "2026-08-30T08:27:00Z"
  },
  "prompt": "提醒用户查看天气情况"
}
```

Tool 内部转换为：

```ts
{
  name: input.name,

  spec: input.schedule,

  target: {
    kind: 'agent',
    sessionId: context.sessionId,
    providerId: options.providerId,
    model: options.model,
    input: {
      content: [
        {
          type: 'text',
          text: input.prompt
        }
      ]
    },
    lane: {
      mode: 'dedicated'
    }
  },

  delivery: {
    conversation: {
      enabled: true,
      sessionId: context.sessionId
    },
    notification: {
      enabled: true
    }
  }
}
```

### 核心规则

> **在哪个 Conversation 中创建的 Automation，默认就投递回哪个 Conversation。**

---

# 8. 不要让 Scheduled Agent 直接恢复主对话 Lane

当前 Scheduler 使用 Dedicated Lane 的设计应该保留。

错误做法：

```text
Scheduler
    ↓
恢复 Main Lane
    ↓
直接执行
```

这种设计可能造成：

- 用户正与 Agent 对话时，后台 Scheduler 同时写入
- Main Lane 并发
- Tool 状态冲突
- 上下文污染
- 后台任务改变当前对话执行状态

正确做法：

```text
Main Conversation
      │
      │ 创建 Schedule
      ▼
Schedule
      ▼
Dedicated Scheduled Agent
      ▼
产生最终执行结果
      ▼
DeliveryService
      ▼
Append Message to Conversation
```

即：

> **执行和投递必须解耦。**

---

# 9. 新增 ScheduleDeliveryService

建议新增：

```text
packages/scheduler/src/delivery/
```

例如：

```text
packages/scheduler/src/delivery/types.ts
packages/scheduler/src/delivery/service.ts
packages/scheduler/src/delivery/conversation-delivery.ts
```

接口：

```ts
export interface ScheduleDeliveryService {
  deliver(input: {
    schedule: Schedule;
    run: ScheduleRun;
    content: string;
  }): Promise<ScheduleDeliveryResult>;
}
```

返回结果建议：

```ts
export interface ScheduleDeliveryResult {
  status: 'delivered' | 'failed' | 'skipped';
  channel?: 'conversation' | 'notification';
  messageId?: string;
  error?: string;
}
```

---

# 10. Conversation Delivery 实现

伪代码：

```ts
class DefaultScheduleDeliveryService
  implements ScheduleDeliveryService {

  constructor(
    private readonly conversations: ConversationStore
  ) {}

  async deliver({
    schedule,
    run,
    content
  }: {
    schedule: Schedule;
    run: ScheduleRun;
    content: string;
  }): Promise<ScheduleDeliveryResult> {

    const delivery = schedule.delivery;

    if (!delivery?.conversation?.enabled) {
      return {
        status: 'skipped'
      };
    }

    try {
      const message = await this.conversations.appendMessage(
        delivery.conversation.sessionId,
        {
          role: 'assistant',

          content: [
            {
              type: 'text',
              text: content
            }
          ],

          metadata: {
            source: 'scheduler',

            automation: {
              scheduleId: schedule.id,
              scheduleRunId: run.id,
              name: schedule.name,
              triggeredAt: run.startedAt
            }
          }
        }
      );

      return {
        status: 'delivered',
        channel: 'conversation',
        messageId: message.id
      };

    } catch (error) {
      return {
        status: 'failed',
        channel: 'conversation',
        error: error instanceof Error
          ? error.message
          : String(error)
      };
    }
  }
}
```

---

# 11. 必须持久化 Message，不能只发 Renderer Event

非常重要。

不要只实现：

```ts
renderer.emit(...)
```

因为如果任务执行时：

- Desktop 没打开
- Renderer 被关闭
- 用户切换了页面
- Electron Window 没有激活

消息可能永久丢失。

必须先：

```text
Persist Conversation Message
```

然后再：

```text
emit conversation.message.created
```

因此正确顺序：

```text
Schedule completed
      ↓
ConversationStore.appendMessage()
      ↓
数据库持久化
      ↓
emit event
      ↓
Renderer 实时刷新
```

即使 App 当时完全没有打开，用户下一次进入该 Session 时仍然可以看到 Automation 的执行结果。

---

# 12. Scheduler Message 增加 Metadata

不要把 Scheduler 结果存成无法区分来源的普通 Assistant Message。

建议增加：

```ts
metadata: {
  source: 'scheduler',

  automation: {
    scheduleId: string,
    scheduleRunId: string,
    name: string,
    triggeredAt: string
  }
}
```

例如：

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "西安今天晴到多云，最高气温 34℃。"
    }
  ],
  "metadata": {
    "source": "scheduler",
    "automation": {
      "scheduleId": "sch_xxx",
      "scheduleRunId": "run_xxx",
      "name": "每日天气",
      "triggeredAt": "2026-08-30T00:00:00Z"
    }
  }
}
```

---

# 13. Conversation Renderer 专门渲染 Automation Message

Renderer 可以判断：

```ts
message.metadata?.source === 'scheduler'
```

然后显示为：

```text
┌──────────────────────────────
│ ⏰ 每日天气
│ 自动化 · 今天 08:00
│
│ 西安今天晴到多云，最高温度 34℃……
│
│ 每天 08:00 · 下次明天
└──────────────────────────────
```

和普通 Assistant Message 做轻微视觉区别。

建议至少显示：

- Automation 名称
- 自动化标识
- 执行时间
- 正文
- 查看自动化入口

例如：

```text
⏰ 每日天气
自动化 · 今天 08:00

西安今天晴到多云……

查看自动化 >
```

---

# 14. Automations Settings 页面重新定位

Automations Settings 的定位调整为：

> **Automation 管理后台 + 运行审计页面**

而不是执行结果收件箱。

当前：

```text
运行历史

已完成
8/30/2026 4:17:58 PM

查看结果
------------------
提醒时间到……
```

推荐改成：

```text
运行历史

✓ 已完成
8/30 16:17:58

投递
✓ 已发送至对话

耗时
2.3s

[查看对话] [运行详情]
```

---

# 15. resultPreview 继续保留，但降级为运行详情

`ScheduleRun.resultPreview` 不需要删除。

它仍然非常有价值：

- 调试
- 审计
- Headless 场景
- API 查询
- 投递失败时兜底
- 开发者查看
- 运行历史确认

只是 UI 默认不要直接展开完整结果。

推荐：

```text
运行历史
   ↓
运行详情
   ↓
Result Preview
Error
Provider
Model
Token Usage
Duration
Run ID
```

---

# 16. 增加 Delivery 状态

建议在 `ScheduleRun` 或独立 DeliveryRecord 中保存投递结果。

M1 简单方案：

```ts
interface ScheduleRun {
  // existing fields

  deliveryStatus?: 'pending' | 'delivered' | 'failed' | 'skipped';

  deliveryMessageId?: string;

  deliveryError?: string;
}
```

更完整的 M2：

```ts
interface ScheduleDeliveryRecord {
  id: string;

  scheduleId: string;
  runId: string;

  channel:
    | 'conversation'
    | 'notification'
    | 'email'
    | 'webhook';

  status:
    | 'pending'
    | 'delivered'
    | 'failed'
    | 'skipped';

  destination?: string;

  messageId?: string;

  error?: string;

  createdAt: string;
  deliveredAt?: string;
}
```

M1 不必一开始就新建数据库表，可以先直接将状态记录在 ScheduleRun。

---

# 17. Settings 增加“查看对话”

如果：

```ts
deliveryMessageId != null
```

则显示：

```text
[查看对话]
```

点击后：

```text
打开 Session
    ↓
scrollToMessage(deliveryMessageId)
```

例如：

```text
/session/:sessionId?message=:messageId
```

从而形成双向导航：

```text
Conversation
    ↓
查看自动化
    ↓
Automations Settings

Automations Settings
    ↓
查看对话
    ↓
Conversation Message
```

---

# 18. 执行失败也必须投递

当前失败如果只记录：

```text
ScheduleRun.status = failed
ScheduleRun.error = ...
```

用户很可能完全不知道。

应该将失败同样交给 DeliveryService。

例如：

```text
⚠️ 每日 GitHub Issue 检查未完成

GitHub 授权已失效，需要重新连接 GitHub。

[重新连接]
[查看自动化]
```

因此 Delivery 处理的不应该只有：

```text
completed
```

还需要处理：

```text
failed
waiting_approval
```

---

# 19. waiting_approval 应进入 Conversation

Scheduler 已经存在：

```text
waiting_approval
```

后台任务如果需要用户授权：

```text
ScheduleRun
    ↓
waiting_approval
```

不应该只在 Automations 页面显示：

```text
等待批准
```

应该在来源对话中生成：

```text
🔐 “每日项目检查”需要你的批准

它准备访问 GitHub 私有仓库。

[批准]
[拒绝]
```

批准后：

```text
waiting_approval
    ↓
running
    ↓
completed
    ↓
Delivery
```

这样 Scheduler 才真正具备 Agent Automation 的交互能力。

---

# 20. OS Notification

除了 Conversation Delivery，建议 Desktop 再补一层系统通知。

流程：

```text
Schedule completed
      │
      ├── persist Conversation Message
      │
      └── OS Notification
```

示例：

```text
Jojo

每日天气已完成

西安今天晴到多云，最高 34℃。
```

用户点击通知：

```text
打开 Jojo
    ↓
打开 sessionId
    ↓
定位 deliveryMessageId
```

注意：

> Notification 只是通知入口，Conversation Message 才是真正持久化的用户结果。

---

# 21. Reminder 和 Agent Task 后续可以拆开

目前：

```text
5 分钟后提醒我开会
```

可能会经历：

```text
Scheduler
    ↓
启动 Agent
    ↓
Agent 生成
“提醒时间到了……”
```

其实这种任务不需要 LLM。

未来建议增加：

```ts
target: {
  kind: 'reminder',
  text: '开会'
}
```

然后：

```text
Scheduler
    ↓
ReminderDispatcher
    ↓
DeliveryService
```

不调用模型。

而真正需要推理的：

```text
每天早上总结 GitHub 新 Issue
```

则继续：

```ts
target: {
  kind: 'agent',
  ...
}
```

最终：

```text
Reminder
    ↓
无需 LLM

Agent Automation
    ↓
需要 LLM
```

这样可以降低：

- Token 消耗
- Provider 依赖
- 执行延迟
- 出错概率

这一项可以放到 M2，不阻塞当前改造。

---

# 22. 对 Schedule Contracts 的建议修改

例如：

```ts
export const ScheduleDeliverySchema = z.object({
  conversation: z.object({
    enabled: z.boolean(),
    sessionId: z.string()
  }).optional(),

  notification: z.object({
    enabled: z.boolean()
  }).optional()
});
```

Schedule：

```ts
export const ScheduleSchema = z.object({
  id: z.string(),

  name: z.string(),

  description: z.string().optional(),

  enabled: z.boolean(),

  spec: ScheduleSpecSchema,

  target: ScheduleTargetSchema,

  delivery: ScheduleDeliverySchema.optional(),

  misfire: MisfirePolicySchema,

  concurrency: ScheduleConcurrencySchema,

  nextRunAt: z.string().nullable(),

  lastRunAt: z.string().nullable(),

  revision: z.number(),

  createdBy: SchedulePrincipalSchema,

  createdAt: z.string(),

  updatedAt: z.string(),

  deletedAt: z.string().nullable()
});
```

---

# 23. schedule_create Tool Adapter 修改

对话中创建时自动注入 Delivery：

```ts
async execute(input, context) {
  const parsed = CreateConversationScheduleInput.parse(input);

  return service.create(
    {
      name: parsed.name,

      spec: toScheduleSpec(parsed.schedule),

      target: toScheduleTarget({
        input: parsed,
        sessionId: context.sessionId,
        providerId: options.providerId,
        model: options.model
      }),

      delivery: {
        conversation: {
          enabled: true,
          sessionId: context.sessionId
        },

        notification: {
          enabled: true
        }
      }
    },

    options.principal
  );
}
```

这里不要要求 LLM 传：

```text
delivery.sessionId
```

否则模型可能：

- 传错
- 漏传
- 将结果投递到其他 session
- 被 Prompt Injection 利用

`sessionId` 必须由可信运行时注入。

---

# 24. 安全边界

Delivery 需要遵守一个非常重要的约束：

> Scheduler Tool 不允许模型自行指定任意 `sessionId`。

推荐：

```text
Conversation-created schedule
    ↓
delivery.sessionId = context.sessionId
```

如果将来允许指定其他 Conversation，需要单独 Permission。

否则容易产生：

```text
Prompt Injection
    ↓
schedule_create
    ↓
delivery to another session
```

造成跨会话写入问题。

---

# 25. Scheduled Agent 不开放 Scheduler Mutation Tools

之前的安全原则继续保留：

```text
Main Agent
    ✓ schedule_create
    ✓ schedule_update
    ✓ schedule_delete
    ✓ schedule_run_now

Scheduled Agent
    ✕ schedule_create
    ✕ schedule_update
    ✕ schedule_delete
```

防止：

```text
Schedule A
    ↓
Scheduled Agent
    ↓
schedule_create
    ↓
Schedule B
    ↓
Schedule C
    ↓
无限持久化递归
```

DeliveryService 不改变这个原则。

---

# 26. 推荐开发顺序

## M1：解决当前用户体验问题

优先完成以下 4 项。

### M1.1 Schedule 增加 delivery

```ts
delivery: {
  conversation: {
    enabled: true,
    sessionId: string
  }
}
```

### M1.2 Scheduler 完成后投递 Conversation

```text
ScheduleRun completed
    ↓
ScheduleDeliveryService
    ↓
ConversationStore.appendMessage()
```

### M1.3 Conversation Renderer 支持 scheduler metadata

识别：

```ts
metadata.source === 'scheduler'
```

显示：

```text
自动化 · 每日天气
```

### M1.4 Automations Settings 收起完整结果

默认：

```text
✓ 已完成
✓ 已发送至对话

[查看对话]
[运行详情]
```

只有运行详情显示：

```text
resultPreview
error
```

---

# 27. M1 推荐修改文件

结合 Jojo-Agent 当前结构，预计涉及：

```text
packages/contracts/src/scheduler.ts

packages/scheduler/src/
  delivery/
    types.ts
    service.ts
    conversation-delivery.ts

packages/scheduler/src/index.ts

apps/desktop/src/worker/
  scheduler-runtime.ts
  worker.ts

apps/desktop/src/renderer/
  SchedulerSettings.tsx

Conversation Message Renderer
Conversation Store / Repository
IPC / Event Bridge
```

具体 Conversation 存储相关文件以当前仓库最新结构为准。

---

# 28. M2

M2 再增加：

### 28.1 OS Notification

```text
Conversation + Desktop Notification
```

### 28.2 waiting_approval 对话卡片

```text
批准
拒绝
```

### 28.3 独立 DeliveryRecord

支持：

```text
conversation
notification
email
webhook
Slack
```

### 28.4 Reminder Target

```ts
target.kind = 'reminder'
```

简单提醒不启动 Agent。

### 28.5 Automation Result Card

Conversation 使用专门卡片展示：

```text
⏰ 每日天气
自动化

Result...

查看自动化 >
```

---

# 29. 数据迁移

已有 Schedule 没有 `delivery`。

必须兼容。

建议：

```ts
delivery?: ScheduleDelivery
```

对于历史 Schedule：

```text
delivery == undefined
```

按照：

```text
silent
```

处理。

即：

```ts
if (!schedule.delivery) {
  // legacy schedule
  // 保持原行为，只记录 ScheduleRun
}
```

避免升级之后把历史自动化突然全部写回 Conversation。

用户后续编辑旧任务时，可以选择：

```text
结果发送到对话
```

再补上 Delivery。

---

# 30. UI 设置建议

Automations 编辑页面增加：

```text
结果投递

☑ 发送到创建任务的对话
☑ 完成后显示系统通知
```

第一版可以只读展示：

```text
结果投递
当前对话
```

因为对话创建的任务默认绑定来源会话。

未来支持：

```text
Delivery
○ Conversation
○ Notification
○ Conversation + Notification
○ Silent
```

---

# 31. ScheduleRun 页面建议

运行历史列表：

```text
✓ 已完成
8/30 16:17:58

执行耗时：2.1 s
投递：✓ 已发送至对话

[查看对话]
[运行详情]
```

失败：

```text
✕ 执行失败
8/30 16:17:58

GitHub authentication expired

投递：✓ 已通知用户

[查看对话]
[运行详情]
```

等待批准：

```text
⏳ 等待批准

已发送授权请求至对话

[查看对话]
```

---

# 32. 测试方案

## 32.1 创建

对话：

```text
5 分钟后提醒我测试 Scheduler
```

断言：

```text
Schedule.delivery.conversation.sessionId
==
currentSessionId
```

---

## 32.2 到期执行

触发 Schedule。

断言：

```text
ScheduleRun.status == completed
```

并且：

```text
Conversation 中新增 Assistant Message
```

metadata：

```text
source == scheduler
scheduleId == expected
runId == expected
```

---

## 32.3 App 关闭

1. 创建任务
2. 关闭 Renderer
3. Scheduler 执行
4. 再打开应用

断言：

```text
Conversation 中仍然存在 Scheduler Message
```

---

## 32.4 Delivery 失败

模拟：

```text
ConversationStore.appendMessage() throw
```

断言：

```text
ScheduleRun.execution == completed
deliveryStatus == failed
```

注意：

> Delivery 失败不应该把已经成功执行的 Agent Run 改成 failed。

执行状态和投递状态必须独立。

---

## 32.5 Scheduled Agent 不具备 schedule_create

在 Scheduled Agent tool snapshot 中断言：

```text
schedule_create not exists
schedule_update not exists
schedule_delete not exists
```

---

## 32.6 历史 Schedule

加载无 delivery 的旧 Schedule。

断言：

```text
不会自动写 Conversation
```

---

# 33. 状态模型建议

建议明确区分：

```text
Execution Status
Delivery Status
```

例如：

```text
Execution:
pending
dispatching
running
waiting_approval
completed
failed
cancelled
skipped
interrupted

Delivery:
pending
delivered
failed
skipped
```

可能出现：

```text
Execution = completed
Delivery  = failed
```

这意味着：

> Agent 成功运行，但消息没有成功投递。

不要混成：

```text
ScheduleRun = failed
```

否则后续不好判断问题到底在执行层还是 Delivery 层。

---

# 34. Definition of Done

M1 完成标准：

## Conversation

- [ ] 用户可以在对话中创建 Schedule。
- [ ] Schedule 默认绑定当前 session。
- [ ] Schedule 到期后结果自动写回来源 Conversation。
- [ ] App 关闭时执行结果不会丢失。
- [ ] Conversation 能识别 Scheduler Message。
- [ ] Scheduler Message 有“自动化”来源标记。

## Scheduler

- [ ] Schedule 支持 Delivery 配置。
- [ ] Delivery 不影响 Durable Scheduler 原有执行逻辑。
- [ ] Execution Status 与 Delivery Status 分离。
- [ ] Delivery 失败不会污染已完成 Run 的执行状态。

## Settings

- [ ] Automations 页面仍能看到所有 Schedule。
- [ ] Run History 保留。
- [ ] 默认不展开完整 resultPreview。
- [ ] 显示“已发送至对话 / 投递失败”。
- [ ] 可以点击“查看对话”。

## Security

- [ ] Model 不能自行指定任意 delivery sessionId。
- [ ] delivery sessionId 来自 ToolContext。
- [ ] Scheduled Agent 不具备 Scheduler Mutation Tools。
- [ ] 旧 Schedule 默认不会自动投递。

---

# 35. 最终设计原则

本次改造最重要的产品原则：

> **Automations Settings 是 Automation 的管理和审计界面；Conversation 才是用户创建 Automation 后默认的结果交付界面。**

技术原则：

> **Scheduled Agent 的执行与结果交付必须解耦。**

推荐最终链路：

```text
User
  ↓
Conversation
  ↓
schedule_create
  ↓
ScheduleService
  ↓
Durable Scheduler
  ↓
Dedicated Scheduled Agent
  ↓
ScheduleRun
  ↓
ScheduleDeliveryService
  ↓
Persist Conversation Message
  ↓
Renderer Event
  ↓
User
```

Settings 页面只负责：

```text
管理
审计
调试
状态查看
```

而不是：

```text
用户消息收件箱
```

---

# 36. 推荐落地优先级

建议按如下顺序推进：

```text
P0
├── Schedule.delivery
├── ScheduleDeliveryService
├── Conversation 持久化写入
└── Settings 显示 Delivery 状态

P1
├── Scheduler Message UI
├── 查看对话跳转
└── OS Notification

P2
├── waiting_approval Conversation Card
├── Reminder Target
└── 多 Delivery Channel
```

这样可以用较小改动先解决当前截图中的核心体验问题，同时不破坏现有 Durable Scheduler、IPC、SQLite、Settings 和 Scheduled Agent 执行架构。

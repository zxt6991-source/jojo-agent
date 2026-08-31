# Jojo Agent Channel Abstraction 设计与实现方案

> 目标仓库：`zxt6991-source/jojo-agent`  
> 基线：2026-08-30 `main`  
> 文档状态：Implementation Design / 可直接拆分任务实施  
> 建议首批 Adapter：Telegram + Feishu  
> 核心目标：把 Jojo 从“Desktop / Headless 可调用的 Agent Runtime”扩展为“可通过任意消息渠道持续交互、可主动触达用户的 General Agent Runtime”。

---

## 1. 背景

Jojo 当前已经具备：

- `AgentRuntime` / `RuntimeSession` / `RuntimeLane` / `RunHandle`
- `createJojoRuntime()` Runtime Composition
- `JojoAppService`
- Headless Server / REST / WebSocket / Client SDK
- Permission Governance
- Approval Broker
- Durable Scheduler
- Memory / Hooks / MCP / Skills
- Spawn / Persistent Team / Workflow
- Process Sandbox

当前真正缺失的不是 Agent Core，而是一个稳定的 **Channel Abstraction**：

```text
Telegram
Feishu
WeCom
Discord
CLI
Web
Mobile
Webhook
   │
   ▼
┌───────────────────────┐
│   Channel Abstraction │
└───────────┬───────────┘
            │
            ▼
      Jojo App Service
            │
            ▼
        Agent Runtime
```

Channel 不应成为另一个 Agent Runtime，也不应该让每个平台 Adapter 直接操作 `AgentRuntime`。

本方案的核心思想：

> **Adapter 只负责“平台协议”，Channel Runtime 负责“身份、路由、安全、Session、可靠投递”，Agent Runtime 继续只负责 Agent 执行。**

---

# 2. 设计结论

建议新增三层：

```text
packages/
├── channel-core/
├── channel-runtime/
└── channel-adapters/
```

其中：

```text
channel-core
    ↓
纯协议、类型、Adapter SPI、Capabilities
不依赖 Electron
不依赖 Jojo App Service
不依赖具体 IM SDK

channel-runtime
    ↓
ChannelManager
Binding
Inbound Router
Outbound Delivery
Permission Bridge
Approval Bridge
Scheduler Delivery
SQLite Store
JojoAppService Integration

channel-adapters
    ↓
telegram/
feishu/
以后：
wecom/
dingtalk/
discord/
...
```

最终依赖关系：

```text
                    ┌──────────────────────┐
                    │ channel-adapters     │
                    │ Telegram / Feishu    │
                    └──────────┬───────────┘
                               │ implements
                               ▼
                    ┌──────────────────────┐
                    │ channel-core         │
                    │ Adapter SPI / Types  │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ channel-runtime      │
                    │ Router / Binding     │
                    │ Delivery / Security  │
                    └──────────┬───────────┘
                               │
                 ┌─────────────┼─────────────┐
                 ▼             ▼             ▼
          JojoAppService   Scheduler    Permission
                 │
                 ▼
          AgentRuntime
```

---

# 3. 与 Jojo 现有架构的结合点

## 3.1 不修改 Agent Core

当前：

```ts
createJojoRuntime({
  host,
  providers,
  permissions,
  store,
  tools,
  approval,
  memory,
  hooks,
  runContext,
  telemetry,
  capabilities
})
```

已经提供：

```ts
RuntimeCapability
RuntimeEnvironmentBuilder
addToolSource()
addTools()
addDisposable()
```

因此 Channel 如果需要给 Agent 暴露：

```text
channel_send
channel_targets
```

只需以 `RuntimeCapability` 形式注入。

不应该：

```text
channel -> import packages/agent internal implementation
```

而应该：

```text
channel-runtime
    │
    ├── 调用 JojoAppService 启动 Run
    │
    └── 通过 RuntimeCapability 注入 Channel Tools
```

---

## 3.2 Channel 入站应走 JojoAppService

正确：

```text
Inbound Message
      ↓
Channel Runtime
      ↓
Binding
      ↓
JojoAppService
      ↓
Session / Run
      ↓
AgentRuntime
```

不要：

```text
TelegramAdapter
      ↓
AgentRuntime.start()     X
```

原因：

JojoAppService 已经承担：

- Session 生命周期
- Run Registry
- Transcript
- Approval
- Recovery
- Persistence
- Server Event

Channel 绕开它会重新制造一套 Session/Run 状态。

---

## 3.3 Scheduler 只依赖 Delivery 抽象

现有 Scheduler 已有：

```ts
interface ScheduleDeliveryService {
  deliver(input: {
    schedule: Schedule;
    run: ScheduleRun;
    content: string;
  }): Promise<ScheduleDeliveryResult>;
}
```

这是非常好的扩展点。

不要：

```text
Scheduler
 ├── Telegram SDK
 ├── Feishu SDK
 └── WeCom SDK
```

而应：

```text
Scheduler
    ↓
ScheduleDeliveryService
    ↓
CompositeScheduleDeliveryService
    ├── ConversationDelivery
    ├── NotificationDelivery
    └── ChannelDelivery
            ↓
       ChannelDeliveryService
```

---

# 4. Channel 的职责边界

Channel Runtime 负责：

```text
1. Adapter 生命周期
2. 外部事件标准化
3. 外部用户身份
4. Chat / Thread 身份
5. Pairing / Allowlist
6. Channel ↔ Jojo Session Binding
7. 消息去重
8. Message Queue
9. Run 创建
10. Run 输出回传
11. Approval 交互
12. Outbox
13. Retry
14. Scheduler Delivery
15. Capability Fallback
16. Audit / Metrics
```

Channel Runtime **不负责**：

```text
LLM Provider
Tool Loop
Memory Retrieval
Workflow Engine
Team Engine
MCP
Terminal Sandbox
文件工具
```

这些继续属于现有 Runtime。

---

# 5. 推荐目录

```text
packages/

├── channel-core/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── types.ts
│       ├── adapter.ts
│       ├── capabilities.ts
│       ├── content.ts
│       ├── errors.ts
│       ├── registry.ts
│       └── webhook.ts
│
├── channel-runtime/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       │
│       ├── manager.ts
│       ├── service.ts
│       ├── lifecycle.ts
│       │
│       ├── inbound/
│       │   ├── processor.ts
│       │   ├── dedupe.ts
│       │   ├── auth.ts
│       │   ├── pairing.ts
│       │   ├── router.ts
│       │   └── queue.ts
│       │
│       ├── outbound/
│       │   ├── service.ts
│       │   ├── formatter.ts
│       │   ├── chunker.ts
│       │   ├── outbox.ts
│       │   └── retry.ts
│       │
│       ├── binding/
│       │   ├── service.ts
│       │   └── types.ts
│       │
│       ├── approval/
│       │   ├── bridge.ts
│       │   └── action-token.ts
│       │
│       ├── scheduler/
│       │   └── delivery.ts
│       │
│       ├── permission/
│       │   └── bridge.ts
│       │
│       ├── runtime/
│       │   ├── capability.ts
│       │   ├── tools.ts
│       │   └── run-context.ts
│       │
│       ├── store/
│       │   ├── store.ts
│       │   ├── sqlite-store.ts
│       │   └── schema.ts
│       │
│       └── telemetry/
│           └── events.ts
│
└── channel-adapters/
    ├── package.json
    └── src/
        ├── index.ts
        ├── telegram/
        │   ├── adapter.ts
        │   ├── config.ts
        │   ├── inbound.ts
        │   └── outbound.ts
        └── feishu/
            ├── adapter.ts
            ├── config.ts
            ├── webhook.ts
            ├── inbound.ts
            └── outbound.ts
```

如果后续单个 Adapter 依赖变重，再拆：

```text
channel-adapter-telegram
channel-adapter-feishu
channel-adapter-wecom
```

第一阶段没必要过度拆包。

---

# 6. Channel Core 数据模型

## 6.1 Adapter 标识

不要只用：

```text
platform = telegram
```

必须区分 **平台类型** 和 **Bot 实例**。

例如：

```text
telegram
 ├── personal_bot
 └── company_bot
```

建议：

```ts
export type ChannelKind =
  | 'telegram'
  | 'feishu'
  | 'wecom'
  | 'dingtalk'
  | 'discord'
  | (string & {});

export type ChannelInstanceId = string;
```

---

# 7. ChannelAdapter SPI

推荐：

```ts
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  readonly instanceId: ChannelInstanceId;
  readonly capabilities: ChannelCapabilities;

  validateConfig(): Promise<ChannelValidationResult>;

  start(context: ChannelAdapterContext): Promise<void>;

  stop(): Promise<void>;

  send(
    request: ChannelSendRequest
  ): Promise<ChannelSendReceipt>;

  edit?(
    request: ChannelEditRequest
  ): Promise<ChannelSendReceipt>;

  setTyping?(
    request: ChannelTypingRequest
  ): Promise<void>;

  handleWebhook?(
    request: ChannelWebhookRequest
  ): Promise<ChannelWebhookResponse>;
}
```

注意：

> 不建议复制 Octo 那种不断扩大的 `SendText / SendFile / SendButtons / UpdateMessage / SendTyping...` 方法集合。

Jojo 更适合：

```text
一个 send(structured message)
+
Capabilities
+
少量 optional operation
```

这样 Adapter 接口不会随着平台能力增加不断膨胀。

---

# 8. ChannelCapabilities

```ts
export type ChannelCapabilities = {
  inbound: {
    text: boolean;
    markdown: boolean;
    image: boolean;
    file: boolean;
    voice: boolean;
    video: boolean;
    interaction: boolean;
    thread: boolean;
  };

  outbound: {
    text: boolean;
    markdown: boolean;
    image: boolean;
    file: boolean;
    buttons: boolean;
    edit: boolean;
    typing: boolean;
    thread: boolean;
  };

  limits: {
    maxTextChars?: number;
    maxFileBytes?: number;
    maxButtons?: number;
  };

  transport:
    | 'polling'
    | 'gateway'
    | 'webhook'
    | 'local';
};
```

例如：

```ts
Telegram.capabilities = {
  outbound: {
    markdown: true,
    buttons: true,
    edit: true,
    typing: true,
    ...
  },
  transport: 'polling'
};
```

Channel Runtime 根据 capability 自动：

```text
Markdown
   ↓
Adapter 支持？
   ├─ yes → Markdown
   └─ no  → Plain Text

Buttons
   ↓
支持？
   ├─ yes → Native Button
   └─ no  → 文本命令 fallback
```

---

# 9. 标准化 Inbound Event

所有平台进入 Runtime 前必须转换。

```ts
export type ChannelInboundEvent = {
  id: string;

  kind:
    | 'message'
    | 'interaction'
    | 'reaction'
    | 'system';

  channel: {
    kind: ChannelKind;
    instanceId: ChannelInstanceId;
  };

  conversation: {
    id: string;
    type: 'direct' | 'group';
    threadId?: string;
  };

  sender: {
    id: string;
    displayName?: string;
    isBot?: boolean;
  };

  message?: {
    id: string;
    text?: string;

    content?: ChannelContentBlock[];

    replyTo?: string;

    mentions?: Array<{
      id: string;
      displayName?: string;
    }>;
  };

  interaction?: {
    actionToken: string;
    value?: string;
  };

  receivedAt: string;

  dedupeKey: string;

  security: {
    verified: boolean;
    verificationMethod:
      | 'webhook_signature'
      | 'trusted_gateway'
      | 'polling_api'
      | 'local';
  };
};
```

---

# 10. 不允许 Raw Payload 穿透 Runtime

Octo 当前 `InboundEvent` 中存在：

```go
Raw any
```

Jojo 不建议把这个模式带进 Runtime。

推荐：

```text
Adapter Native Payload
        ↓
Adapter
        ↓
Normalized Event
        ↓
Channel Runtime
```

Raw Payload：

```text
仅 Adapter 内使用
不进入 Agent
默认不持久化
日志只允许脱敏摘要
```

否则容易产生：

```text
平台 Token
内部 URL
Webhook 字段
未知 JSON
```

泄漏进模型上下文的问题。

---

# 11. Channel Content Model

不要直接使用某个平台的：

```text
Telegram MarkdownV2
Feishu Card JSON
Discord Embed
```

统一成：

```ts
export type ChannelContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'markdown';
      text: string;
    }
  | {
      type: 'image';
      source: ChannelMediaSource;
      alt?: string;
    }
  | {
      type: 'file';
      source: ChannelMediaSource;
      name: string;
      mimeType?: string;
    }
  | {
      type: 'actions';
      buttons: ChannelActionButton[];
    };

export type ChannelActionButton = {
  label: string;
  actionToken: string;
  style?: 'default' | 'primary' | 'danger';
};

export type ChannelMediaSource =
  | { kind: 'local_file'; path: string }
  | { kind: 'buffer'; mimeType: string; data: Uint8Array };
```

Adapter 决定如何渲染。

---

# 12. Outbound Envelope

```ts
export type ChannelAddress = {
  instanceId: string;
  conversationId: string;
  threadId?: string;
};

export type ChannelSendRequest = {
  id: string;

  target: ChannelAddress;

  content: ChannelContentBlock[];

  replyTo?: string;

  correlation?: {
    sessionId?: string;
    runId?: string;
    scheduleId?: string;
    scheduleRunId?: string;
    approvalId?: string;
  };

  mode?: 'reply' | 'proactive' | 'system';
};
```

`mode` 很重要。

---

# 13. 三种 Outbound 权限语义

必须明确区分：

## 13.1 reply

用户：

```text
Telegram → Jojo
```

Agent 正常回答：

```text
Jojo → Telegram
```

这是当前请求的自然响应。

不应再次弹：

```text
“是否允许 Jojo 给 Telegram 用户回复？”
```

因此：

```text
mode = reply
```

由 Channel Runtime 自动发送。

---

## 13.2 proactive

Agent Tool：

```text
channel_send(
  target = 某个飞书群,
  message = ...
)
```

属于外部副作用。

必须进入 Permission Governance：

```text
actor    = agent
source   = runtime
tool     = channel_send
operation= channel.send
risk     = medium
resource = channel://feishu/company_bot/oc_xxx
```

默认建议：

```text
ASK
```

---

## 13.3 system

例如：

```text
Scheduler
Approval
Run failed
Pairing response
```

由系统服务发出。

不应伪装成 Agent Tool。

其授权来源来自：

```text
Scheduler 配置
Binding 配置
Owner 配置
```

而不是当前 Agent 自己决定。

---

# 14. Adapter Registry

```ts
export interface ChannelAdapterFactory {
  readonly kind: ChannelKind;

  create(input: {
    instance: ChannelInstance;
    secrets: ChannelSecretResolver;
  }): Promise<ChannelAdapter>;
}
```

Registry：

```ts
export class ChannelAdapterRegistry {
  private readonly factories = new Map<
    ChannelKind,
    ChannelAdapterFactory
  >();

  register(factory: ChannelAdapterFactory): void;

  get(kind: ChannelKind): ChannelAdapterFactory;

  list(): ChannelKind[];
}
```

Host 装配：

```ts
registry.register(createTelegramAdapterFactory());
registry.register(createFeishuAdapterFactory());
```

以后插件可以动态注册。

---

# 15. Channel Instance

Adapter 配置不等于 Binding。

例如：

```ts
export type ChannelInstance = {
  id: string;

  kind: ChannelKind;

  name: string;

  enabled: boolean;

  config: Record<string, unknown>;

  secretRefs: Record<string, string>;

  revision: number;

  fingerprint: string;

  createdAt: string;
  updatedAt: string;
};
```

例：

```json
{
  "id": "chinst_personal_telegram",
  "kind": "telegram",
  "name": "Personal Telegram",
  "enabled": true,
  "config": {
    "polling": true
  },
  "secretRefs": {
    "botToken": "secret://channels/telegram/personal/token"
  }
}
```

Token 不进普通 JSON。

继续复用 Jojo 的：

```text
SecretReference
Desktop Secret Broker
安全存储
```

---

# 16. Channel Binding

这是整个系统最重要的数据结构之一。

```ts
export type ChannelBinding = {
  id: string;

  instanceId: string;

  conversation: {
    id: string;
    threadId?: string;
    type: 'direct' | 'group';
  };

  routing: {
    sessionMode:
      | 'persistent'
      | 'per_thread'
      | 'stateless';

    sessionId?: string;

    workspaceRoot?: string;

    providerId?: string;
    model?: string;

    instructions?: string[];

    profile?: string;
  };

  policy: {
    enabled: boolean;

    requireMention: boolean;

    queueMode:
      | 'queue'
      | 'reject'
      | 'interrupt';

    allowedSenders?: string[];

    allowAttachments: boolean;
  };

  revision: number;
};
```

---

# 17. 推荐的 Session 绑定策略

## 私聊

默认：

```text
Telegram DM
    ↓
一个固定 Jojo Session
```

即：

```text
sessionMode = persistent
```

用户会得到真正的长期 Agent 对话体验。

---

## 群聊

默认：

```text
Group
    ↓
Thread
    ↓
Jojo Session
```

推荐：

```text
sessionMode = per_thread
```

同时：

```text
requireMention = true
```

避免 Jojo 监听群里每句话。

---

## Stateless

用于：

```text
Webhook
告警机器人
命令式集成
```

每条消息：

```text
new session
 → run
 → result
 → close/archive
```

---

# 18. 外部身份模型

不要把：

```text
Telegram User ID
```

直接当成本地 Jojo User。

定义：

```ts
export type ChannelPrincipal = {
  id: string;

  type: 'channel_user';

  channelKind: string;
  instanceId: string;
  externalUserId: string;

  conversationId: string;

  trusted: boolean;
};
```

转换成 Runtime 上下文：

```text
actor:
channel-user:telegram:personal_bot:123456

trigger:
channel_message

source:
channel
```

这样现有 Permission Governance 就可以按：

```text
actor
trigger
source
```

写规则。

---

# 19. Inbound 完整流程

```text
Telegram / Feishu
       │
       ▼
┌───────────────┐
│ Adapter       │
└───────┬───────┘
        │ normalize
        ▼
┌─────────────────────┐
│ ChannelManager      │
└─────────┬───────────┘
          │
          ▼
    Signature / Trust
          │
          ▼
        Dedupe
          │
          ▼
      Rate Limit
          │
          ▼
 Pairing / Allowlist
          │
          ▼
       Binding
          │
          ▼
     Mention Policy
          │
          ▼
    Conversation Queue
          │
          ▼
      Resolve Session
          │
          ▼
     JojoAppService
          │
          ▼
       startRun()
          │
          ▼
      Agent Runtime
          │
          ▼
     Assistant Output
          │
          ▼
  Channel Delivery
```

---

# 20. 为什么需要 Conversation Queue

IM 用户可能连续发送：

```text
消息 A
消息 B
消息 C
```

而 A 仍然运行中。

如果直接并发：

```text
Run A
Run B
Run C
```

会破坏 Session 顺序。

必须有：

```ts
ChannelConversationQueue
```

key：

```text
bindingId + conversationId + threadId
```

默认：

```text
queue
```

即：

```text
A run
 ↓
B run
 ↓
C run
```

可配置：

```text
queue
interrupt
reject
```

建议第一版仅正式支持：

```text
queue
```

其他模式后续开放。

---

# 21. Message Dedupe

平台可能重复推送。

使用：

```text
instanceId
+
external message id
```

生成：

```text
dedupeKey
```

写入：

```text
channel_inbound_events
```

唯一索引：

```sql
UNIQUE(instance_id, dedupe_key)
```

流程：

```text
收到事件
 ↓
INSERT dedupe
 ↓
成功 → 处理
冲突 → 已处理，ACK 后退出
```

不要只在内存里去重。

---

# 22. Pairing：默认拒绝陌生用户执行 Agent

这是 General Agent 必须有的安全边界。

陌生 Telegram 用户第一次发消息：

```text
Hello
```

不应该直接获得：

```text
Terminal
MCP
Memory
Workspace
```

推荐：

```text
Unknown User
     ↓
Pairing Pending
     ↓
返回 Pairing Code
     ↓
Owner 在 Desktop/Web 批准
     ↓
建立 Binding / Allowlist
```

状态：

```ts
type PairingState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired';
```

Pairing 记录：

```text
instance
conversation
sender
code hash
expiresAt
```

---

# 23. 默认安全策略

建议：

## DM

```text
unknown user:
pairing required

approved user:
can start run
```

## Group

必须：

```text
group explicitly bound
AND
sender allowed
AND
bot mentioned
```

才触发 Agent。

## Webhook

必须：

```text
signature verified
AND
binding configured
```

---

# 24. Attachments

Inbound 附件必须进入隔离流程：

```text
Adapter
  ↓
download
  ↓
size check
  ↓
mime check
  ↓
temp quarantine
  ↓
normalized attachment
  ↓
RuntimeInput
```

限制建议：

```text
图片：20 MB
普通文件：50 MB
单消息总量：80 MB
文件数：10
```

禁止 Adapter 自己随意写：

```text
workspace/
```

默认写：

```text
~/.jojo/runtime/channel-cache/<event-id>/
```

并由 Runtime 决定是否读取。

---

# 25. Outbound Formatter

Agent 输出可能很长。

Channel Runtime 需要：

```text
Markdown Normalizer
       ↓
Capability Downgrade
       ↓
Chunker
       ↓
Adapter
```

例如：

```text
Agent Markdown
   ↓
Telegram Markdown renderer
   ↓
超过 maxTextChars
   ↓
chunk 1
chunk 2
chunk 3
```

Chunking 必须：

```text
优先按段落
其次按换行
再次按句子
最后硬切
```

不能直接：

```ts
text.slice(0, 4096)
```

否则会切坏 Markdown code block。

---

# 26. Streaming

不要把每个 token 都发送给 IM。

策略：

## 支持 Edit 的平台

```text
send placeholder
     ↓
每 700~1200 ms 合并一次
     ↓
edit message
     ↓
final flush
```

## 不支持 Edit

```text
typing on
    ↓
等待最终答案
    ↓
send final chunks
    ↓
typing off
```

第一阶段推荐：

```text
只实现 final answer
```

第二阶段再加入 streaming edit。

---

# 27. Durable Outbox

不能：

```text
Agent 完成
 ↓
adapter.send()
 ↓
进程崩溃
 ↓
结果丢失
```

需要：

```text
Agent Output
     ↓
persist outbox
     ↓
send worker
     ↓
adapter
     ↓
mark delivered
```

表：

```sql
channel_outbox
```

核心字段：

```text
id
instance_id
conversation_id
thread_id
payload_json
mode
idempotency_key
status
attempt_count
next_attempt_at
created_at
delivered_at
last_error
```

状态：

```text
pending
sending
delivered
failed
unknown
```

---

# 28. 为什么要有 unknown 状态

外部 API 场景可能发生：

```text
POST Telegram
      ↓
网络断开
      ↓
不知道 Telegram 是否已经收到
```

此时盲目 retry 可能重复发送。

因此：

```text
明确 5xx / timeout before write
    → retry

明确 4xx
    → failed

请求已发出但 response 不确定
    → unknown
```

后续根据 Adapter 能力决定是否安全重试。

---

# 29. Permission Governance 集成

新增 Resource：

```text
channel://<kind>/<instance>/<conversation>
```

例如：

```text
channel://feishu/company/oc_abc
```

新增 operation：

```text
channel.send
channel.send_file
channel.manage
channel.bind
channel.approval.resolve
```

Agent 主动调用：

```text
channel_send
```

Permission Request：

```ts
{
  actor: 'agent',
  trigger: 'tool_call',
  source: 'runtime',

  tool: 'channel_send',
  operation: 'channel.send',

  risk: 'medium',

  resource: {
    scope: 'channel://feishu/company/oc_abc'
  }
}
```

---

# 30. reply 不走 Tool Permission

再次强调：

```text
用户发消息
 ↓
Agent 回答用户
```

这是 Channel transport 自身的 response。

如果也走：

```text
channel_send tool approval
```

体验会变成：

```text
用户：你好
机器人：是否允许回复“你好”？
```

这是错误设计。

---

# 31. channel_send Tool

用于真正主动发送。

建议工具：

```text
channel_list_targets
channel_send
```

不建议一开始暴露：

```text
channel_delete_message
channel_manage_instance
channel_bind
channel_unbind
```

管理动作应该由 Desktop / Server API 完成。

Tool Schema：

```ts
channel_send({
  target: {
    bindingId?: string,
    instanceId?: string,
    conversationId?: string,
    threadId?: string
  },

  text?: string,

  attachments?: [...],

  replyTo?: string
})
```

优先让模型使用：

```text
bindingId
```

而不是记平台内部 chat id。

---

# 32. Approval Bridge

Channel 最大价值之一是远程审批。

例如 Agent 在 Telegram 中执行：

```bash
git push
```

Jojo Permission Governance 返回 Approval。

Channel Runtime：

```text
Approval Required
       ↓
ApprovalBridge
       ↓
Telegram Buttons

[允许一次]
[拒绝]
```

用户点击：

```text
interaction event
      ↓
Action Token
      ↓
ApprovalBridge
      ↓
JojoAppService.resolveApproval()
```

---

# 33. Approval Action 不要把 approvalId 直接暴露

不要：

```text
callback_data = approval:abc123:allow
```

推荐生成随机一次性 Token：

```text
act_7jfj29...
```

数据库：

```text
action_token
intent
approval_id
allowed_user
expires_at
used_at
```

点击后：

```text
token lookup
 ↓
sender check
 ↓
TTL check
 ↓
one-time consume
 ↓
resolveApproval
```

避免：

```text
伪造 callback
跨用户批准
重放
```

---

# 34. 不要使用“下一条文本当审批”

不要实现：

```text
Agent asks approval
 ↓
用户下一条消息 “yes”
 ↓
当作 approval
```

因为非常容易：

```text
approval pending

用户：
“顺便帮我看看 README”

系统误判：
allow
```

支持按钮的平台用按钮。

不支持按钮：

```text
/approve X7K2
/deny X7K2
```

显式命令。

---

# 35. Scheduler Delivery 扩展

当前：

```ts
export type ScheduleDelivery = {
  conversation?: {
    enabled: boolean;
    sessionId: string;
  };

  notification?: {
    enabled: boolean;
  };
};
```

建议兼容扩展：

```ts
export type ScheduleChannelDelivery = {
  enabled: boolean;

  bindingId: string;

  mode?: 'full' | 'preview';
};

export type ScheduleDelivery = {
  conversation?: {
    enabled: boolean;
    sessionId: string;
  };

  notification?: {
    enabled: boolean;
  };

  channels?: ScheduleChannelDelivery[];
};
```

这里使用：

```text
bindingId
```

而不是：

```text
platform + chatId
```

好处：

Binding 可以独立更新：

```text
Telegram chat 迁移
Bot instance 更换
Thread 配置改变
```

Scheduler 不需要修改。

---

# 36. ChannelScheduleDeliveryService

```ts
export class ChannelScheduleDeliveryService
  implements ScheduleDeliveryService {

  constructor(
    private readonly channels: ChannelDeliveryService
  ) {}

  async deliver(input: {
    schedule: Schedule;
    run: ScheduleRun;
    content: string;
  }): Promise<ScheduleDeliveryResult> {

    const targets =
      input.schedule.delivery?.channels ?? [];

    if (targets.length === 0) {
      return {
        status: 'skipped'
      };
    }

    // resolve binding
    // enqueue durable outbox
    // await/track delivery
  }
}
```

更推荐最终组合：

```text
CompositeScheduleDelivery
    ├── Conversation
    ├── Desktop Notification
    └── External Channel
```

---

# 37. Schedule 创建时完成授权

Scheduler 不能每次运行都弹：

```text
允许给飞书发送吗？
```

正确语义：

```text
创建 Schedule
      ↓
用户确认：
每天 9:00
发送到 Feishu / Team A
      ↓
持久化 delivery binding + fingerprint
      ↓
执行时按授权配置发送
```

但是运行时仍检查：

```text
binding still enabled?
instance still trusted?
fingerprint still valid?
target not deleted?
```

配置安全身份改变时：

```text
暂停 delivery
要求重新确认
```

这和 Jojo MCP Server 指纹信任模型一致。

---

# 38. Scheduler 结果示例

用户：

```text
每天上午 9 点总结 GitHub 项目变化，
发到我的飞书。
```

生成：

```text
Schedule
├── spec
│   └── cron
├── target
│   └── agent
└── delivery
    └── channels
        └── bindingId = feishu_me
```

执行：

```text
09:00
 ↓
Scheduler
 ↓
Agent Run
 ↓
Result
 ↓
ChannelScheduleDelivery
 ↓
Durable Outbox
 ↓
Feishu Adapter
 ↓
飞书
```

这样：

> Scheduler + Channel 才形成真正的主动 Agent。

---

# 39. ChannelManager

```ts
export interface ChannelManager {
  start(): Promise<void>;

  stop(): Promise<void>;

  listInstances(): Promise<ChannelInstance[]>;

  reloadInstance(
    instanceId: string
  ): Promise<void>;

  handleWebhook(
    instanceId: string,
    request: ChannelWebhookRequest
  ): Promise<ChannelWebhookResponse>;

  send(
    input: ChannelDeliveryInput
  ): Promise<ChannelDeliveryReceipt>;

  subscribe(
    listener: (event: ChannelRuntimeEvent) => void
  ): () => void;
}
```

---

# 40. Lifecycle

Server 启动：

```text
createHeadlessServer()
       ↓
createJojoRuntime()
       ↓
createJojoAppService()
       ↓
createChannelManager()
       ↓
load enabled instances
       ↓
create adapters
       ↓
start polling/gateway adapters
```

停止：

```text
stop accepting inbound
 ↓
stop adapters
 ↓
drain queues
 ↓
flush outbox
 ↓
close store
 ↓
close app service
```

---

# 41. Webhook Adapter

Feishu 这种平台需要 HTTP Webhook。

不要让 Feishu Adapter：

```text
启动自己的 Express Server
```

而应由现有 `server-http` 挂统一 route：

```text
POST /api/v1/channels/webhook/:instanceId
```

流程：

```text
server-http
    ↓
ChannelManager.handleWebhook()
    ↓
adapter.handleWebhook()
```

Adapter 返回：

```ts
export type ChannelWebhookResponse = {
  status: number;

  headers?: Record<string, string>;

  body?: unknown;
};
```

这样：

```text
Server HTTP 生命周期
```

仍然只有一套。

---

# 42. Headless Server Protocol 扩展

`ServerCapabilities` 新增：

```ts
channels: {
  enabled: boolean;

  kinds: string[];

  inbound: boolean;

  outbound: boolean;

  approvals: boolean;
};
```

新增 Scopes：

```text
channels:read
channels:write
channels:send
channels:bind
channels:approve
```

---

# 43. Server API

建议：

```text
GET    /api/v1/channels
GET    /api/v1/channels/:id
POST   /api/v1/channels
PATCH  /api/v1/channels/:id
DELETE /api/v1/channels/:id

POST   /api/v1/channels/:id/test

GET    /api/v1/channel-bindings
POST   /api/v1/channel-bindings
PATCH  /api/v1/channel-bindings/:id
DELETE /api/v1/channel-bindings/:id

GET    /api/v1/channel-pairings
POST   /api/v1/channel-pairings/:id/approve
POST   /api/v1/channel-pairings/:id/reject

GET    /api/v1/channel-deliveries
GET    /api/v1/channel-deliveries/:id

POST   /api/v1/channels/webhook/:instanceId
```

注意：

Webhook route 不走普通 User Bearer Token。

它走：

```text
Adapter Signature Verification
```

---

# 44. Server Core 不要实现平台逻辑

`server-core` 只新增：

```text
ChannelService
```

类似：

```ts
export interface ChannelAdminService {
  listInstances(...): ...;
  createInstance(...): ...;
  listBindings(...): ...;
  ...
}
```

`server-core` 负责：

```text
scope authorization
idempotency
protocol conversion
```

不负责：

```text
Telegram API
Feishu signature
message parsing
```

---

# 45. Desktop 设置页

建议增加：

```text
Settings
 └── Channels
      ├── Instances
      ├── Bindings
      ├── Pairing
      ├── Deliveries
      └── Security
```

Instance Card：

```text
Telegram Personal
Status: Connected
Transport: Polling
Bot: @jojo_xxx_bot

[Disable]
[Test]
[Edit]
```

Binding：

```text
Telegram / My DM
→ Session: Personal Assistant
→ Workspace: none
→ Mention: no
→ Sender: only me
```

---

# 46. SQLite Schema

推荐：

## channel_instances

```sql
CREATE TABLE channel_instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  secret_refs_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## channel_bindings

```sql
CREATE TABLE channel_bindings (
  id TEXT PRIMARY KEY,

  instance_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL,
  thread_id TEXT,
  conversation_type TEXT NOT NULL,

  session_mode TEXT NOT NULL,
  session_id TEXT,

  workspace_root TEXT,
  provider_id TEXT,
  model TEXT,

  routing_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,

  revision INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY(instance_id)
    REFERENCES channel_instances(id)
);
```

唯一键：

```sql
UNIQUE(
  instance_id,
  conversation_id,
  thread_id
)
```

---

## channel_inbound_events

```sql
CREATE TABLE channel_inbound_events (
  id TEXT PRIMARY KEY,

  instance_id TEXT NOT NULL,

  dedupe_key TEXT NOT NULL,

  sender_id TEXT,

  conversation_id TEXT NOT NULL,

  received_at TEXT NOT NULL,

  status TEXT NOT NULL,

  error TEXT,

  UNIQUE(instance_id, dedupe_key)
);
```

---

## channel_outbox

```sql
CREATE TABLE channel_outbox (
  id TEXT PRIMARY KEY,

  instance_id TEXT NOT NULL,
  binding_id TEXT,

  conversation_id TEXT NOT NULL,
  thread_id TEXT,

  payload_json TEXT NOT NULL,

  mode TEXT NOT NULL,

  correlation_json TEXT,

  status TEXT NOT NULL,

  attempt_count INTEGER NOT NULL,

  next_attempt_at TEXT,

  created_at TEXT NOT NULL,
  delivered_at TEXT,

  native_message_id TEXT,

  last_error TEXT
);
```

索引：

```sql
CREATE INDEX idx_channel_outbox_pending
ON channel_outbox(status, next_attempt_at);
```

---

## channel_action_tokens

```sql
CREATE TABLE channel_action_tokens (
  token_hash TEXT PRIMARY KEY,

  action_type TEXT NOT NULL,

  payload_json TEXT NOT NULL,

  allowed_sender_id TEXT,

  expires_at TEXT NOT NULL,

  used_at TEXT
);
```

---

## channel_pairings

```sql
CREATE TABLE channel_pairings (
  id TEXT PRIMARY KEY,

  instance_id TEXT NOT NULL,

  conversation_id TEXT NOT NULL,

  sender_id TEXT NOT NULL,

  code_hash TEXT NOT NULL,

  status TEXT NOT NULL,

  expires_at TEXT NOT NULL,

  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

---

# 47. 数据库存放

建议：

```text
~/.jojo/runtime/channels.sqlite
```

不要放：

```text
workspace/.jojo/
```

原因：

项目仓库不能通过提交配置：

```text
给自己增加远程用户
给自己增加外发目标
给自己开启 Bot
```

与现有 Permission Governance 原则一致：

> 项目文件不能自我授权。

---

# 48. Secrets

Channel config：

```text
botToken
appSecret
verificationToken
webhookSecret
```

全部使用：

```text
SecretReference
```

不允许：

```json
{
  "botToken": "123456:ABC..."
}
```

写进普通 SQLite JSON。

推荐：

```json
{
  "botToken": "secret://channel/telegram/personal/token"
}
```

---

# 49. Telegram Adapter

第一版推荐：

```text
Long Polling
```

原因：

```text
不用公网 IP
不用反向代理
不用证书
最适合 Desktop / Local-first
```

Inbound：

```text
getUpdates
 ↓
message
callback_query
 ↓
normalize
```

Outbound：

```text
sendMessage
editMessageText
sendDocument
sendPhoto
sendChatAction
```

能力：

```text
buttons    yes
edit       yes
typing     yes
markdown   yes
thread     partial
```

---

# 50. Feishu Adapter

推荐支持：

```text
Webhook/Event Subscription
```

如果后续需要 Desktop 本地无公网：

```text
再加入长连接模式
```

Inbound：

```text
message.receive_v1
card.action.trigger
```

必须验证：

```text
verification token
signature / encrypt key（按选择的接入模式）
```

Outbound：

```text
text
interactive card
file/image
```

Approval 优先：

```text
interactive card buttons
```

---

# 51. Adapter 开发约束

所有 Adapter 必须满足：

```text
1. 不 import Agent Runtime
2. 不 import Permission Governance
3. 不直接写 Jojo Session
4. 不直接写 Workspace
5. 不保存明文 Secret
6. 不决定用户是否有权限
7. 不决定 Session Routing
8. 不自己实现 Scheduler
```

Adapter 只做：

```text
platform protocol ↔ channel-core model
```

---

# 52. Runtime Run Context

Channel 启动 Run 时必须注入：

```ts
{
  trigger: 'channel_message',

  source: {
    kind: 'channel',

    channelKind: 'telegram',

    instanceId: 'personal',

    conversationId: '123456',

    externalUserId: '9988'
  }
}
```

Permission Governance 就可以出现：

```json
{
  "match": {
    "trigger": "channel_message",
    "source": "channel",
    "actor": "channel-user:telegram:personal:9988"
  },

  "effect": "ASK"
}
```

---

# 53. Channel Session 默认权限

即使用户已经 Pairing：

```text
Pairing != Terminal Full Access
```

建议 Channel Session 默认：

```text
普通文件只读        ALLOW
web_search          ALLOW
memory              normal policy

write/edit           ASK
terminal             ASK
MCP side effect      ASK
channel proactive    ASK
```

不要：

```text
Pairing 后自动 YOLO
```

---

# 54. Binding 可指定 Execution Scope

例如：

```text
Telegram / Personal DM
   ↓
Workspace = ~/Projects/foo
```

必须由本地 Owner 显式创建。

外部用户不能通过：

```text
“把 workspace 切换到 /”
```

改变 Binding。

因此：

```text
Channel Message
```

只能影响 Agent 输入，不能修改：

```text
workspaceRoot
binding
permission mode
channel target
```

这些属于 Host Control Plane。

---

# 55. Channel Control Plane 与 Data Plane

建议明确分开。

## Control Plane

```text
Desktop
Web Admin
Server API
```

负责：

```text
Instance
Secret
Binding
Pairing
Policy
Enable/Disable
```

## Data Plane

```text
Telegram
Feishu
...
```

只负责：

```text
message
interaction
attachment
reply
```

外部消息不允许修改 Control Plane。

---

# 56. Channel Runtime Event

```ts
export type ChannelRuntimeEvent =
  | {
      type: 'channel.instance.status';
      instanceId: string;
      status:
        | 'starting'
        | 'connected'
        | 'degraded'
        | 'stopped'
        | 'failed';
      error?: string;
    }
  | {
      type: 'channel.inbound.received';
      eventId: string;
      instanceId: string;
    }
  | {
      type: 'channel.run.started';
      eventId: string;
      sessionId: string;
      runId: string;
    }
  | {
      type: 'channel.delivery.changed';
      deliveryId: string;
      status: string;
    }
  | {
      type: 'channel.pairing.created';
      pairingId: string;
    };
```

Server WebSocket 可以直接推。

---

# 57. Observability

关键 Metrics：

```text
channel_inbound_total
channel_inbound_duplicate_total
channel_inbound_rejected_total

channel_run_total
channel_run_latency_ms

channel_delivery_total
channel_delivery_failed_total
channel_delivery_retry_total

channel_adapter_reconnect_total

channel_pairing_pending

channel_queue_depth
```

日志必须包含：

```text
instanceId
bindingId
conversation hash
runId
deliveryId
```

不要默认记录：

```text
完整消息正文
Token
Attachment 内容
```

---

# 58. Rate Limit

必须至少提供：

```text
per sender
per conversation
per instance
```

建议默认：

```text
DM：
20 messages / minute

Group：
30 triggers / minute

unknown sender：
5 messages / 10 minutes
```

Pairing endpoint 也需要 rate limit。

---

# 59. Adapter Reconnect

Polling / Gateway：

```text
1s
2s
4s
8s
...
60s cap
+
jitter
```

状态：

```text
connected
degraded
reconnecting
failed
```

网络错误不应：

```text
kill Jojo Runtime
```

---

# 60. Runtime Capability

用于把 Channel 主动发送工具注入 Agent。

```ts
export class ChannelRuntimeCapability
  implements RuntimeCapability {

  constructor(
    private readonly service: ChannelService
  ) {}

  contribute(
    builder: RuntimeEnvironmentBuilder
  ): void {

    builder.addTools(
      createChannelTools(this.service)
    );
  }
}
```

然后：

```ts
createJojoRuntime({
  ...,

  capabilities: [
    ...existingCapabilities,

    new ChannelRuntimeCapability(
      channelService
    )
  ]
});
```

---

# 61. 避免循环依赖

禁止：

```text
scheduler
   ↓
channel-runtime
   ↓
scheduler
```

正确：

```text
scheduler
   ↓
ScheduleDeliveryService SPI
             ▲
             │ implements
channel-runtime
```

同样：

```text
agent-runtime
```

不能 import `channel-runtime`。

而是：

```text
runtime-composition
```

负责装配。

---

# 62. 推荐依赖图

```text
contracts
   ▲
   │
channel-core
   ▲
   │
channel-adapters

channel-core
   ▲
   │
channel-runtime
   │
   ├── app-service
   ├── permission-governance
   ├── scheduler SPI
   └── storage

runtime-composition
   │
   └── channel RuntimeCapability

apps/server
   │
   ├── channel-runtime
   ├── channel-adapters
   └── server-http

apps/desktop
   │
   └── channel management UI
```

---

# 63. 第一阶段不要做的事情

M1 不做：

```text
微信
企业微信
钉钉
Discord
Slack
Voice Agent
跨设备 Relay
E2EE
复杂群成员权限继承
Bot-to-Bot
Reaction Trigger
完整 Streaming
```

先把抽象做稳定。

---

# 64. 实施阶段

## M0：Contracts / Store

目标：

```text
Channel Core
+
SQLite Persistence
+
Fake Adapter
```

新增：

```text
channel-core
channel-runtime/store
```

完成：

- `ChannelAdapter`
- `ChannelCapabilities`
- `ChannelInboundEvent`
- `ChannelSendRequest`
- `ChannelInstance`
- `ChannelBinding`
- SQLite schema
- Adapter Registry
- FakeAdapter

测试：

```text
contract tests
store tests
dedupe tests
binding tests
```

---

## M1：Inbound → Agent → Reply 闭环

实现：

```text
FakeAdapter
 ↓
Inbound
 ↓
Binding
 ↓
Session
 ↓
JojoAppService
 ↓
Agent Run
 ↓
Final Answer
 ↓
FakeAdapter
```

必须验证：

```text
一个 Channel Chat
=
一个 Persistent Jojo Session
```

以及：

```text
重复平台消息
不会产生重复 Run
```

---

## M2：Telegram

实现：

- Long Polling
- Text
- Image
- File
- Buttons
- Typing
- Edit
- Pairing
- Durable Outbox

达到：

```text
手机 Telegram
      ↓
Jojo Desktop/Server
      ↓
真实 Agent
      ↓
Telegram Reply
```

---

## M3：Remote Approval

接：

```text
Permission Approval
 ↓
Telegram Button
 ↓
Action Token
 ↓
resolveApproval()
```

测试：

```text
wrong user       reject
expired token    reject
replay token     reject
correct user     allow
```

---

## M4：Scheduler Delivery

扩展：

```text
ScheduleDelivery.channels[]
```

实现：

```text
Scheduled Agent
 ↓
ChannelDelivery
 ↓
Telegram
```

这一步之后 Jojo 开始具备：

> 主动 Agent 能力。

---

## M5：Feishu

加入：

- Webhook route
- Signature verification
- Text
- Card
- Buttons
- File
- Binding
- Pairing / allowlist

---

## M6：Server API / Desktop UI

增加：

```text
Channels settings
Bindings
Pairing requests
Delivery history
Health
```

Server Protocol 增加 Channel capabilities 和 scopes。

---

# 65. 建议提交顺序

```text
PR-1
channel-core contracts + registry

PR-2
channel sqlite store + binding

PR-3
channel inbound processor + fake adapter

PR-4
app-service session/run bridge

PR-5
outbound + durable outbox

PR-6
telegram adapter

PR-7
pairing + security

PR-8
approval bridge

PR-9
scheduler channel delivery

PR-10
feishu webhook adapter

PR-11
server protocol/API

PR-12
desktop Channels settings
```

避免一次 PR 修改：

```text
10000+ lines
```

把 Core Contract 先稳定下来。

---

# 66. Contract Tests

每个 Adapter 必须跑同一套测试：

```ts
describeChannelAdapterContract(() => {
  return createAdapter();
});
```

检查：

```text
start/stop idempotent

duplicate inbound handling

send text

chunk limits

unsupported capability fallback

typing optional

button callback normalization

invalid config

secret redaction

shutdown while receiving
```

---

# 67. E2E Tests

## Telegram 不访问真实 API

创建：

```text
FakeTelegramServer
```

模拟 Bot API：

```text
/getUpdates
/sendMessage
/editMessageText
/sendChatAction
```

E2E：

```text
Fake Telegram
 ↓
Telegram Adapter
 ↓
Channel Runtime
 ↓
Scripted Provider
 ↓
Channel Runtime
 ↓
Fake Telegram
```

不需要：

```text
真实 Token
公网
LLM
```

---

# 68. Security Tests

必须专门覆盖：

```text
unknown sender cannot run agent

group without binding ignored

group without mention ignored

duplicate event only runs once

fake interaction token rejected

interaction replay rejected

other sender cannot approve

disabled binding cannot deliver

changed instance fingerprint invalidates trusted delivery

channel message cannot change workspace

channel message cannot create binding

secret never appears in audit

attachment path traversal rejected
```

---

# 69. 与现有 Scheduler 的具体改动

文件：

```text
packages/scheduler/src/types.ts
```

增加：

```ts
export type ScheduleChannelDelivery = {
  enabled: boolean;
  bindingId: string;
  mode?: 'full' | 'preview';
};

export type ScheduleDelivery = {
  conversation?: {
    enabled: boolean;
    sessionId: string;
  };

  notification?: {
    enabled: boolean;
  };

  channels?: ScheduleChannelDelivery[];
};
```

---

`packages/scheduler/src/delivery/types.ts`

当前：

```ts
channel?: 'conversation' | 'notification';
```

不建议继续扩大这个字段为：

```text
telegram
feishu
...
```

改为：

```ts
export type ScheduleDeliveryResult = {
  status:
    | 'delivered'
    | 'failed'
    | 'skipped';

  destination?: {
    kind:
      | 'conversation'
      | 'notification'
      | 'channel';

    id?: string;
  };

  messageId?: string;

  error?: string;
};
```

这是一次结构化升级。

---

# 70. 兼容旧 Schedule

读取时 normalize：

```ts
function normalizeDelivery(
  delivery: LegacyOrCurrentScheduleDelivery
): ScheduleDelivery
```

旧：

```json
{
  "conversation": {
    "enabled": true,
    "sessionId": "s1"
  }
}
```

继续有效。

不要要求用户迁移现有 Scheduler DB。

---

# 71. 与 Permission Governance 的具体改动

建议新增标准 operation constants：

```ts
CHANNEL_SEND
CHANNEL_SEND_FILE
CHANNEL_MANAGE
CHANNEL_BIND
CHANNEL_APPROVAL_RESOLVE
```

Risk：

```text
reply                    system-owned
send current binding     medium
send arbitrary target    medium/high
file outbound            medium/high
manage channel           high
bind workspace           high
```

---

# 72. Current-Conversation Target

Channel Run 中保留：

```ts
type ChannelRunContext = {
  bindingId: string;

  instanceId: string;

  conversationId: string;

  threadId?: string;

  senderId: string;

  inboundMessageId: string;
};
```

这样 Agent 如果调用：

```text
channel_send(target=current)
```

Runtime 能解析。

但仍要区分：

```text
普通 Assistant Reply
```

和：

```text
Tool 主动 send
```

不要混淆。

---

# 73. Jojo Session Metadata

建议在 Session metadata 加：

```ts
channel?: {
  bindingId: string;

  instanceId: string;

  conversationId: string;

  threadId?: string;
};
```

用途：

```text
Desktop 中显示：
“来自 Telegram / Personal”
```

也方便：

```text
恢复
审计
Scheduler
```

但 Session Metadata 只是副本。

真正权威来源：

```text
channel_bindings
```

---

# 74. 多 Channel 同 Session

后续允许：

```text
Telegram
      \
       → Personal Assistant Session
      /
Feishu
```

因此数据结构不要假定：

```text
Session 只能有一个 Channel。
```

Binding：

```text
N Channel Bindings
      ↓
1 Session
```

是合法的。

---

# 75. Channel 与 Memory

第一阶段不要新增：

```text
Channel Memory
```

Channel 只是 Session 入口。

Memory 继续走现有：

```text
Runtime Memory
```

可在 Run Context 提供：

```text
source = channel
```

以后 Memory policy 可以区分：

```text
Desktop conversation
Telegram
Work Feishu
```

---

# 76. Channel 与 Persistent Team

不需要直接耦合。

Inbound：

```text
Channel
 ↓
Main Session
 ↓
Agent
 ↓
team_delegate
```

即可。

以后如果要：

```text
直接把飞书群绑定某个 Team Member
```

可以扩展 Binding：

```ts
routing.target =
  | { kind: 'session' }
  | { kind: 'team_member', teamId, memberId };
```

M1 不做。

---

# 77. Channel 与 Workflow

同理：

```text
Channel Message
      ↓
Agent
      ↓
Workflow Tool
```

M1 不需要：

```text
Channel → Workflow
```

后续可增加 command binding：

```text
/release
    ↓
saved workflow: release
```

但这属于更高层 Routing Rule。

---

# 78. 后续 Routing Rule

V2 可以增加：

```ts
type ChannelRouteRule = {
  match: {
    prefix?: string;
    senderId?: string;
    conversationId?: string;
    mention?: boolean;
  };

  target:
    | { kind: 'agent_session' }
    | { kind: 'workflow'; name: string }
    | { kind: 'team_member'; teamId: string; memberId: string };
};
```

例如：

```text
/deploy staging
 ↓
release-workflow
```

但不要在 M1 就引入。

---

# 79. 失败处理

Inbound 失败：

```text
temporary
    → queue retry

permanent
    → mark failed
    → 可选发送错误摘要
```

Agent Run 失败：

```text
“任务执行失败：xxx”
```

不要把：

```text
完整 stack
API key
内部路径
```

发到群。

Error Renderer 需要做：

```text
userSafeMessage
```

---

# 80. Channel Health

每个 Instance：

```ts
type ChannelInstanceHealth = {
  status:
    | 'starting'
    | 'connected'
    | 'degraded'
    | 'stopped'
    | 'failed';

  lastInboundAt?: string;

  lastOutboundAt?: string;

  lastError?: string;

  reconnectCount: number;
};
```

Desktop 可显示。

---

# 81. 推荐 MVP 验收标准

Channel Abstraction 第一阶段完成的标准不是：

```text
有 Telegram Adapter
```

而是以下全部成立：

```text
[ ] Adapter 与 Agent Runtime 解耦

[ ] 同一 Chat 稳定绑定同一 Jojo Session

[ ] 重复平台事件不会重复创建 Run

[ ] 陌生用户默认不能执行 Agent

[ ] Pairing 后才能进入 Agent

[ ] Group 默认 requireMention

[ ] Agent 正常 reply 不重复审批

[ ] Agent 主动 channel_send 必须走 Governance

[ ] Approval 可以通过安全 Action Token 远程处理

[ ] Scheduler 可以把结果发送到 Channel

[ ] Outbound 有 durable outbox

[ ] Adapter crash 不影响 Runtime

[ ] Restart 后 pending delivery 可恢复

[ ] Secret 不进入普通 config / logs / model

[ ] Channel Session 保留 source / actor / trigger

[ ] Telegram 与 Fake Adapter 通过同一 Contract Test
```

---

# 82. 最终架构

```text
┌─────────────────────────────────────────────┐
│               External World                │
│                                             │
│ Telegram  Feishu  WeCom  Discord  Webhook  │
└───────┬────────┬───────┬────────┬───────────┘
        │        │       │        │
        ▼        ▼       ▼        ▼
┌─────────────────────────────────────────────┐
│              Channel Adapters               │
│                                             │
│ protocol / auth / normalize / send          │
└───────────────────┬─────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│              Channel Runtime                │
│                                             │
│ Manager                                     │
│ ├─ Identity / Pairing                       │
│ ├─ Binding                                  │
│ ├─ Dedupe                                   │
│ ├─ Conversation Queue                       │
│ ├─ Inbound Router                           │
│ ├─ Approval Bridge                          │
│ ├─ Durable Outbox                           │
│ ├─ Delivery                                 │
│ └─ Telemetry                                │
└─────────────┬───────────────────┬───────────┘
              │                   │
              │                   └─────────────┐
              ▼                                 ▼
┌────────────────────────┐          ┌─────────────────────┐
│     JojoAppService     │          │ Durable Scheduler   │
│                        │          │                     │
│ Session                │          │ Schedule            │
│ Run                    │          │ Run                 │
│ Approval               │          │ Delivery SPI        │
│ Transcript             │          └──────────┬──────────┘
└────────────┬───────────┘                     │
             │                                 │
             ▼                                 │
┌────────────────────────┐                     │
│      Agent Runtime     │                     │
│                        │                     │
│ Provider               │                     │
│ Tool Loop              │                     │
│ Memory                 │                     │
│ MCP                    │                     │
│ Workflow               │                     │
│ Team                   │                     │
└────────────┬───────────┘                     │
             │                                 │
             └──────────────┬──────────────────┘
                            ▼
                   ┌──────────────────┐
                   │ Channel Delivery │
                   │ Durable Outbox   │
                   └────────┬─────────┘
                            │
                            ▼
                     External User
```

---

# 83. 最核心的架构原则

整个实现只需要牢记五条：

### 1. Adapter 不是 Agent

```text
Adapter = Protocol Driver
```

---

### 2. Channel 不绕开 AppService

```text
Channel
 ↓
JojoAppService
 ↓
AgentRuntime
```

---

### 3. Binding 是一等公民

不要只保存：

```text
chatId
```

而要：

```text
External Conversation
      ↕
Channel Binding
      ↕
Jojo Session
```

---

### 4. Reply 与 Proactive Send 分开

```text
Reply
= Transport Response

Proactive Send
= External Side Effect
= Permission Governance
```

---

### 5. Scheduler 只看 Delivery SPI

```text
Scheduler
  X Telegram
  X Feishu

Scheduler
  ✓ DeliveryService
        ↓
     Channel
```

---

# 84. 推荐最终 Package API

对其他 Jojo 模块尽量只暴露：

```ts
export interface ChannelService {
  start(): Promise<void>;

  stop(): Promise<void>;

  deliver(
    input: ChannelDeliveryInput
  ): Promise<ChannelDeliveryReceipt>;

  listBindings(): Promise<ChannelBinding[]>;

  getBinding(
    bindingId: string
  ): Promise<ChannelBinding>;

  subscribe(
    listener: (
      event: ChannelRuntimeEvent
    ) => void
  ): () => void;
}
```

其他模块不要直接访问：

```text
TelegramAdapter
FeishuAdapter
SQLiteChannelStore
Pairing internals
```

这能保证以后更换平台 SDK 不影响 Runtime。

---

# 85. 建议优先级

如果按 Jojo 当前状态继续开发：

```text
P0
Channel Core
Binding
Inbound Router
Durable Outbox
Telegram

P0
Remote Approval

P0
Scheduler → Channel Delivery

P1
Feishu

P1
Server API
Desktop Channel Settings

P1
Streaming / Edit

P2
WeCom
DingTalk
Discord

P2
Advanced Routing Rules

P3
Mobile / Relay
```

完成 P0 后，Jojo 的能力会从：

```text
“能在 Desktop / API 中使用的 General Agent”
```

变成：

```text
“能从外部持续接收任务、远程审批、
定时执行并主动把结果送回用户的 General Agent”
```

这才是 Channel Abstraction 对当前 Jojo 最核心的价值。

---

# 86. 参考的现有实现边界

本方案主要基于 Jojo 当前以下代码边界设计：

```text
packages/runtime-composition/src/runtime.ts

packages/app-service/

packages/server-core/src/server.ts

packages/scheduler/src/types.ts

packages/scheduler/src/delivery/

packages/permission-governance/

packages/contracts/
```

参考 Octo 的 Channel 实现时，主要借鉴：

```text
internal/channel/adapter.go
internal/channel/manager.go
internal/channel/bindings.go
internal/channel/chunking.go
internal/channel/notify.go
internal/channel/adapters/
```

但 Jojo 不建议机械复制 Octo 的接口。

Jojo 已有：

```text
Runtime Capability
Permission Governance
App Service
Durable Scheduler
Server Principal/Scope
Idempotency
```

因此应该让 Channel 成为这些现有能力的组合层，而不是在 Channel Manager 里重新实现一套 Agent 产品逻辑。

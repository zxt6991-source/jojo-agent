# Jojo Agent 飞书 WebSocket 长连接接入设计

> 状态：Design Proposal  
> 目标版本：Channel / Feishu P0  
> 更新时间：2026-09-01  
> 适用仓库：`https://github.com/zxt6991-source/jojo-agent`  
> 参考实现：`https://github.com/open-octo/octo-agent`  
> 飞书 Node SDK：`https://github.com/larksuite/node-sdk`

---

## 1. 背景

Jojo Agent 当前已经完成 Channel Abstraction，并实现了 Feishu Adapter，但飞书入站采用 HTTP Webhook：

```text
Feishu Cloud
    │
    │ HTTPS callback
    ▼
Jojo HTTP Server
    │
    │ /api/v1/channels/webhook/:instanceId
    ▼
FeishuChannelAdapter.handleWebhook()
    │
    ├─ Signature verify
    ├─ Verification Token
    ├─ Encrypt Key / AES decrypt
    └─ normalize
    ▼
Channel Runtime
    ▼
Agent
```

当前方案在服务端部署场景没有问题，但 Jojo 的主要定位是 **Desktop / Local-first Agent**。对于普通用户，Webhook 带来了明显的接入成本：

1. Jojo 必须具备飞书服务器可访问的公网地址；
2. 用户需要自行配置域名、端口映射、Cloudflare Tunnel、frp、ngrok 等；
3. 飞书后台需要配置 Webhook URL；
4. Jojo 端除了 `App ID`、`App Secret`，还要求：
   - `Verification Token`
   - 可选 `Encrypt Key`
5. Webhook 原始 Body 必须保留用于签名验证；
6. 用户本地网络、路由器、防火墙都可能影响回调可达性。

这与 Desktop Agent 希望达到的体验不一致。

目标体验应变成：

```text
用户安装 Jojo
    │
    ├─ 填 App ID
    ├─ 填 App Secret
    └─ 点击“连接飞书”
          │
          ▼
     Jojo 主动连接飞书
          │
          ▼
      Connected
```

用户无需：

```text
公网 IP
域名
HTTPS 证书
端口映射
Webhook URL
Verification Token
Encrypt Key
内网穿透
```

因此，Feishu Channel 的默认入站 Transport 应从 **Webhook** 调整为 **WebSocket Persistent Connection（长连接）**。

---

## 2. 设计结论

本阶段采用：

```text
@larksuiteoapi/node-sdk
        │
        ├─ WSClient
        └─ EventDispatcher
```

作为 Jojo Feishu Adapter 的 **Transport Layer**。

不建议 P0 阶段直接使用飞书官方高层 `createLarkChannel()` 替换 Jojo Channel Runtime。

原因是 Jojo 已经拥有：

```text
Channel Core
Channel Capabilities
Channel Binding
Channel Pairing
Allowed Senders
Queue Mode
Session Routing
Thread Routing
Inbound Dedup
Persistent Outbox
Retry
Approval
Channel Health
```

如果再引入官方完整 Channel Policy / Safety / Normalization / Outbound 层，会形成两套重复架构。

正确边界为：

```text
             Feishu
                │
         WebSocket / REST
                │
                ▼
┌────────────────────────────────┐
│ @larksuiteoapi/node-sdk        │
│                                │
│ WSClient + EventDispatcher     │
│                                │
│ 只负责：                       │
│ - 建立长连接                   │
│ - 握手                         │
│ - 心跳                         │
│ - 自动重连                     │
│ - 接收飞书事件                 │
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Jojo Feishu Adapter            │
│                                │
│ - normalize                    │
│ - media API                    │
│ - send/edit                    │
│ - ChannelInboundEvent          │
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│ Jojo Channel Runtime           │
│                                │
│ Binding / Pairing / Policy     │
│ Dedup / Queue / Outbox         │
│ Session / Approval             │
└───────────────┬────────────────┘
                │
                ▼
              Agent
```

---

## 3. 官方 SDK 选择原因

飞书官方 Node SDK 已提供长连接支持。

当前官方仓库 `@larksuiteoapi/node-sdk` 版本为 `1.73.1`。

官方长连接能力包含：

- WebSocket 建连；
- 服务端 WS Endpoint Discovery；
- 心跳；
- Pong/Liveness；
- 自动重连；
- 重连次数/间隔由服务端配置；
- Handshake timeout；
- `onReady`；
- `onError`；
- `onReconnecting`；
- `onReconnected`；
- `getConnectionStatus()`；
- `close()`；
- EventDispatcher。

Jojo 是 TypeScript 项目，没有必要再次自行实现：

```text
protobuf frame
endpoint discovery
ping
pong
reconnect nonce
reconnect count
fragment merge
connection state machine
```

优先使用官方 SDK，可以大幅降低长期维护成本。

Octo Agent 当前也是相同产品方向：

```text
OAuth
  ↓
获取 WebSocket Endpoint
  ↓
WebSocket connect
  ↓
heartbeat
  ↓
receive event
  ↓
REST reply
```

Octo 更偏自己维护连接协议，而 Jojo 更适合直接复用官方 Node SDK。

---

## 4. P0 目标

本阶段只解决一个核心问题：

> **用户在本地运行 Jojo 时，不需要公网 Webhook，也可以直接接收飞书消息。**

P0 必须完成：

- [ ] Feishu 默认 Transport 改为 WebSocket；
- [ ] 使用官方 `WSClient`；
- [ ] 首次握手成功后 Channel Health 才显示 `connected`；
- [ ] 支持自动重连；
- [ ] 重连期间 Health 显示 `degraded`；
- [ ] 重连成功恢复 `connected`；
- [ ] `stop()` 能彻底停止连接和重连任务；
- [ ] 支持 `im.message.receive_v1`；
- [ ] 保留现有 `ChannelInboundEvent`；
- [ ] 保留现有 Outbound REST 实现；
- [ ] 保留现有 Outbox；
- [ ] 保留 Binding / Pairing；
- [ ] 用户默认只需要配置：
  - App ID
  - App Secret
- [ ] Webhook 保留为兼容模式，但不再作为默认模式。

---

## 5. P0 非目标

以下内容不是本阶段阻塞项：

- 完整修复图片/文件进入 Agent；
- Voice / Video；
- Feishu Doc URL enrichment；
- 流式卡片；
- 飞书应用自动创建；
- OAuth 用户授权；
- Reaction；
- Bot added event；
- 文档评论事件；
- 多租户 SaaS；
- 多进程 HA；
- 多实例广播；
- 完整替换 Jojo Outbound REST Client；
- 删除 Webhook 代码。

这些内容可以在 WebSocket 稳定后继续迭代。

---

## 6. 用户体验变化

### 6.1 当前接入

当前用户需要准备：

```text
App ID
App Secret
Verification Token
Encrypt Key（可选）
公网地址
Webhook URL
HTTPS
```

并配置：

```text
Feishu
  ↓
事件与回调
  ↓
Webhook
  ↓
https://example.com/api/v1/channels/webhook/feishu-xxx
```

实际 Desktop 用户还可能需要：

```text
Cloudflare Tunnel
frp
ngrok
Router NAT
公网服务器
```

### 6.2 新接入

新的默认配置：

```text
App ID
App Secret
```

Jojo UI：

```text
┌──────────────────────────────┐
│ 飞书                         │
│                              │
│ App ID                       │
│ [ cli_xxxxxxxxxxxxxxxx ]     │
│                              │
│ App Secret                   │
│ [ ********************* ]    │
│                              │
│ 接收方式                     │
│ ● 长连接（推荐）             │
│ ○ Webhook（高级）            │
│                              │
│ [ 测试连接 ]  [ 保存并连接 ] │
│                              │
│ 状态：● 已连接               │
└──────────────────────────────┘
```

飞书后台只需：

```text
开发者后台
  ↓
事件与回调
  ↓
订阅方式
  ↓
使用长连接接收事件/回调
```

然后订阅：

```text
im.message.receive_v1
```

即可。

---

## 7. 当前代码现状

当前 Feishu Adapter 位于：

```text
packages/channel-adapters/src/feishu/
├── adapter.ts
├── config.ts
├── crypto.ts
├── factory.ts
└── types.ts
```

当前：

```ts
export const FEISHU_CAPABILITIES: ChannelCapabilities = {
  inbound: {
    text: true,
    markdown: false,
    image: true,
    file: true,
    voice: false,
    video: false,
    interaction: true,
    thread: true
  },
  outbound: {
    text: true,
    markdown: true,
    image: true,
    file: true,
    buttons: true,
    edit: true,
    typing: false,
    thread: false
  },
  limits: {
    maxTextChars: 150 * 1024,
    maxFileBytes: 30 * 1024 * 1024,
    maxButtons: 20
  },
  transport: 'webhook'
};
```

`start()` 当前实际上没有建立连接：

```ts
async start(context: ChannelAdapterContext): Promise<void> {
  const validation = await this.validateConfig();

  if (!validation.valid) {
    throw new Error(
      `feishu_invalid_config: ${validation.errors.join('; ')}`
    );
  }

  this.context = context;
}
```

真正的入站入口是：

```ts
handleWebhook(...)
```

因此 Channel Manager 调用：

```ts
await adapter.start(...)
```

以后立即认为：

```text
connected
```

这是 Webhook 模式下可以接受的语义，但 WebSocket 模式必须改变：

> `adapter.start()` 必须等到首次 WebSocket 握手成功以后再 resolve。

---

## 8. 目标代码结构

建议调整为：

```text
packages/channel-adapters/
└── src/
    └── feishu/
        ├── adapter.ts
        ├── config.ts
        ├── factory.ts
        ├── types.ts
        │
        ├── transport/
        │   ├── websocket.ts
        │   └── webhook.ts
        │
        ├── normalize.ts
        ├── api.ts
        └── crypto.ts
```

P0 不要求一次性拆完所有文件。

推荐最小改动顺序：

```text
P0.1
adapter.ts
config.ts
factory.ts
websocket.ts

P0.2
再逐步提取：
api.ts
normalize.ts
webhook.ts
```

这样可以避免第一版改动过大。

---

## 9. 配置模型

### 9.1 新配置

建议：

```ts
export type FeishuTransport =
  | 'websocket'
  | 'webhook';

export type FeishuAdapterConfig = {
  appId: string;

  transport: FeishuTransport;

  cacheDirectory: string;
  maxImageBytes: number;
  maxFileBytes: number;

  ws?: {
    handshakeTimeoutMs: number;
    pingTimeoutSeconds: number;
  };
};
```

默认：

```ts
transport: 'websocket'
```

建议默认值：

```ts
handshakeTimeoutMs: 15_000
pingTimeoutSeconds: 10
```

真正 Ping Interval 不建议 Jojo 自己定义。

官方 SDK 会从飞书服务器返回的 `ClientConfig` 中获得：

```text
PingInterval
ReconnectCount
ReconnectInterval
ReconnectNonce
```

Jojo 不应再自己实现一套重连策略。

---

## 10. Secret 模型修改

当前 Factory 强制：

```text
appSecret
verificationToken
```

WebSocket 模式不需要 Verification Token。

修改为：

```text
WebSocket:
  require:
    appSecret

Webhook:
  require:
    appSecret
    verificationToken

  optional:
    encryptKey
```

伪代码：

```ts
export function createFeishuAdapterFactory(
  options: FeishuAdapterFactoryOptions = {}
): ChannelAdapterFactory {
  return {
    kind: 'feishu',

    create: async ({ instance, secrets }) => {
      const config =
        parseFeishuConfig(instance);

      const appSecretReference =
        instance.secretRefs.appSecret;

      if (!appSecretReference) {
        throw new Error(
          'feishu_app_secret_reference_missing'
        );
      }

      const appSecret =
        await secrets.resolve(
          appSecretReference
        );

      if (config.transport === 'websocket') {
        return new FeishuChannelAdapter({
          instance,
          appSecret,
          transport: 'websocket'
        });
      }

      const verificationTokenReference =
        instance.secretRefs.verificationToken;

      if (!verificationTokenReference) {
        throw new Error(
          'feishu_verification_token_reference_missing'
        );
      }

      return new FeishuChannelAdapter({
        instance,
        appSecret,
        verificationToken:
          await secrets.resolve(
            verificationTokenReference
          ),
        encryptKey:
          instance.secretRefs.encryptKey
            ? await secrets.resolve(
                instance.secretRefs.encryptKey
              )
            : undefined,
        transport: 'webhook'
      });
    }
  };
}
```

---

## 11. Channel Capability

WebSocket 长连接更接近：

```ts
transport: 'gateway'
```

因此 WebSocket Adapter：

```ts
export const FEISHU_WS_CAPABILITIES:
  ChannelCapabilities = {
    inbound: {
      text: true,
      markdown: false,
      image: true,
      file: true,
      voice: false,
      video: false,
      interaction: true,
      thread: true
    },

    outbound: {
      text: true,
      markdown: true,
      image: true,
      file: true,
      buttons: true,
      edit: true,
      typing: false,
      thread: false
    },

    limits: {
      maxTextChars: 150 * 1024,
      maxFileBytes: 30 * 1024 * 1024,
      maxButtons: 20
    },

    transport: 'gateway'
  };
```

Webhook：

```ts
transport: 'webhook'
```

不要继续使用全局静态：

```ts
FEISHU_CAPABILITIES
```

建议 Adapter Constructor 根据实例 transport 设置：

```ts
readonly capabilities: ChannelCapabilities;

constructor(...) {
  this.capabilities =
    config.transport === 'websocket'
      ? FEISHU_WS_CAPABILITIES
      : FEISHU_WEBHOOK_CAPABILITIES;
}
```

---

## 12. 为什么不直接使用高层 Channel 封装

即使飞书 SDK 后续提供更高层 Channel 封装，Jojo 也不应该直接用它替换 Channel Runtime。

Jojo 已经有自己的：

```text
Channel Runtime
```

如果直接引入第二套：

```text
Lark Policy
+
Jojo Policy
```

会出现双层：

```text
dedup
queue
allowed sender
requireMention
retry
normalization
```

未来很难知道问题应该在哪一层修。

因此 P0 推荐：

```text
WSClient
+
EventDispatcher
```

只解决 Transport。

Jojo 仍然保持：

```text
Platform SDK
     ↓
Adapter
     ↓
Channel Core
     ↓
Channel Runtime
```

这一层级关系。

---

## 13. 新增 FeishuWebSocketTransport

建议新增：

```text
packages/channel-adapters/src/feishu/
└── transport/
    └── websocket.ts
```

接口保持 Feishu 内部私有：

```ts
export type FeishuWsEventHandler = (
  eventType: string,
  payload: unknown
) => void | Promise<void>;

export interface FeishuWebSocketTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

实现层需要接收生命周期回调：

```ts
export type FeishuWsLifecycle = {
  onReady(): void;
  onReconnecting(): void;
  onReconnected(): void;
  onError(error: Error): void;
};
```

---

## 14. 官方 WSClient 接入

依赖：

```json
{
  "dependencies": {
    "@desktop-agent/channel-core": "workspace:*",
    "@larksuiteoapi/node-sdk": "1.73.1"
  }
}
```

第一阶段建议锁定明确版本，而不是直接使用 `latest`。

原因：

```text
WSClient 生命周期
callback frame
EventDispatcher
connection status
```

都属于 Channel 核心路径。

等 E2E 稳定以后，再交给 Renovate / Dependabot 自动升级。

---

## 15. WebSocket Transport 核心实现

示意代码：

```ts
import * as Lark from
  '@larksuiteoapi/node-sdk';

export class DefaultFeishuWebSocketTransport {
  private client?: Lark.WSClient;
  private started = false;
  private ready = false;

  constructor(
    private readonly options: {
      appId: string;
      appSecret: string;
      handshakeTimeoutMs: number;
      pingTimeoutSeconds: number;

      onEvent(
        type: string,
        payload: unknown
      ): void;

      onReady(): void;
      onReconnecting(): void;
      onReconnected(): void;
      onError(error: Error): void;
    }
  ) {}

  async start(): Promise<void> {
    if (this.started) return;

    this.started = true;

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;

    const firstReady = new Promise<void>(
      (resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }
    );

    const client = new Lark.WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      autoReconnect: true,

      handshakeTimeoutMs:
        this.options.handshakeTimeoutMs,

      wsConfig: {
        pingTimeout:
          this.options.pingTimeoutSeconds
      },

      onReady: () => {
        this.ready = true;
        this.options.onReady();
        resolveReady();
      },

      onReconnecting: () => {
        this.options.onReconnecting();
      },

      onReconnected: () => {
        this.ready = true;
        this.options.onReconnected();
      },

      onError: (error) => {
        if (!this.ready) {
          rejectReady(error);
          return;
        }

        this.options.onError(error);
      }
    });

    this.client = client;

    const dispatcher =
      new Lark.EventDispatcher({})
        .register({
          'im.message.receive_v1':
            async (data) => {
              void Promise.resolve()
                .then(() =>
                  this.options.onEvent(
                    'im.message.receive_v1',
                    data
                  )
                )
                .catch(() => undefined);

              return;
            }
        });

    await client.start({
      eventDispatcher: dispatcher
    });

    await firstReady;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.started = false;

    this.client?.close({
      force: true
    });

    this.client = undefined;
  }
}
```

---

## 16. 一个非常重要的 SDK 生命周期细节

官方 `WSClient.start()` 内部连接逻辑是异步启动的，因此：

```ts
await wsClient.start(...)
```

**不能直接等价理解为 WebSocket 已经可用。**

Jojo 不能直接：

```ts
await client.start(...);
return;
```

否则 Channel Manager 会立即：

```text
starting
  ↓
connected
```

即使：

```text
DNS 失败
代理失败
App Secret 错误
飞书服务器不可达
```

UI 仍可能显示错误状态。

因此 Jojo 必须使用：

```text
onReady
```

包装自己的：

```text
firstReady Promise
```

`FeishuChannelAdapter.start()` 必须：

```text
首次 WS handshake
        ↓
onReady
        ↓
resolve start()
        ↓
Channel Manager
        ↓
connected
```

---

## 17. start() 正确语义

当前 Channel Manager：

```ts
await adapter.start({
  signal: controller.signal,
  emit: (event) => this.receive(event)
});

this.setHealth(
  instance.id,
  { status: 'connected' }
);
```

这个设计本身很好。

不要修改为：

```text
Manager fire-and-forget adapter.start()
```

反而应该让所有 Gateway Adapter 遵循：

> `start()` 返回代表“首次可用状态已经建立”。

即：

```text
Telegram polling:
start → polling loop ready

Feishu:
start → WebSocket first handshake ready

Discord:
start → Gateway ready

Local:
start → local listener ready
```

这会让 Channel Adapter lifecycle 更统一。

---

## 18. Stop / Abort 语义

Channel Runtime 已经拥有：

```ts
AbortController
```

Adapter 必须同时响应：

```text
adapter.stop()
context.signal.abort
```

建议：

```ts
async start(
  context: ChannelAdapterContext
): Promise<void> {
  this.context = context;

  const abort = () => {
    void this.stop();
  };

  context.signal.addEventListener(
    'abort',
    abort,
    { once: true }
  );

  try {
    await this.transport.start();
  } catch (error) {
    context.signal.removeEventListener(
      'abort',
      abort
    );

    throw error;
  }
}
```

`stop()`：

```ts
async stop(): Promise<void> {
  this.context = undefined;

  await this.transport?.stop();

  this.transport = undefined;

  this.accessToken = undefined;
  this.tokenRequest = undefined;
}
```

目标：

```text
Delete instance
Reload instance
Disable instance
App shutdown
Worker shutdown
```

都不能留下：

```text
WebSocket
Timer
Reconnect loop
Ping loop
Event listener
```

---

## 19. ACK 与异步处理

飞书长连接事件处理必须快速完成。

不能：

```ts
'im.message.receive_v1':
async (data) => {
  await this.context.emit(event);
}
```

因为：

```text
context.emit
  ↓
Channel Runtime
  ↓
Agent
  ↓
LLM
```

一个 Agent Turn 可能耗时：

```text
5s
20s
60s
```

这会导致飞书认为事件处理超时并重推。

正确做法：

```text
WS EventDispatcher
       │
       ├─ 快速接收
       │
       ├─ detach
       │
       └─ 立即 ACK
              │
              ▼
       async normalize
              │
              ▼
       context.emit(event)
```

实现：

```ts
'im.message.receive_v1':
async (data) => {
  void Promise.resolve()
    .then(() =>
      this.handleWsMessage(data)
    )
    .catch((error) =>
      this.reportInboundError(error)
    );

  return;
}
```

不要：

```ts
await this.handleWsMessage(data);
```

---

## 20. 重推与 Dedup

因为飞书可能重推事件，因此：

```text
ACK quickly
+
Jojo dedupe
```

必须一起存在。

Jojo 已经具备：

```ts
dedupeKey: `message:${messageId}`
```

并且 Runtime：

```ts
if (!await store.claimInbound(event)) {
  return;
}
```

因此即使：

```text
飞书重复推送
WebSocket 重连重复事件
客户端 ACK 超时导致重推
```

Jojo 都不应该启动两个 Agent Run。

WebSocket 改造不应绕过现有：

```text
claimInbound()
```

---

## 21. WS Payload 到 ChannelInboundEvent

当前 Webhook 的：

```ts
normalizeMessage(
  payload: FeishuMessageEvent
)
```

接受完整 Event Envelope：

```text
schema
header
event
```

而官方 EventDispatcher handler 更适合处理事件 data。

因此建议把 normalization 拆成 Transport-neutral。

例如：

```ts
export type FeishuNormalizeInput = {
  eventId?: string;
  eventType: string;
  createTime?: string;

  event: {
    sender?: unknown;
    message?: unknown;
  };
};
```

然后：

```ts
normalizeMessage(
  input: FeishuNormalizeInput
)
```

Webhook：

```text
Webhook Envelope
    ↓
toNormalizeInput()
    ↓
normalizeMessage()
```

WebSocket：

```text
EventDispatcher data
    ↓
toNormalizeInput()
    ↓
normalizeMessage()
```

不要维护：

```text
normalizeWebhookMessage()
normalizeWebSocketMessage()
```

两套业务逻辑。

---

## 22. P0 可以接受的 receivedAt 行为

如果 EventDispatcher payload 没有直接暴露：

```text
header.create_time
```

P0 可以使用：

```ts
receivedAt:
  this.now().toISOString()
```

因为真正的业务去重已经依赖：

```text
message_id
```

而不是：

```text
receivedAt
```

后续如果需要 stale detection，再补充 SDK metadata。

---

## 23. Card Action

当前 Jojo 支持：

```text
card.action.trigger
```

并转为：

```ts
kind: 'interaction'
```

WebSocket P0 至少要保证架构允许注册：

```ts
'card.action.trigger'
```

示意：

```ts
new Lark.EventDispatcher({})
  .register({
    'im.message.receive_v1': ...,
    'card.action.trigger': ...
  });
```

Card Action 需要特别注意快速返回 callback response：

```ts
'card.action.trigger':
async (data) => {
  void this.handleCardAction(data);

  return {
    toast: {
      type: 'info',
      content: '请求已收到'
    }
  };
}
```

如果某些飞书 Callback 在实际应用配置中仍需要 Webhook，则允许过渡期：

```text
WebSocket:
  message events

Webhook:
  callback events
```

**P0 不应为了 Card Action 阻塞消息 WebSocket 上线。**

---

## 24. Health 状态改造

现在 `ChannelInstanceHealth` 已经有：

```ts
status:
  | 'starting'
  | 'connected'
  | 'degraded'
  | 'stopped'
  | 'failed';

reconnectCount: number;
```

但 Adapter 无法主动向 Manager 上报：

```text
reconnecting
reconnected
terminal failure
```

建议给：

```ts
ChannelAdapterContext
```

增加一个可选 lifecycle callback。

例如：

```ts
export type ChannelAdapterHealthUpdate = {
  status:
    | 'connected'
    | 'degraded'
    | 'failed';

  error?: string;

  reconnectIncrement?: number;
};

export type ChannelAdapterContext = {
  emit(
    event: ChannelInboundEvent
  ): void | Promise<void>;

  reportHealth?(
    update: ChannelAdapterHealthUpdate
  ): void;

  signal: AbortSignal;
};
```

这是可选字段，不破坏现有 Adapter。

---

## 25. Channel Manager 接入 Health

Manager：

```ts
await adapter.start({
  signal: controller.signal,

  emit: (event) =>
    this.receive(event),

  reportHealth: (update) =>
    this.updateAdapterHealth(
      instance.id,
      update
    )
});
```

例如：

```ts
private updateAdapterHealth(
  instanceId: string,
  update: ChannelAdapterHealthUpdate
): void {
  const previous =
    this.health.get(instanceId) ?? {
      status: 'starting',
      reconnectCount: 0
    };

  this.setHealth(instanceId, {
    status: update.status,

    reconnectCount:
      previous.reconnectCount +
      (update.reconnectIncrement ?? 0),

    ...(update.error
      ? { lastError: update.error }
      : {})
  });
}
```

---

## 26. WebSocket Lifecycle → Channel Health

映射：

```text
Adapter start
    ↓
starting

WS onReady
    ↓
connected

WS onReconnecting
    ↓
degraded
    ↓
reconnectCount + 1

WS onReconnected
    ↓
connected

WS onError
    ↓
failed
```

这样 UI 可以真实显示：

```text
● 已连接
● 正在重连
● 连接失败
● 已停止
```

而不是只知道 Adapter 是否被创建过。

---

## 27. Feishu Adapter 新状态

建议：

```ts
export class FeishuChannelAdapter
  implements ChannelAdapter {

  readonly kind = 'feishu' as const;
  readonly instanceId: string;
  readonly capabilities:
    ChannelCapabilities;

  private context?:
    ChannelAdapterContext;

  private transport?:
    FeishuWebSocketTransport;

  private accessToken?: {
    value: string;
    expiresAt: number;
  };

  private tokenRequest?:
    Promise<string>;

  // ...
}
```

`start()`：

```ts
async start(
  context: ChannelAdapterContext
): Promise<void> {
  const validation =
    await this.validateConfig();

  if (!validation.valid) {
    throw new Error(...);
  }

  this.context = context;

  if (
    this.config.transport ===
    'webhook'
  ) {
    return;
  }

  this.transport =
    this.createWsTransport(context);

  await this.transport.start();
}
```

---

## 28. Outbound 不需要改成 WebSocket

需要明确：

> WebSocket 仅替换 **Inbound Transport**。

发送消息仍然：

```text
Jojo
 ↓
tenant_access_token
 ↓
Feishu OpenAPI
 ↓
POST /open-apis/im/v1/messages
```

当前：

```ts
send()
edit()
uploadImage()
uploadFile()
tenantAccessToken()
```

均可以继续使用。

因此第一阶段改动风险相对可控：

```text
Inbound:
Webhook
   ↓
WebSocket

Outbound:
保持不变
```

---

## 29. Token 处理

当前 Jojo 已经自己实现：

```text
tenant_access_token
```

缓存。

官方 `WSClient` 建连使用：

```text
App ID
App Secret
```

而不是要求 Jojo 把：

```text
tenant_access_token
```

传给它。

因此 P0 会存在：

```text
WSClient:
  内部使用 App Secret 建连

Jojo REST Client:
  自己获取 tenant_access_token
```

这是可以接受的。

不要为了“共用一个 Token Manager”而扩大第一版范围。

后续可以评估统一到：

```text
Lark Client
```

但不是当前 P0 必需。

---

## 30. Connection Test

当前 UI 的“测试消息”不能完全代表：

```text
WebSocket inbound ready
```

建议增加真正的：

```text
测试连接
```

流程：

```text
点击“测试连接”
    │
    ▼
创建临时 WSClient
    │
    ▼
等待 onReady
    │
    ├─ 成功
    │    ↓
    │  close()
    │    ↓
    │ “连接成功”
    │
    └─ 失败
         ↓
      显示错误
```

但更推荐：

```text
保存并启用
```

后直接展示实例 Health：

```text
starting
connected
failed
degraded
```

避免创建两条临时 WebSocket。

---

## 31. UI 配置调整

当前 Feishu 新建 Instance 的 Secret refs 默认包含：

```text
appSecret
verificationToken
```

新默认：

```ts
{
  id: `feishu-${suffix}`,
  kind: 'feishu',
  name: 'Feishu',
  enabled: false,

  config: {
    appId: '',
    transport: 'websocket'
  },

  secretRefs: {
    appSecret:
      'secret://env/JOJO_FEISHU_APP_SECRET'
  }
}
```

---

## 32. UI 高级模式

默认 UI：

```text
接收模式：

● 长连接（推荐）
  无需公网地址

○ Webhook（高级）
  适合服务端部署
```

只有选择：

```text
Webhook
```

以后才显示：

```text
Verification Token
Encrypt Key
Webhook URL
```

这样普通用户不会看到一堆不知道用途的配置。

---

## 33. 用户端接入步骤

最终用户文档应该压缩为：

### Step 1：创建飞书企业自建应用

飞书开放平台：

```text
开发者后台
  ↓
创建企业自建应用
```

### Step 2：开启机器人能力

```text
添加应用能力
  ↓
机器人
```

### Step 3：开启消息事件

进入：

```text
事件与回调
  ↓
订阅方式
  ↓
使用长连接接收事件/回调
```

添加：

```text
im.message.receive_v1
```

### Step 4：配置权限并发布应用

至少保证机器人具备：

```text
读取消息所需权限
发送机器人消息所需权限
```

发送机器人消息常见权限：

```text
im:message:send_as_bot
```

实际权限以飞书开发者后台事件/接口提示为准。

### Step 5：Jojo 填两个值

```text
App ID
App Secret
```

然后：

```text
保存并启用
```

看到：

```text
状态：已连接
```

即可。

---

## 34. 日志设计

禁止输出：

```text
App Secret
Tenant Access Token
WebSocket URL 完整 query
Authorization Header
```

建议事件：

```text
channel.feishu.ws.connecting
channel.feishu.ws.connected
channel.feishu.ws.reconnecting
channel.feishu.ws.reconnected
channel.feishu.ws.failed
channel.feishu.ws.stopped
```

字段：

```ts
{
  instanceId,
  reconnectCount?,
  errorCode?,
  errorClass?
}
```

不要记录：

```text
message text
file contents
secret
token
```

默认 Info 只记录元数据。

---

## 35. 错误分类

建议统一：

```text
feishu_ws_invalid_app_id
feishu_ws_auth_failed
feishu_ws_handshake_timeout
feishu_ws_connect_failed
feishu_ws_reconnect_exhausted
feishu_ws_event_failed
feishu_ws_closed
```

对用户展示友好错误：

```text
App ID 格式错误

App ID 或 App Secret 无效

飞书长连接建立失败，请检查网络

连接飞书超时，请检查代理或防火墙

飞书连接已断开，正在自动重连
```

底层 SDK Error 不要直接全部显示给用户。

---

## 36. Proxy 注意事项

Jojo 是 Desktop Agent，用户可能处于：

```text
公司代理
Clash
Surge
VPN
HTTP Proxy
SOCKS Proxy
```

因此 WebSocket 需要验证：

```text
HTTP_PROXY
HTTPS_PROXY
NO_PROXY
```

是否能被官方 SDK 自动继承。

官方 WSClient 支持自定义：

```text
agent
httpInstance
```

如果 Jojo 已经存在统一 Network/Proxy 设置，Feishu Transport 应复用。

不要单独硬编码代理。

---

## 37. 多实例行为

飞书长连接可能具备集群消费语义。

同一个 App：

```text
Jojo A
Jojo B
```

同时建立长连接时，不应假设：

```text
A 收到
+
B 也收到
```

因此：

```text
同 App ID 多实例
```

需要 UI 提示：

> 同一飞书应用建议只启用一个 Jojo 长连接实例。

P0 不需要实现分布式 Leader Election。

---

## 38. 与现有 Pairing 的关系

保持不变：

```text
飞书私聊消息
    ↓
WS Adapter
    ↓
ChannelInboundEvent
    ↓
无 Binding
    ↓
Pairing
    ↓
生成 6 位配对码
    ↓
用户在 Jojo 管理端批准
```

这部分是 Jojo 当前相对于普通 Bot Adapter 很有价值的设计，不应被官方飞书 SDK Policy 替换。

---

## 39. 与 requireMention 的关系

本阶段 WebSocket 不改变 Runtime Policy。

但是当前：

```ts
binding.policy.requireMention
```

只判断：

```text
mentions.length > 0
```

存在行为缺陷：

```text
@其他人
```

也可能被认为满足：

```text
requireMention
```

建议在 WebSocket transport 稳定后紧接着修：

```text
获取 Bot Open ID
    ↓
判断 mentions 中
是否包含 Bot Open ID
```

这可以作为：

```text
P0.5
```

而不是阻塞 WS P0。

---

## 40. 测试策略

至少分为四层。

### 40.1 Unit：Config

测试：

```text
默认 transport = websocket
```

测试：

```text
WebSocket：
只要求 appSecret
```

测试：

```text
Webhook：
要求 verificationToken
```

测试：

```text
Webhook encryptKey 可选
```

### 40.2 Unit：Lifecycle

Mock WSClient。

Case：

```text
start()
 ↓
onReady
 ↓
start resolve
```

断言：

```text
onReady 前 start 不 resolve
```

Case：

```text
start()
 ↓
onError before ready
```

断言：

```text
start reject
```

Case：

```text
connected
 ↓
onReconnecting
```

断言：

```text
health = degraded
reconnectCount + 1
```

Case：

```text
onReconnected
```

断言：

```text
health = connected
```

Case：

```text
stop()
```

断言：

```text
WSClient.close()
被调用一次

不会再次 reconnect
```

### 40.3 Unit：Inbound

构造：

```text
im.message.receive_v1
```

触发 EventDispatcher Handler。

断言：

```text
handler 快速返回
```

而：

```text
context.emit()
```

异步发生。

特别需要一个测试：

```ts
const emit = vi.fn(
  () => new Promise(
    resolve =>
      setTimeout(resolve, 10_000)
  )
);
```

Event callback 不允许等 10 秒。

### 40.4 Integration

使用 Fake WS transport：

```text
FakeFeishuTransport
      ↓
emit message
      ↓
ChannelManager
      ↓
claimInbound
      ↓
Binding
      ↓
Agent
      ↓
Outbox
```

确认 WebSocket 只是：

```text
Inbound Source
```

没有绕开任何 Runtime。

---

## 41. Real E2E

增加：

```text
FEISHU_E2E_APP_ID
FEISHU_E2E_APP_SECRET
```

显式启用：

```bash
FEISHU_E2E=1 pnpm test
```

默认 CI 不运行真实飞书测试。

E2E：

```text
1. 建立 WS
2. getConnectionStatus == connected
3. 手工/测试机器人发送消息
4. Jojo 收到
5. Agent reply
6. 飞书收到 reply
7. 主动断网/terminate
8. 自动 reconnect
```

---

## 42. 建议新增测试文件

```text
packages/channel-adapters/test/
├── feishu.test.ts
├── feishu-websocket.test.ts
└── feishu-websocket-e2e.test.ts
```

如果 Transport 被独立：

```text
packages/channel-adapters/src/feishu/transport/
└── websocket.test.ts
```

也可以。

---

## 43. Migration

已有用户可能存在：

```ts
config: {
  appId: '...'
}

secretRefs: {
  appSecret: '...',
  verificationToken: '...',
  encryptKey: '...'
}
```

不能直接默认为 WebSocket，否则用户升级后现有 Webhook 配置行为改变。

推荐 Migration 规则：

### 新创建 Instance

```text
transport = websocket
```

### 已有 Instance

如果：

```text
config.transport
```

不存在，同时存在：

```text
verificationToken
```

则迁移为：

```text
transport = webhook
```

即：

```ts
if (
  config.transport === undefined
  && secretRefs.verificationToken
) {
  transport = 'webhook';
}
```

这样不会破坏已有用户。

---

## 44. Migration 后的状态

老用户：

```text
升级 Jojo
    ↓
仍然使用 Webhook
```

如果愿意切：

```text
Channel Settings
    ↓
接收方式
    ↓
长连接
```

然后可以删除：

```text
Verification Token
Encrypt Key
公网 URL
```

---

## 45. HTTP Webhook API 暂不删除

保留：

```text
POST
/api/v1/channels/webhook/:instanceId
```

原因：

1. 向后兼容；
2. Server 部署场景仍然可能喜欢 Webhook；
3. 某些 callback/event 能力可能暂时仍需要 Webhook；
4. 可以作为 WS 故障时的 fallback；
5. 避免一次性删除现有安全测试。

等 WebSocket 稳定多个版本以后，再评估：

```text
是否把 Webhook 标记 Deprecated
```

而不是本阶段删除。

---

## 46. 依赖注入

为了测试，不要在 Adapter 内直接写死：

```ts
new Lark.WSClient(...)
```

建议：

```ts
export type FeishuWsClientFactory = (
  options: FeishuWsClientOptions
) => FeishuWsClient;
```

Adapter Options：

```ts
export type FeishuAdapterOptions = {
  // ...
  createWsClient?:
    FeishuWsClientFactory;
};
```

生产：

```text
official SDK
```

测试：

```text
FakeWsClient
```

避免 Unit Test 真连飞书。

---

## 47. 最小 FeishuWsClient 接口

不要让整个官方 SDK 类型扩散到 Jojo。

内部定义：

```ts
export interface FeishuWsClient {
  start(input: {
    eventDispatcher: unknown;
  }): Promise<void>;

  close(
    options?: {
      force?: boolean;
    }
  ): void;

  getConnectionStatus?(): {
    state:
      | 'idle'
      | 'connecting'
      | 'connected'
      | 'reconnecting'
      | 'failed';

    reconnectAttempts?: number;
  };
}
```

只有：

```text
transport/websocket.ts
```

知道官方 SDK。

这样以后替换 SDK 不会污染：

```text
channel-core
channel-runtime
adapter normalizer
```

---

## 48. 推荐实现顺序

### M1：Transport Skeleton

修改：

```text
packages/channel-adapters/package.json
packages/channel-adapters/src/feishu/config.ts
packages/channel-adapters/src/feishu/factory.ts
```

新增：

```text
packages/channel-adapters/src/feishu/transport/websocket.ts
```

完成：

```text
WS handshake
start/stop
```

### M2：Inbound Message

注册：

```text
im.message.receive_v1
```

完成：

```text
WS payload
 ↓
normalize
 ↓
ChannelInboundEvent
 ↓
context.emit
```

确认：

```text
dedupe
pairing
binding
agent
```

全部继续工作。

### M3：Health

修改：

```text
packages/channel-core/src/internal-types.ts
packages/channel-runtime/src/manager.ts
```

增加：

```text
reportHealth
```

映射：

```text
onReconnecting
onReconnected
onError
```

### M4：Desktop Settings

修改 Channel Settings：

```text
默认 WebSocket
只要求 App ID + App Secret
Webhook 收入 Advanced
```

增加：

```text
长连接
已连接
正在重连
连接失败
```

状态展示。

### M5：Migration + Docs

实现：

```text
existing webhook instance
→ preserve webhook
```

更新用户文档。

---

## 49. 建议 Commit 划分

```text
feat(channel): add Feishu websocket transport
```

```text
feat(channel): route Feishu websocket events into channel runtime
```

```text
feat(channel): report adapter reconnect health
```

```text
feat(desktop): make Feishu websocket the default onboarding mode
```

```text
feat(channel): migrate existing Feishu webhook instances safely
```

这样每个 Commit 都可以单独 Review / Revert。

---

## 50. Acceptance Criteria

P0 合并前必须满足。

### 用户体验

- [ ] 新用户不需要公网 IP；
- [ ] 不需要域名；
- [ ] 不需要 HTTPS；
- [ ] 不需要配置 Webhook URL；
- [ ] 不需要 Verification Token；
- [ ] 不需要 Encrypt Key；
- [ ] Jojo 默认只要求 App ID / App Secret；
- [ ] 用户可以在本机直接连接飞书。

### WebSocket

- [ ] 首次 handshake 成功以后才显示 connected；
- [ ] 断线自动重连；
- [ ] 重连中显示 degraded；
- [ ] 重连成功恢复 connected；
- [ ] stop 后不会继续 reconnect；
- [ ] App Secret 错误可以正确显示 failed。

### Runtime

- [ ] 入站仍然走 `claimInbound()`；
- [ ] Pairing 不变；
- [ ] Binding 不变；
- [ ] allowedSenders 不变；
- [ ] queueMode 不变；
- [ ] Session Routing 不变；
- [ ] Outbox 不变；
- [ ] Reply 不变。

### Compatibility

- [ ] 老 Webhook 配置不会升级后自动变成 WebSocket；
- [ ] Webhook endpoint 继续可用；
- [ ] Webhook unit tests 继续通过。

---

## 51. 不建议的实现

### 51.1 不建议复制 Octo 的 WebSocket Protocol

不要自己实现：

```text
/ws/connection
protobuf
ping/pong
reconnect
fragment
nonce
deadline
```

官方 SDK 已经维护这些逻辑。

### 51.2 不建议删除 Channel Runtime

不要直接：

```text
Feishu SDK
   ↓
Agent
```

否则：

```text
Binding
Pairing
Outbox
Dedup
Session Routing
Permission
```

都会被绕开或重复实现。

### 51.3 不建议 start() fire-and-forget

错误：

```ts
async start() {
  void ws.connect();
}
```

这样：

```text
Manager connected
```

不代表：

```text
WS connected
```

必须等待首次 Ready。

### 51.4 不建议 Event Handler await Agent

错误：

```ts
await context.emit(event)
```

可能超过飞书 ACK 窗口。

需要：

```text
ACK first
process async
```

### 51.5 不建议 WebSocket 和 Webhook 两套 Normalize

Transport 可以不同。

Domain Event 必须统一：

```text
Feishu Raw Event
      ↓
one normalizer
      ↓
ChannelInboundEvent
```

---

## 52. P0 后立即建议做的三个功能

### P0.5-A：精确 @Bot

修复：

```text
mentions.length
```

为：

```text
mentions includes botOpenId
```

### P0.5-B：附件真正进入 Agent

当前 Adapter 能下载：

```text
image
file
```

但 Channel → Agent Bridge 还主要传：

```text
text
```

需要真正打通：

```text
Feishu attachment
  ↓
ChannelContentBlock
  ↓
Agent input.content
```

### P1：飞书一键接入

后续可以研究把用户体验进一步收敛为：

```text
Jojo
  ↓
连接飞书
  ↓
扫码/授权
  ↓
自动完成应用配置
  ↓
自动订阅事件
  ↓
自动 WS
```

当前先把：

```text
公网 Webhook
```

去掉，已经能解决最大的接入障碍。

---

## 53. 最终推荐架构

```text
┌─────────────────────────────────────────────┐
│                Feishu Cloud                 │
└──────────────────────┬──────────────────────┘
                       │
             WebSocket │ REST
                       │
                       ▼
┌─────────────────────────────────────────────┐
│        @larksuiteoapi/node-sdk              │
│                                             │
│  WSClient                                   │
│  ├─ endpoint discovery                      │
│  ├─ handshake                               │
│  ├─ heartbeat                               │
│  ├─ liveness                                │
│  ├─ reconnect                               │
│  └─ EventDispatcher                         │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│            FeishuChannelAdapter             │
│                                             │
│  transport = websocket                     │
│                                             │
│  ├─ normalize message                       │
│  ├─ normalize interaction                   │
│  ├─ download resource                       │
│  ├─ REST send                               │
│  └─ REST edit                               │
└──────────────────────┬──────────────────────┘
                       │
              ChannelInboundEvent
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              Channel Runtime                │
│                                             │
│  ├─ claimInbound / dedupe                   │
│  ├─ binding                                 │
│  ├─ pairing                                 │
│  ├─ policy                                  │
│  ├─ queue                                   │
│  ├─ session routing                         │
│  ├─ approval                                │
│  └─ outbox                                  │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│                   Agent                     │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────┐
│              Persistent Outbox              │
│                                             │
│ pending → sending → delivered               │
│             ↘ retry                         │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
                   Feishu REST
```

---

## 54. 最终结论

Jojo 当前 Channel Framework 不需要推倒重做。

真正需要替换的是：

```text
Feishu Inbound Transport
```

从：

```text
Webhook
```

切换到：

```text
WebSocket Persistent Connection
```

推荐技术路线：

```text
@larksuiteoapi/node-sdk
        │
        └─ WSClient + EventDispatcher
```

而不是复制 Octo 的底层 WebSocket 实现。

第一版完成以后，用户飞书接入成本将从：

```text
App ID
App Secret
Verification Token
Encrypt Key
Webhook URL
公网环境
```

降低为：

```text
App ID
App Secret
```

这是当前 Feishu Channel 最值得优先完成的一步。

同时继续保留 Jojo 已经形成优势的：

```text
Channel Abstraction
Binding
Pairing
Dedup
Outbox
Retry
Session Routing
Approval
```

最终形成：

> **飞书官方 SDK 负责“可靠连接飞书”，Jojo Channel Runtime 负责“可靠运行 Agent”。**

---

## 55. 参考源码

### Jojo Agent

```text
https://github.com/zxt6991-source/jojo-agent

packages/channel-adapters/src/feishu/adapter.ts
packages/channel-adapters/src/feishu/config.ts
packages/channel-adapters/src/feishu/factory.ts
packages/channel-core/src/internal-types.ts
packages/channel-core/src/types.ts
packages/channel-runtime/src/manager.ts
packages/channel-runtime/src/outbound/outbox.ts
```

### Octo Agent

```text
https://github.com/open-octo/octo-agent

internal/channel/adapters/feishu/feishu.go
internal/channel/adapter.go
```

### 飞书官方 Node SDK

```text
https://github.com/larksuite/node-sdk
https://github.com/larksuite/node-sdk/blob/main/ws-client/index.ts
```

当前设计参考版本：

```text
@larksuiteoapi/node-sdk 1.73.1
```

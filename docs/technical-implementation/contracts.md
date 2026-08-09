# Contracts 技术实现方案

路径：`packages/contracts`  
包名：`@desktop-agent/contracts`

## 1. 定位与设计原则

Contracts 是 monorepo 的协议内核，统一定义消息、工具、模型、权限、Agent 事件、会话、配置、工作区变更、IPC 和 Worker 通信。它不包含业务执行逻辑，只提供 TypeScript 类型、Zod Schema 与稳定常量。

核心原则是：从磁盘读取的数据和 Renderer→Main 的 IPC 输入使用 Schema 做运行时校验；含 `AbortSignal`、函数或位于可信内部通道的数据使用 TypeScript 接口。Main↔Worker 消息目前只有静态类型约束，后续需要补运行时校验。

## 2. 协议分层

| 分层 | 主要类型 | 用途 |
|---|---|---|
| 对话模型 | `ContentBlock`、`Message` | 表达文本、Tool Call 与 Tool Result |
| 模型抽象 | `ModelRequest`、`ModelEvent`、`ModelProvider` | 隔离具体模型协议 |
| 工具抽象 | `ToolDefinition`、`ToolContext`、`Tool` | 统一工具声明和执行接口 |
| 权限抽象 | `ApprovalRequest`、`PermissionDecision`、`PermissionGate` | 把策略判断与执行分离 |
| Agent 事件 | `AgentEvent` | 驱动流式 UI 和运行状态 |
| 持久化 | `SessionMeta`、`SessionRecord`、`ProviderSettings` | 约束磁盘数据格式 |
| 桌面桥接 | `DesktopApi`、`WorkerCommand`、`WorkerMessage`、`IPC` | 约束 Renderer/Main/Worker 通信 |

## 3. 数据模型实现

`Message.content` 使用以 `type` 为判别字段的联合类型，保证文本、调用和结果可以按顺序组合。工具结果通过 `callId` 关联调用，`ok` 与可选 `code` 区分业务失败类别，`truncated` 标记输出是否被裁剪。

会话记录使用 `schemaVersion: 1` 和 `type` 判别：

- `meta`：创建会话时写入一次；
- `message`：每条消息追加写入；
- `title`：重命名时追加事件，不原地修改历史。

这种事件式格式便于追加写和故障恢复；读取时可以忽略不完整记录。

## 4. 事件与状态语义

一次 Agent Turn 的标准事件顺序为：

```text
turn.started
  -> text.delta / tool.started / tool.progress / approval.required / tool.finished / usage
  -> turn.completed | turn.cancelled | turn.failed
```

中间事件允许重复和交错；终态事件只能选其一。消费者不应从文本是否为空推断运行状态，而应以 `turn.*` 事件为准。

## 5. 兼容策略

- 持久化 Schema 发生不兼容变化时递增 `schemaVersion`，读取端保留旧版本迁移或明确忽略策略。
- IPC 字段优先做向后兼容的可选扩展；删除或改名需要 Main、Preload、Renderer 同步升级。
- `AgentEvent` 或 `WorkerMessage` 新增联合成员时，消费者应补齐处理或安全忽略。
- `IPC` 字符串由本包集中维护，避免各进程手写频道名。
- Provider/Tool 接口保持平台无关，不加入 Electron 类型。

## 6. 安全要求

所有来自 Renderer 的写操作输入必须有对应 Zod Schema，并在 Main 中解析。文件路径、命令语义等环境相关安全规则不放在 Contracts 中，而由 Main 或 Tools 层在拿到已校验结构后处理。

不得在 `ProviderSettings`、`SessionRecord` 或 `AgentEvent` 中加入明文 API Key。密钥只通过受控的 Main→Worker 配置消息在内存传递。

## 7. 测试方案

当前 Contracts 由使用方测试间接覆盖。建议增加独立契约测试：

1. 每个 Schema 的合法/非法样例；
2. Session Record v1 的序列化快照；
3. IPC 输入长度和边界值；
4. AgentEvent、WorkerCommand 的穷尽性类型测试；
5. 新旧持久化版本的迁移夹具。

## 8. 演进方案

- 把协议按 `agent`、`storage`、`desktop` 子模块拆分导出，控制单文件增长。
- 为 Worker 消息增加协议版本和 request/correlation ID。
- 引入新的持久化版本时提供纯函数迁移器，并保留真实历史样本回归测试。
- 当支持多个 Provider 时，增加可判别的 Provider 配置，而不是继续向单一设置对象平铺字段。

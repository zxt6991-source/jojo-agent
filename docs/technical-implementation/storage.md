# Storage 技术实现方案

路径：`packages/storage`  
包名：`@desktop-agent/storage`

## 1. 定位与边界

Storage 提供 Agent Runtime、本地会话元数据、Workflow Journal 与普通 Provider 配置的持久化实现。Desktop 会话正文的唯一在线事实源是 Runtime SQLite；元数据等兼容存储继续使用文件系统。本包不依赖 Electron。API Key 不属于本包，由 Desktop Main 使用操作系统安全存储管理。

`SqliteTeamStore` 另外实现 Persistent Team 的定义、成员状态、委派任务和 Inbox，数据库位于 Electron `userData/runtime/teams.sqlite`。Team Task 只保存编排关系与结果索引；Transcript、Run 与 Usage 的事实源仍是 Agent Runtime Store。

## 2. Agent Runtime Store

`SqliteAgentRuntimeStore` 是 Desktop 主执行路径的 Runtime Store，数据库位于 Electron `userData/runtime/agent-runtime.sqlite`。它实现 `AgentRuntimeStore`，持久化：

- Session Tree 的 immutable entries 与 `parent_id`；
- Main、Child Agent、Workflow Step 的 Lane leaf；
- Operation metadata 和完整状态快照；
- Compaction Entry 与 Usage Record。

数据库使用 `foreign_keys=ON`、WAL 和 busy timeout，schema 版本保存在 `PRAGMA user_version`。Operation 创建与 Lane 占用、Operation 终态与 Lane 释放分别在 `BEGIN IMMEDIATE` 事务中提交。Worker 检测到 Main Lane 存在 active operation 时，会先恢复该 Operation，再处理新用户输入。

`JsonlAgentRuntimeStore` 暂时保留作为兼容适配器和迁移参照，不再是 Desktop composition root。

Desktop 另用 `runtime/application.sqlite` 保存 App Service 的运行索引，复用 `SqliteServerStateStore` 适配器；其 schema 版本由 Compatibility Manifest 管理。Runtime 仍是会话正文事实源，应用运行结果为派生记录。Desktop 启动恢复保留待续跑 operation，同时对账已终结或未提交的应用记录；Server 默认采用重启中断策略。

应用索引永久删除会话时级联清理运行和审批记录，并通过数据库触发器阻止重建。Main 先写文件 tombstone，再分别删除 Runtime 与应用索引；Worker 启动时基于 tombstone 补齐中断的清理，不将多个数据库的操作宣称为一个原子事务。

应用状态从 schema v4 起的审批记录有两种归属：运行级记录保留 Session/Run 外键和 Lane 校验；会话级记录以 `scope=session` 表示运行前授权，Run/Lane 必须为空。两类记录均保存审批状态、处理人和时间，随 Session 删除。v3 审批表在事务内重建并复制原记录、终态和版本；发生迁移错误时回滚，成功后才更新 `user_version`。审批记录不保存工具输入或预览 patch 正文。

Desktop Worker 已使用共享持久化 Broker，审批记录存入 `runtime/application.sqlite`。运行前授权先准备应用 Session 元数据，后台 Agent 审批引用真实应用 Run。重启将旧 pending 审批记为 interrupted；Desktop 续跑会重新检查权限并生成新审批 ID，旧记录不能直接作为授权凭据。Permission Grant Store 的类似请求/对话范围授权仍由 Host 在决定提交后更新。

## 2.1 Hook Invocation Store

`SqliteHookInvocationStore` 持久化 Hook 执行记录，数据库位于 Electron `userData/runtime/hooks.sqlite`。它实现 `HookInvocationStore`，供 `packages/hooks` 的 `DefaultHookRuntime` 去重和恢复异步副作用。表结构、lease 与事件语义见 [Hooks 技术实现方案](./hooks.md)。内存实现留在 `packages/hooks`，不经过本包。

## 2.2 Team Store

`SqliteTeamStore` 使用 WAL 与外键约束维护 `teams`、`team_members`、`team_tasks`、`team_messages`。更新 Team Definition 采用成员 upsert，只在成员确实被移除时级联清理该成员数据，不会因普通名称或配置修改删除历史 Task / Inbox。Inbox 的 `unread/read` 状态天然跨进程恢复。

## 3. 会话元数据与旧正文迁移

`JsonlSessionStore` 为每个会话维护一个 `<sessionId>.jsonl` 文件。Session ID 只允许字母、数字、下划线和连字符，避免文件名注入。

兼容文件中的记录示例（message 仅作为旧正文导入源）：

```json
{"schemaVersion":1,"type":"meta","session":{}}
{"schemaVersion":1,"type":"message","message":{}}
{"schemaVersion":1,"type":"title","title":"新名称"}
```

- 创建：写入首条 `meta`；
- 对话：写入 Runtime，不再向 JSONL 追加 `message`；
- 重命名：追加 `title` 事件；
- 删除：先写持久化 tombstone，再删除会话文件；读、写均尊重 tombstone；
- 列表：读取元数据；Desktop 用 Runtime 首条用户消息补充默认标题，用最近消息时间补充更新时间。

普通兼容读取按行解析 JSON 和 `SessionRecordSchema`，异常记录产生 warnings。首次迁移使用严格的 `loadForMigration`：缺失元数据、Session ID 不一致或任何解析 warning 都会拒绝迁移，不能把截断文件标记为迁移成功。

`importLegacyTranscript` 在 SQLite 事务中完成消息去重、写入、lane 更新、读回 hash 校验和 migration marker。Runtime 已有消息保持权威；孤立 entry 仅在父指针和内容匹配时重新挂接。Desktop 使用一次性 `legacy-jsonl-main-cutover-v1` 标记，完成后不再导入旧文件新增正文；原始增量迁移接口保留兼容。占用中的 lane 返回 busy，待恢复完成后重试。

历史、Artifact 授权和轨迹导出通过 `readConversationMessages` 读取 main lane 原始消息链与持久投递队列。Provider 的压缩上下文不替代用户可见历史；迁移完成后的读取不依赖 Worker 在线。

## 4. 并发控制

`acquire(sessionId)` 使用进程内 Set 防止同一 Worker 同时启动两个会话 Turn，调用方在 `finally` 中释放。Runtime 的跨连接事实更新依赖 SQLite 事务和 lane 占用状态，不能以进程内锁替代。

Scheduler 会话投递通过 `appendConversationMessage` 写入：空闲时直接事务性追加；lane 忙时保存在 `runtime_pending_messages`，不改变运行中的 leaf。投递可立即读取，后续空闲准备或主运行结束时原子排空。相同 ID 和内容重试幂等，冲突报错；排空失败保留队列。

Desktop 删除先通过 Main 生命周期门禁停止会话，确认文件 tombstone 成功，再执行 `deleteSessionPermanently`。数据库永久删除记录与会话删除在同一事务提交，阻止迟到任务重建会话。文件与 SQLite 之间不是分布式事务；文件 tombstone 成功后即使后续清理失败，会话也保持隐藏，避免先删正文再因元数据删除失败而丢失唯一事实源。

## 5. 配置存储

`JsonConfigStore` 保存版本化的 Provider 等普通配置，当前版本由 `BUILD_COMPATIBILITY` 定义（见[生成的版本与能力目录](../current-features.generated.md)）。保存流程为：

1. 创建父目录；
2. 尝试复制旧配置为 `.bak`；
3. 以 `0600` 写入 `.tmp`；
4. `rename` 原子替换目标文件。

读取或校验失败时回退到默认配置，不把损坏内容传给运行时。`hasApiKey` 由调用方根据安全存储状态传入，不落盘。

## 6. 一致性与恢复边界

- Runtime SQLite 事务是在线会话正文的提交边界，JSONL 不再是正文回填或恢复目标。
- SQLite Runtime 的 Operation/Lane 状态在事务中更新，并支持进程重启后续跑。
- 消息一旦追加不原地修改，便于审计和恢复。
- 配置使用临时文件替换，避免覆盖过程中得到半个 JSON。
- `.bak` 目前只生成但不会自动恢复；默认回退也不会主动覆盖损坏文件。
- 文件系统耗尽、权限错误等 I/O 失败向上抛出，由 Agent Turn 停止，避免历史与模型上下文继续分叉。

## 7. 测试方案

迁移测试覆盖去重、重开、entry/lane/marker 写入故障回滚、旧孤立 entry、跨会话冲突、busy、tombstone、损坏源与 SQLite 升级。会话投递测试覆盖忙时持久队列、幂等、冲突、排空失败回滚、删除级联和永久删除防重建。历史测试验证压缩前正文仍可读取。

Electron E2E 覆盖旧会话迁移、重启、删除后复制旧文件防复活，以及运行中 SIGKILL 后恢复；新对话断言 JSONL 没有 message 记录。迁移事务故障通过 SQL trigger 注入，尚未单独执行迁移过程的 OS 级 SIGKILL 验证。结果与限制见[实施记录](../architecture-closure-progress.md)。

## 8. 演进方案

- 数据量增大后引入 compaction：在保留备份的前提下合并重复 title，并原子替换 JSONL。
- 若未来支持多个 Worker，需在当前 SQLite 事务之外增加跨 Worker 调度与 lease。
- 完成元数据接口与应用服务收口，并补齐发布产物的多版本升级和回滚演练。
- 为删除提供可恢复的回收站策略，并为配置 `.bak` 增加可观测的恢复入口。


## Desktop 标题迁移

应用状态 schema v5 增加 `application_metadata_imports`。`DesktopSessionMetadataStore` 的在线标题查询与改名使用应用 SQLite；旧 JSONL 标题通过 `desktop-jsonl-title-v1` 标记一次性导入，不再双写。导入保留已有应用标题及旧会话时间，标记随 Session 删除。从 schema v6 起，项目绑定和目录迁入 `application_session_projects`，按 Session 级联删除；旧值只在缺少记录时导入。Main 绑定项目后，Worker 的首次正文迁移也读取新的 SQLite 绑定。在线会话发现与读取已使用 SQLite；每个进程首次列表保留旧文件兼容扫描，缺少数据库记录时可按 ID 导入旧元数据。文件 tombstone、新建兼容记录及旧正文导入暂时保留在 JSONL 层。已迁移正文的会话即使旧 JSONL 文件缺失，也可从 SQLite 列出并打开。

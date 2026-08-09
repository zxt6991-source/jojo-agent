# Storage 技术实现方案

路径：`packages/storage`  
包名：`@desktop-agent/storage`

## 1. 定位与边界

Storage 提供本地会话与普通 Provider 配置的持久化实现。当前使用文件系统，不依赖 Electron；API Key 不属于本包，由 Desktop Main 使用操作系统安全存储管理。

## 2. 会话存储

`JsonlSessionStore` 为每个会话维护一个 `<sessionId>.jsonl` 文件。Session ID 只允许字母、数字、下划线和连字符，避免文件名注入。

记录采用追加写：

```json
{"schemaVersion":1,"type":"meta","session":{}}
{"schemaVersion":1,"type":"message","message":{}}
{"schemaVersion":1,"type":"title","title":"新名称"}
```

- 创建：写入首条 `meta`；
- 对话：逐条追加 `message`；
- 重命名：追加 `title` 事件；
- 删除：删除单个会话文件；
- 列表：加载所有 JSONL，并使用文件 mtime 作为最新更新时间排序。

读取按行解析 JSON 和 `SessionRecordSchema`。损坏、不完整或不支持的记录会加入 warnings 并被忽略，其余记录继续恢复，因此尾部半写不会导致整个会话不可用。

## 3. 并发控制

`acquire(sessionId)` 使用进程内 Set 提供单会话运行锁，并返回 release 函数。它防止同一 Worker 内两个 Turn 同时追加消息，但不是跨进程文件锁；当前架构只有一个 Worker，因此满足 MVP 约束。

调用方必须在 `finally` 中释放锁。会话的列表、读取、重命名和删除目前不受同一锁统一串行化，跨操作竞态由 Desktop 的产品流程尽量避免。

## 4. 配置存储

`JsonConfigStore` 保存带 `schemaVersion: 1` 的 Provider Base URL 与模型名。保存流程为：

1. 创建父目录；
2. 尝试复制旧配置为 `.bak`；
3. 以 `0600` 写入 `.tmp`；
4. `rename` 原子替换目标文件。

读取或校验失败时回退到默认配置，不把损坏内容传给运行时。`hasApiKey` 由调用方根据安全存储状态传入，不落盘。

## 5. 一致性与恢复边界

- JSONL 单条 append 是当前持久化提交单元；崩溃最多留下可忽略的尾记录。
- 消息一旦追加不原地修改，便于审计和恢复。
- 配置使用临时文件替换，避免覆盖过程中得到半个 JSON。
- `.bak` 目前只生成但不会自动恢复；默认回退也不会主动覆盖损坏文件。
- 文件系统耗尽、权限错误等 I/O 失败向上抛出，由 Agent Turn 停止，避免历史与模型上下文继续分叉。

## 6. 测试方案

现有测试覆盖损坏尾记录恢复和单会话运行锁。后续应补充：

1. 创建、重命名、删除、按 mtime 排序；
2. 非法 Session ID 与不支持的 Schema 记录；
3. append/rename I/O 失败下的一致性；
4. 配置原子替换、备份与损坏配置回退；
5. 多个 Store 实例并发访问同一目录的行为。

## 7. 演进方案

- 数据量增大后引入 compaction：在保留备份的前提下合并重复 title，并原子替换 JSONL。
- 为跨进程/多窗口执行增加真正的文件锁或迁移到 SQLite 事务。
- 增加显式 migration runner，按 `schemaVersion` 升级，不依赖静默忽略承载所有兼容问题。
- 为删除提供可恢复的回收站策略，并为配置 `.bak` 增加可观测的恢复入口。

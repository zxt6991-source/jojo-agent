# Durable Scheduler 技术实现

文档状态：2026-10-15，包含 P1-C 固定提醒、持久投递、独立音色与任务试听入口。

`@desktop-agent/scheduler` 是独立的时间触发层，负责决定何时执行固定提醒、Agent、Workflow 或 Team Member。固定提醒不调用模型；其他执行目标继续复用各自的 Runtime / 编排能力与权限边界。

当前落地的核心能力：

- `once`、固定锚点 `interval`、标准 5-field `cron`，Cron 持久化 IANA timezone；
- `Schedule` 与 `ScheduleRun` 分离，timer occurrence 使用 `UNIQUE(schedule_id, occurrence_key)`；
- `skip` / `fire_once` misfire，补跑最多一次并直接推进到 `now` 后的下一个 occurrence；
- `skip` / `queue` / `allow` overlap 策略，Agent persistent lane 禁止 `allow`，queue 最多保留一个 occurrence；
- 单 Timer、最长五分钟安全唤醒、10 秒 engine lease renew、30 秒 TTL；
- 手动执行、revision 更新、启停、软删除、历史查询和取消；
- 基于 deterministic target execution id 的保守恢复，无法证明安全时标记 `interrupted`；
- Agent target 默认使用 `schedule:<scheduleId>` Lane，并把 `trigger=scheduler` 与 `scheduleRunId` 传入 Runtime / Permission Governance；
- Team Member target 复用 `TeamManager` 的成员 Lane、团队并发限制、Provider semaphore、隔离与审批，并用 Scheduler execution id 作为稳定 task id；
- Workflow target 支持 saved workflow 与 inline definition，并把 Scheduler execution id 作为稳定 workflow run id；重复派发相同请求会返回已有执行，不同请求复用同一 id 会显式报冲突；
- Reminder target 保存 1–200 字符固定文案，无需 session / provider / model / 项目目录，通过稳定 execution id 幂等完成；
- Desktop Worker 按 Runtime、Team、Workflow、Scheduler 的顺序恢复，退出时先关闭 Scheduler，避免关闭窗口中产生新 occurrence；
- Desktop 的 Automations 设置页支持列表、Reminder / Agent / Team Member / Workflow 编辑、启停、立即运行、取消和最近 100 次运行历史；可分别配置对话、系统通知、本机语音及其文案 / 长度 / 有效期 / 音色预设，并查看准备状态、试听已保存的固定文案；
- Main、Worker、Preload 和 Renderer 边界均使用 Zod 校验 Scheduler command、result 与 push event。
- Headless Server 组合 Agent 与 Reminder Scheduler，暴露 capability target 列表、独立 `schedules:*` scopes、REST 控制面与 WebSocket Schedule 事件；Scheduler 内部执行不要求远程 Session control lease，启用本机 voice 会明确拒绝；
- Server Protocol 为 v4，Client SDK 支持 Schedule CRUD、立即运行、Run 查询 / 取消与事件订阅，以及新增 reminder / voice / deliveryItems Schema；
- 故障注入测试覆盖 Leader 释放后的 Standby 接管、dispatch crash 的稳定 execution id 重派发，以及非幂等不确定派发的保守中断。

SQLite 由 `SqliteScheduleStore` 实现；Desktop 使用 `<dataDir>/runtime/scheduler.sqlite`，Headless 使用 `<dataDir>/scheduler.sqlite`。到点事务按以下顺序执行：

1. 校验 Schedule revision 与 `nextRunAt`；
2. 插入唯一 `ScheduleRun`；
3. 推进 `next_run_at`，once 同时 disable；
4. 提交事务；
5. 通过 Dispatcher 启动目标执行。

这样即使提交后、dispatch 前进程崩溃，重启也不会重复创建相同 occurrence。恢复时先 inspect deterministic execution id；只有声明支持幂等 dispatch 的适配器才能重新 dispatch，否则记录 `schedule_dispatch_uncertain` 并中断。

当前包提供 Agent / Reminder Dispatcher 和通用 Dispatcher Registry；Desktop Host 额外组合 Team Member 与 Workflow Dispatcher。提醒与 Agent 目标均由 Headless 暴露，桌面语音、系统通知和托盘由 Desktop Host 提供。

## 原子 Delivery Outbox

创建 ScheduleRun 的事务保存当时的目标、任务名称、配置 revision 和投递目的地快照。执行完成时，Engine 读取已持久结果正文，生成每个目的地的不可变 payload；`transitionRunWithDeliveries()` 在同一个 SQLite 事务中更新 Run 终态并插入 Outbox。执行完成不等待音频合成或播放器，成功运行和成功投递分别记录。

`schedule_delivery_items` 按 Run / destination / destinationId 去重，单条记录绑定稳定消息 ID、createdAt、payloadSnapshot、state、attempts、expiresAt 与 claim 身份。对话、系统通知、voice 和 Channel 分别领取、确认和恢复，某个目的地失败不会重新启动 Agent 或重复已成功的其他目的地。UI 展示 `deliveryItems` 的具体状态；旧 `deliveryStatus` 仅作为兼容汇总，不足以证明任何语音已播完。Channel 的 pending / queued 接受回执仍保持待确认，只有后续实际投递结果才能标记 delivered。

Scheduler SQLite 使用独立 `scheduler_schema_meta` version 2；迁移在事务中添加快照列和 Outbox，保留已有任务 / 运行。旧运行缺少目的地快照时不会采用修改后的当前配置重新投递，也不会推断成新增语音提醒。未知未来版本拒绝写入。application / Runtime SQLite 与 config 格式使用各自的版本，不随 Scheduler 升级。

## 投递、播放与恢复

Delivery Processor 是自动重试的唯一入口，默认最多并行 4 个 attempt。每个 claim 使用 itemId / claimToken / playbackId / generation，20 秒租约；语音合成和 Main 等待 / 播放期间每 5 秒续租。旧 claim、过期租约和晚到 ACK 无法改变当前状态。可重试的网络 / 超时失败最多 3 次并退避，权限、凭据、参数和不存在的目的地等永久失败停止重试。

Worker 独占写入 `scheduler.sqlite` 和 `speech.sqlite`。Desktop 的 Agent result reader 根据完成 Operation 的 `finalEntryId` 读取持久最终助手消息，拒绝 internal / tool_call；Team / Workflow 读取各自已完成的持久结果。Server 只使用持久完成快照的最后一条纯文本助手消息。`resultPreview`、实时 delta 或工具输出不作为播报正文。结果缺失 / 读取失败使用固定提示，不请求模型重新总结。

Main 只取得受授权的 ready 音频引用。PlaybackBroker 在调用 `host.play` 前向 Worker 请求 start，必须先收到该 claim 已持久写入 `playing` 的 ACK，再允许可能产生声音的操作。播放队列的接受与 ready 并不是成功；`playing` 是对可能发声窗口的保守登记，只有播放器正常 ended 和有效终态 ACK 才写入 `played`。播放异常或丢失已授权 claim 会保留 uncertain，而不自动播放第二次。

固定提醒的 voice 有效期从 scheduledFor 起算；Agent / Team / Workflow 结果从 finishedAt 起算。misfire 决定是否补执行，有效期决定还能否补播。expired / suppressed / uncertain / interrupted 均不会因解锁或重启直接重播；用户在有效期内主动重新播报时建立新的 attempt，并再次经过全局语音配置、设备、锁屏、静默时段和录音互斥检查。删除任务或关闭语音会撤销其尚未播放的 Outbox 和准备中的音频。

固定提醒与 fixed voice 文案支持 schedule owner 预缓存；预缓存失败不会妨碍执行、对话或通知投递。`delivery.voice.presetId` 可选择设置中已保存的独立音色预设，解析后只覆盖 TTS 音色 / 语速，共用全局 Key 与资源；不指定时使用默认声音。presetVersion 冻结解析后的实际声音参数，默认声音兼容既有 Provider 配置 hash。修改关联声音后旧版本被抑制，预设缺失时明确不可用，不静默回退。

任务详情通过受控 getter 读取绑定 schedule revision 的 `not_prepared` / `preparing` / `ready` / `failed` / `unavailable` / `dynamic` 状态，并校验 ready 资产仍存在且未过期。固定文案只有保存且草稿未变时才可主动试听；暂停或已完成的任务也可试听其已保存内容。试听使用独立 test owner，不创建 ScheduleRun，不触发 Agent / Team / Workflow，不确认任何 Outbox。动态结果没有样本文案时明确提示完成后生成，可通过运行历史重播实际投递。设置中清除语音缓存会失效准备状态，后续按需重建。

后台托盘、私密通知、审批提示和实机限制见 [Speech](./speech.md)。审批只朗读固定提示，仍由原 UI 决定是否授权。实际系统音色与音频设备、OS 通知、签名安装包与休眠恢复仍需 P1-D 实机验收；系统睡眠期间不保证准点触发。当前启动期统计覆盖语音请求用量与请求总耗时，尚不提供 Outbox 积压汇总或调度到首音的性能结论。

## 验证入口

```bash
pnpm exec vitest run packages/scheduler/test packages/storage/test/sqlite-schedule-store.test.ts apps/desktop/src/worker/team-schedule-dispatcher.test.ts apps/desktop/src/worker/workflow-schedule-dispatcher.test.ts
pnpm exec vitest run packages/storage/test/schedule-delivery-outbox.test.ts apps/desktop/src/worker/schedule-desktop-delivery.test.ts apps/desktop/src/main/speech-host.test.ts apps/desktop/src/renderer/scheduler-settings.test.ts
pnpm exec vitest run packages/server-protocol/test packages/server-core/test apps/server/src/server-runtime.test.ts apps/server/src/scheduler-runtime.test.ts packages/server-http/test packages/client/test/e2e.test.ts
pnpm --filter @desktop-agent/desktop build:e2e
pnpm typecheck
pnpm lint
```

单元与集成用例覆盖稳定 Reminder 恢复、Run 终态 / Outbox 原子回滚、双连接 claim 冲突、快照编辑隔离、过期 / 失效租约 / 旧 ACK、有限重试、对话与 Channel 去重、播报前握手和 Headless 无模型提醒。Electron 用例使用临时目录与离线 Speech Provider，能验证真实 AudioHost MP3 解码和后台关闭路径；E2E 通知回执为模拟值，不能代替实际 OS 通知显示、硬件和签名包验收。

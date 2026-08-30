# Durable Scheduler 技术实现

`@desktop-agent/scheduler` 是独立的时间触发层，负责决定何时创建 Agent、Workflow 或 Team Member 执行；它不替代 `AgentExecutionScheduler` 的并发控制，也不直接执行 Tool、Terminal 或 MCP。

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
- Desktop Worker 按 Runtime、Team、Workflow、Scheduler 的顺序恢复，退出时先关闭 Scheduler，避免关闭窗口中产生新 occurrence；
- Desktop 的 Automations 设置页支持列表、Agent/Team Member/Workflow 编辑、启停、立即运行、取消和最近 100 次运行历史；
- Main、Worker、Preload 和 Renderer 边界均使用 Zod 校验 Scheduler command、result 与 push event。
- Headless Server 组合 Agent-only Scheduler，暴露 capability target 列表、独立 `schedules:*` scopes、REST 控制面与 WebSocket Schedule 事件；Scheduler 内部执行不要求远程 Session control lease；
- Server Protocol 已升级为 v2，Client SDK 支持 Schedule CRUD、立即运行、Run 查询/取消与事件订阅；
- 故障注入测试覆盖 Leader 释放后的 Standby 接管、dispatch crash 的稳定 execution id 重派发，以及非幂等不确定派发的保守中断。

SQLite 由 `SqliteScheduleStore` 实现；Desktop 使用 `<dataDir>/runtime/scheduler.sqlite`，Headless 使用 `<dataDir>/scheduler.sqlite`。到点事务按以下顺序执行：

1. 校验 Schedule revision 与 `nextRunAt`；
2. 插入唯一 `ScheduleRun`；
3. 推进 `next_run_at`，once 同时 disable；
4. 提交事务；
5. 通过 Dispatcher 启动目标执行。

这样即使提交后、dispatch 前进程崩溃，重启也不会重复创建相同 occurrence。恢复时先 inspect deterministic execution id；只有声明支持幂等 dispatch 的适配器才能重新 dispatch，否则记录 `schedule_dispatch_uncertain` 并中断。

当前包提供 Agent Dispatcher 和通用 Dispatcher Registry；Desktop Host 额外组合 Team Member 与 Workflow Dispatcher，Headless M1 按设计只开放 Agent target。

验证入口：

```bash
pnpm exec vitest run packages/scheduler/test packages/storage/test/sqlite-schedule-store.test.ts apps/desktop/src/worker/team-schedule-dispatcher.test.ts apps/desktop/src/worker/workflow-schedule-dispatcher.test.ts
pnpm exec vitest run packages/server-protocol/test packages/server-core/test apps/server/src/server-runtime.test.ts packages/server-http/test packages/client/test/e2e.test.ts
pnpm --filter @desktop-agent/desktop build:e2e
pnpm typecheck
pnpm lint
```

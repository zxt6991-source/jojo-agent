# 应用绑定覆盖（自动生成）

由 contracts/application/bindings.json 声明，pnpm test:bindings 对注册目录、HTTP → Core 调用、WS dispatch、SDK 方法和声明的 IPC 共享解析做静态检查。
这不是权限、幂等或恢复行为的证明；这些行为仍须 conformance 测试。Desktop DTO 尚未全量统一，缺口逐项列明。

| Operation | Core | HTTP | WS | SDK | IPC |
|---|---|---|---|---|---|
| session.search | searchSessionHistory | GET /api/v1/sessions/:sessionId/search | session.search | JojoClient.searchSessionHistory | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| session.read-window | readSessionHistoryWindow | GET /api/v1/sessions/:sessionId/read-window | session.read-window | JojoClient.readSessionHistoryWindow | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| session.list | listSessions | GET /api/v1/sessions | session.list | JojoClient.listSessions | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| session.create | createSession | POST /api/v1/sessions | session.create | JojoClient.createSession | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| session.patch | patchSession | PATCH /api/v1/sessions/:sessionId | session.patch | JojoSession.patch | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| session.get | getSession | GET /api/v1/sessions/:sessionId | session.snapshot | JojoSession.snapshot | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| transcript.get | transcript | GET /api/v1/sessions/:sessionId/transcript | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoSession.transcript | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| run.start | startRun | POST /api/v1/sessions/:sessionId/runs | run.start | JojoSession.run | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| run.get | getRun | GET /api/v1/sessions/:sessionId/runs/:runId | run.get | JojoRun.snapshot | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| approval.list | getSession | GET /api/v1/sessions/:sessionId/approvals | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoSession.snapshot | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| approval.resolve | resolveApproval | POST /api/v1/approvals/:approvalId/resolve | approval.resolve | JojoClient.resolveApproval | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| schedule.create | createSchedule | POST /api/v1/schedules | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.createSchedule | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| schedule.update | updateSchedule | PATCH /api/v1/schedules/:scheduleId | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.updateSchedule | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| schedule.run-now | runScheduleNow | POST /api/v1/schedules/:scheduleId/run | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.runScheduleNow | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.instance.create | createChannelInstance | POST /api/v1/channels | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.createChannelInstance | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.instance.update | updateChannelInstance | PATCH /api/v1/channels/:instanceId | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.updateChannelInstance | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.binding.create | createChannelBinding | POST /api/v1/channel-bindings | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.createChannelBinding | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.binding.update | updateChannelBinding | PATCH /api/v1/channel-bindings/:bindingId | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.updateChannelBinding | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.pairing.approve | approveChannelPairing | POST /api/v1/channel-pairings/:pairingId/approve | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.approveChannelPairing | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| channel.test | testChannel | POST /api/v1/channels/:instanceId/test | 缺口：此操作使用 HTTP；当前 WS command 合同没有对应命令。 | JojoClient.testChannel | 缺口：Desktop 使用本地 Host DTO 与 IPC 管线；尚无该中立 Operation 的一对一绑定。 |
| schedule.save | 本地专用 | 缺口：Desktop 专用保存/启停操作；Server 使用 create/update 合同。 | 缺口：Desktop 专用 IPC 操作，未发布 WS 命令。 | 本地专用 | saveSchedule |
| schedule.enabled | 本地专用 | 缺口：Desktop 专用保存/启停操作；Server 使用 create/update 合同。 | 缺口：Desktop 专用 IPC 操作，未发布 WS 命令。 | 本地专用 | setScheduleEnabled |

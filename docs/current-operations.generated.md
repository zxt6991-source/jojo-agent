# 应用操作目录（自动生成）

由 contracts/application/operations.ts 的 APPLICATION_OPERATIONS 生成。
输入为业务 body/query，资源 ID 由 Transport 路由携带；输出为中立应用结果，Transport 可增加自己的 envelope。

| 操作 | 类型 | 权限 scope | 无幂等键可安全重试 |
|---|---|---|---|
| session.list | query | sessions:read | true |
| session.create | command | sessions:write | false |
| session.patch | command | sessions:write | false |
| session.get | query | sessions:read | true |
| transcript.get | query | sessions:read | true |
| run.start | command | runs:start | false |
| run.get | query | sessions:read | true |
| approval.list | query | sessions:read | true |
| approval.resolve | command | approvals:resolve | true |
| schedule.create | command | schedules:write | false |
| schedule.update | command | schedules:write | false |
| schedule.save | command | schedules:write | false |
| schedule.enabled | command | schedules:write | false |
| schedule.run-now | command | schedules:run | false |
| channel.instance.create | command | channels:write | false |
| channel.instance.update | command | channels:write | false |
| channel.binding.create | command | channels:bind | false |
| channel.binding.update | command | channels:bind | false |
| channel.pairing.approve | command | channels:approve | false |
| channel.test | command | channels:send | false |

Registry 描述已纳入本轮的操作，并不表示所有 Host 都实现了每项能力。
Server Core 使用这些 scope；Desktop 仍使用本地权限治理。Desktop 的审批 scope、密钥引用、附件限制和 Session 元数据格式由 Host 适配层保留。

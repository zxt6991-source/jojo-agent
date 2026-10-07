# 当前版本与内置能力（自动生成）

由 `pnpm docs:generate` 生成；请修改 contracts 中的 build-compatibility.ts / capability-manifest.ts。

## 格式版本

| 格式 | 当前版本 |
|---|---|
| appVersion | 0.1.0 |
| serverProtocol | 3 |
| serverStateSchema | 6 |
| configSchema | 4 |
| sessionJsonlSchema | 1 |
| runtimeContract | 1 |
| runtimeSqliteSchema | 4 |
| desktopIpcProtocol | 尚未实现版本握手 |

这些数值表示当前写入格式，不承诺旧版本兼容；兼容性必须由迁移测试验证。

## 内置 Host 能力

| 能力 | Desktop | Headless Server | 所需 Adapter |
|---|---|---|---|
| runtime | 支持 | 支持 | runtimeStore |
| workflow | 支持 | 未内置 | workflowStore |
| browser | 支持 | 未内置 | browserHost |
| memory | 支持 | 未内置 | memoryStore |
| subagents | 支持 | 支持 | runtimeEnvironment |
| images | 支持 | 支持 | attachmentAccess |
| approvals | 支持 | 支持 | approvalHost |
| scheduler | 支持 | 支持 | scheduler |
| channels | 支持 | 支持 | channelManager |

这里描述内置 Host 的可用能力；Scheduler、Channel 等可选服务的实际启用状态由 ServerCapabilities 返回，定制 Host 可以覆盖默认能力。CLI 与 Client 应读取服务端能力，不能把此表当作当前连接的实时状态。

- Desktop Scheduler targets：agent, workflow, team_member。
- Headless Scheduler targets：agent。
- Desktop 的功能可见性尚未全部接入此 Manifest。

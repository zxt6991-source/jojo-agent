# Desktop 应用技术实现方案

路径：`apps/desktop`  
包名：`@desktop-agent/desktop`

## 1. 定位与边界

Desktop 是产品装配层，负责 Electron 生命周期、进程隔离、IPC、桌面界面、运行时依赖注入和生产打包。Agent 推理循环、协议转换、工具和存储的通用逻辑分别下沉到独立包，本应用只处理平台相关编排。

## 2. 进程架构

| 进程 | 入口 | 职责 | 权限边界 |
|---|---|---|---|
| Main | `src/main/main.ts` | 窗口、IPC、密钥、会话管理、Worker 生命周期、Git 变更采集 | 拥有 Electron/Node 权限 |
| Preload | `src/preload/preload.ts` | 把白名单 `DesktopApi` 暴露给页面 | Context Bridge；不暴露任意 IPC |
| Renderer | `src/renderer/main.tsx` | 会话、流式对话、工具进度、审批、Diff 与设置 UI | sandbox，无 Node Integration |
| Utility Process | `src/worker/worker.ts` | Agent 执行、模型请求、工具调用、消息持久化 | 与 Renderer 隔离，通过结构化消息通信 |

主窗口启用 `contextIsolation`、`sandbox`、`webSecurity`，禁止新窗口，并阻止跨源导航。Main 的每个 invoke handler 都调用 `assertTrusted` 校验发送者 WebContents 和来源。

## 3. 核心实现

### 3.1 Main 与 IPC

- `registerIpc` 注册会话、工作区变更、Agent 控制、目录选择和 Provider 设置接口。
- 输入使用 `contracts` 中的 Zod Schema 解析，非法输入在进入业务逻辑前失败。
- Main 只通过 `IPC.agentEvent` 和 `IPC.sessionsChanged` 向 Renderer 推送白名单事件。
- Worker 使用 `utilityProcess.fork` 启动；异常退出后延迟 1 秒重建，并向 UI 报告失败。

### 3.2 Worker 依赖装配

Worker 为每轮创建 `AbortController`，并向 `runAgentTurn` 注入：

- `OpenAICompatibleProvider`；
- `createDefaultTools()`；
- `DefaultPermissionGate`；
- JSONL 消息追加回调；
- 审批等待器和事件转发器。

`controllers` 以会话 ID 管理取消信号，`approvals` 以请求 ID 管理待决授权。取消会话时，同时中止模型/工具并把尚未处理的审批解析为拒绝。

### 3.3 Renderer 状态

当前界面使用 React 本地 State 管理会话、消息、流式文本、工具、审批、设置和 Diff。收到完成、取消或失败事件后，从持久化层重新加载消息，避免仅依赖临时 UI 状态。

工作区变更在发送前保存 baseline，结束后用 path 与 patch 比较，只突出本轮产生变化的文件。窗口重新聚焦或恢复可见时重新采集 Git 状态。

### 3.4 Git 变更审阅

`workspace-changes.ts` 使用 `git status --porcelain -z` 获取状态，并分别生成已跟踪文件 Diff 与未跟踪文件的合成 Patch。实现限制为最多 100 个文件、单 Patch 约 250 KB，并过滤工作目录外路径和越界符号链接。

### 3.5 配置与密钥

普通 Provider 配置写入 `userData/config.json`。API Key 单独通过 `safeStorage.encryptString` 写入权限为 `0600` 的二进制文件；若系统安全存储不可用则拒绝保存，不降级为明文。

## 4. 构建与发布

Electron Forge + Vite 分别构建 Main、Preload、Worker 和 Renderer。生产包启用 ASAR，并通过 Electron Fuses 禁止 RunAsNode、Node Options 和 CLI Inspect，启用 Cookie 加密、ASAR 完整性校验和仅从 ASAR 加载。

输出目标包括 Windows Squirrel、macOS/Windows ZIP 和 Debian 包。代码签名、公证与自动更新尚未接入。

## 5. 失败与恢复策略

- Worker 不可用：`startTurn` 直接失败；Worker 退出后自动拉起。
- Provider 失败转换成 Agent 失败事件；工具失败转换成 Agent 事件和持久化 Tool Result，由 UI 展示。
- 用户取消：AbortSignal 贯穿 Provider 和工具进程，待审批请求同时释放。
- Git 不可用或目录非仓库：返回 `isGitRepository: false`，不阻断对话。
- Renderer 临时状态丢失：重新从 JSONL 加载已提交消息。

## 6. 测试方案

当前已有 `workspace-changes.test.ts` 覆盖修改、未跟踪文件和子目录边界。后续优先补充：

1. IPC Schema 与不可信来源拒绝测试；
2. Worker 退出、重启和运行中取消的集成测试；
3. Renderer 的审批快捷键、会话切换和 Diff baseline 测试；
4. 打包后的 Preload API 暴露与安全开关冒烟测试。

## 7. 演进方案

- Renderer 状态增长后按会话域、运行域和设置域拆分 Store，避免异步会话切换产生竞态。
- 为 Main↔Worker 命令增加 request ID 和显式 ACK，使启动失败可准确回传。
- 为 Worker 重启增加退避和最大重试，防止持续崩溃循环。
- 发布阶段增加签名、公证、自动更新和干净机器安装验证。

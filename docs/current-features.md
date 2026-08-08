# Desktop Agent 当前功能说明

> 文档状态：2026-08-08  
> 当前版本：0.1.0（MVP）  
> 依据：当前仓库实际代码，不包含仅存在于路线图中的规划功能。

## 1. 产品概况

Desktop Agent 是一个本地优先的 Electron 桌面 AI Agent。用户可以为会话选择本地项目目录，通过兼容 OpenAI Chat Completions 的模型进行流式对话，并在权限策略约束下让模型读取文件、列出目录或执行命令。

当前界面采用白色浅色主题，整体布局参考 Codex，包括会话侧栏、居中聊天区、工具调用卡片、底部输入框、底部审批卡片以及文件修改审阅面板。

## 2. 运行时架构

项目使用 pnpm workspace，包含一个桌面应用和五个共享包。

| 模块 | 当前职责 |
|---|---|
| `apps/desktop` | Electron Main、Preload、React Renderer 和 Agent Utility Process |
| `packages/contracts` | 消息、事件、IPC、配置及 Zod Schema |
| `packages/agent-core` | 不依赖 Electron 的 Agent 工具循环 |
| `packages/providers` | OpenAI Chat Completions 兼容协议适配 |
| `packages/tools-node` | 文件、目录、终端工具和权限 Gate |
| `packages/storage` | JSONL 会话存储和普通配置存储 |

进程职责：

- Renderer：显示会话、消息、工具状态、审批和设置界面；
- Preload：通过 `contextBridge` 暴露白名单业务 API；
- Main：管理窗口、IPC、目录选择、安全存储和 Worker 生命周期；
- Worker：运行 Provider、Agent Core、工具、权限判断和会话写入。

## 3. 桌面端与界面

当前支持：

- Electron 单窗口、单实例运行；
- 创建、选择、重命名和删除会话；
- 为每个会话绑定一个本地工作目录；
- 流式展示模型文本；
- Markdown、标题、列表、引用和代码块渲染；
- Markdown 内容使用 DOMPurify 消毒；
- 工具调用卡片展示参数、进度、结果和状态；
- Composer 支持 Enter 发送、Shift+Enter 换行；
- 模型运行期间显示停止按钮；
- 空状态、错误提示和加载状态；
- OpenAI 兼容 Provider 设置页；
- 白色浅色主题和响应式侧栏宽度；
- Codex 风格的审批卡片、可读命令、快捷键和“拒绝 / 允许一次”操作；
- 当前 Git 工作区已编辑文件的修改摘要；空会话不展示修改卡，发送任务后优先过滤任务开始前未变化的文件；
- 已修改及未跟踪文件的逐行 Diff 预览；
- 审阅面板中的文件切换、增删统计、超大 Diff 截断和二进制文件提示。

## 4. 模型 Provider

当前实现一个 `OpenAICompatibleProvider`，请求地址为：

```text
{API Base URL}/chat/completions
```

设置页可以配置：

- API Base URL；
- 模型名称；
- API Key。

已实现的协议能力：

- SSE 流式文本；
- 流式 Tool Call 参数聚合；
- Tool Call JSON 参数解析；
- token usage 事件；
- AbortSignal 取消；
- 90 秒默认模型请求超时；
- 认证、限流、服务异常、网络、超时和空响应错误分类。

兼容 DeepSeek 等实现 OpenAI Chat Completions 和 Tool Calls 的服务。具体兼容性仍取决于目标服务是否接受当前请求字段。

## 5. Agent 循环

Agent Core 当前支持：

- 把用户消息加入会话历史；
- 把模型文本与 Tool Call 组合为 Assistant Message；
- 执行一个或多个 Tool Call；
- 把每个 Tool Result 作为 Tool Message 回填给模型；
- 模型停止调用工具后结束本轮；
- 默认最多运行 8 次模型迭代；
- 未知工具返回失败 Tool Result；
- 重复 Tool Call ID 只执行一次；
- 工具失败或用户拒绝后继续模型循环；
- 用户取消后发出 `turn.cancelled`；
- Provider 或 Agent 异常发出 `turn.failed`；
- 同一会话同时只允许运行一个 Turn。

统一 Agent Event 包含：

- `turn.started`
- `text.delta`
- `tool.started`
- `tool.progress`
- `tool.finished`
- `approval.required`
- `usage`
- `turn.completed`
- `turn.cancelled`
- `turn.failed`

## 6. 工具能力

### 6.1 `read_file`

- 读取 UTF-8 文本文件；
- 相对路径以会话工作目录为基准；
- 默认最大读取 512,000 字节；
- 超过上限时返回截断标记；
- 使用真实路径检查，防止 `..` 和符号链接绕过；
- 工作目录内默认允许；
- 工作目录外需要用户逐次批准。

### 6.2 `list_files`

- 递归列出目录和文件；
- 默认最大深度为 3，可配置范围为 0～5；
- 默认最多返回 500 个条目；
- 忽略 `.git`、`node_modules`、`dist`、`out`、`coverage`、`.next` 和 `.cache`；
- 跳过指向工作目录外部的符号链接；
- 只允许列出工作目录内部内容。

### 6.3 `terminal`

- 通过命令和参数数组执行本地程序；
- 默认不启用 `shell: true`；
- 支持指定工作目录内的 `cwd`；
- 支持 stdout 和 stderr 流式进度；
- 默认超时 120 秒，允许范围为 1～300 秒；
- 默认最大采集 1,000,000 字节输出；
- 支持取消并回收进程组；
- 每次执行都必须由用户明确批准。

## 7. 权限与审批

当前默认策略：

| 操作 | 工作目录内 | 工作目录外 |
|---|---|---|
| `read_file` | 自动允许 | 逐次询问 |
| `list_files` | 自动允许 | 拒绝 |
| `terminal` | 每次询问 | `cwd` 不允许越出工作目录 |

用户拒绝不会直接破坏本轮对话，而是生成带有 `user_denied` 错误码的 Tool Result，让模型解释拒绝结果或选择替代方案。

## 8. 会话与配置存储

### 会话

- 使用 JSONL 追加写入；
- 每条记录包含 `schemaVersion: 1`；
- 保存 Session Meta、Message 和 Title 记录；
- 保存用户消息、模型消息、Tool Call 和 Tool Result；
- 应用重启后恢复会话与消息；
- 遇到损坏或未写完的 JSONL 行时跳过该行，保留此前完整记录；
- 使用文件修改时间更新会话列表排序；
- 使用内存锁避免同一会话并行写入两个 Turn。

### Provider 配置

- Base URL 和模型名称写入普通 JSON 配置；
- 配置写入前保留 `.bak` 备份；
- 配置通过临时文件重命名完成替换；
- API Key 与普通配置分离；
- API Key 使用 Electron `safeStorage` 加密后保存；
- 普通配置、会话和 Renderer 均不持有明文持久化密钥。

## 9. Electron 安全措施

当前已启用：

- `nodeIntegration: false`；
- `contextIsolation: true`；
- Renderer sandbox；
- `webSecurity: true`；
- CSP 限制；
- 禁止创建任意新窗口；
- 限制跨来源导航；
- IPC 来源校验；
- IPC 参数通过 Zod 验证；
- Preload 不暴露原始 `ipcRenderer`；
- Renderer 不直接访问 Node.js、文件系统或子进程；
- 生产构建使用 ASAR；
- 配置 Electron Fuses，关闭 RunAsNode、NODE_OPTIONS 和调试参数等能力。

## 10. 构建与质量检查

常用命令：

```bash
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

当前测试覆盖：

- Agent 调用工具后继续输出；
- 重复 Tool Call 防护；
- 用户拒绝后继续 Agent 循环；
- 大文件截断；
- 目录符号链接逃逸；
- 工作目录外读取审批；
- JSONL 损坏尾恢复；
- 单会话并发锁。

当前共有 11 个单元测试，其中包含 Git 修改采集、未跟踪文件 Diff 和会话目录范围限制。GitHub Actions 会执行依赖安装、Lint、类型检查、测试和 Linux Electron Package 构建。

## 11. 当前未实现

以下能力尚未实现：

- 文件写入、代码编辑和 Diff 审批；
- `grep`、`glob` 和 Git 提交、分支等写操作；
- 多 Provider 注册和切换；
- MCP；
- Skills；
- 浏览器自动化；
- 图片等多模态消息；
- 子 Agent 和工作流；
- 长期记忆和向量数据库；
- 定时任务与后台自动化；
- 自动更新；
- 云端账号、同步和协作；
- 代码签名与 macOS notarization；
- 默认 CI 中的真实模型集成测试。

## 12. 主要源码入口

| 功能 | 文件 |
|---|---|
| Electron Main | `apps/desktop/src/main/main.ts` |
| Git 工作区修改采集 | `apps/desktop/src/main/workspace-changes.ts` |
| Preload API | `apps/desktop/src/preload/preload.ts` |
| Agent Worker | `apps/desktop/src/worker/worker.ts` |
| React UI | `apps/desktop/src/renderer/main.tsx` |
| UI 样式 | `apps/desktop/src/renderer/styles.css` |
| 核心契约 | `packages/contracts/src/index.ts` |
| Agent 循环 | `packages/agent-core/src/index.ts` |
| Provider | `packages/providers/src/index.ts` |
| Node 工具和权限 | `packages/tools-node/src/index.ts` |
| JSONL 存储 | `packages/storage/src/index.ts` |

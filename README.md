# Jojo Agent

本地优先的 Electron Coding Agent。一次对话绑定一个本地目录，模型可检索和阅读项目；主 Agent 修改文件或执行命令前会展示 Diff / 命令并逐次批准。后台 Sub-Agent 与声明式 Workflow DAG 可并行执行只读分析，或在独立 Git Worktree 中写入且不自动 Merge。

上手细节见 [`docs/current-features.md`](./docs/current-features.md)。Sub-Agent / Workflow 设计以 [`docs/subagent-workflow-unified-design-roadmap.md`](./docs/subagent-workflow-unified-design-roadmap.md) 为准；与代码冲突时以 Contracts、Runtime 和测试为准。早期 MVP 规划仍见 [`ts-desktop-agent-mvp-roadmap.md`](./ts-desktop-agent-mvp-roadmap.md)。

## 已实现

- Electron Main / sandboxed Preload / React Renderer / Utility Process；
- OpenAI Chat Completions 兼容 Provider：自定义 Base URL、模型发现、逐轮选模型、流式输出；
- Agent Core：多轮工具循环、上下文估算、大结果回收、历史压缩、拒绝回填、重复调用保护；
- 十个主 Agent 工具：`read_file`、`list_files`、`grep`、`glob`、`web_search`、`web_fetch`、`write_file`、`edit_file`、`delete_file`、`terminal`；
- 工作目录边界、真实路径 / 符号链接检查、写前冲突检测、精确编辑、回收站、Terminal 超时与进程组回收；
- 主会话文件修改与 Terminal 逐次审批；工作区外读取逐次审批；
- 多会话侧边栏、对话 / 轨迹视图、Markdown 消毒、审批弹窗、停止、加密 API Key；
- MCP（stdio / Streamable HTTP）与本地 `SKILL.md`；工具 Schema 过大时改为 manifest + describe/call；
- 受控 CDP 浏览器（沙箱或附加本机 Chrome）、图片附件与视觉消息；
- 后台 Sub-Agent：Profile（`explore` / `general` / `code-review` / `synthesize`，可叠加 user/project）、Tool Policy、Continue / Send / Close、Structured Output；
- Workflow DAG：依赖与并发、Timeout / Cancel、Retry、Typed Inputs、Tool Step、foreach / condition / 嵌套 Saved Workflow、Budget、资源组与 Provider 限流、JSONL Journal / Resume；
- 可写 Agent 强制 Git Worktree 隔离，Branch / Diff 可审查，默认不自动 Merge；
- WorkflowCard：步骤列表、依赖图、时间线、Usage、预算、错误码、结构化输出与 Isolation Diff。

尚未实现：可视化 Workflow 编辑器、窗口级 Playwright、pipeline / human / HTTP Step、长期记忆、专用 Git 提交工具、自动更新与云同步。

## 开发

要求 Node.js 22+ 与 pnpm 10+。

```bash
pnpm install
pnpm dev
```

首次启动：

1. 打开「设置」，填写 OpenAI Chat Completions 兼容服务的 API Base URL 和 API Key，获取模型列表并选择默认模型；
2. 选择一个本地项目目录创建会话（可写 Sub-Agent / Workflow 需要 Git 仓库）；
3. 在输入框右下角选择本轮模型后发送任务。可用「＋」添加最多 4 张图片。

项目内检索和公开网页搜索 / 抓取默认允许；主会话的文件修改会先展示 Diff，Terminal 始终弹出审批。浏览器、MCP 与 Skills 的配置见 [`docs/current-features.md`](./docs/current-features.md)。

常用命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm build` 使用 Electron Forge 生成当前平台安装产物。只生成未封装应用目录：

```bash
pnpm --filter @desktop-agent/desktop package
```

## 测试 Workflow

自动化测试用 Fake / Scripted runner，不打真实 LLM：

```bash
pnpm test
```

只跑 Workflow 相关：

```bash
pnpm exec vitest run \
  packages/orchestration/test \
  packages/storage/test/workflow-resume.integration.test.ts \
  apps/desktop/src/renderer/workflow-card.test.ts \
  apps/desktop/src/renderer/workflow-dag.test.ts \
  apps/desktop/src/worker/write-agent.e2e.test.ts
```

| 能力 | 测试 |
|---|---|
| DAG 调度、取消、超时、Retry | `packages/orchestration/test/workflow-engine.test.ts` |
| Tool Step、foreach、condition、嵌套 | `workflow-tool-step.test.ts`、`workflow-foreach.test.ts`、`workflow-condition.test.ts`、`workflow-nested.test.ts` |
| Saved Workflow / Args | `saved-workflow.test.ts` |
| Budget / Provider 限流 / 资源组 | `workflow-budget.test.ts`、`provider-semaphore.test.ts`、`resource-group.test.ts` |
| Journal Resume | `packages/storage/test/workflow-resume.integration.test.ts` |
| 依赖图 / 时间线 UI | `apps/desktop/src/renderer/workflow-dag.test.ts`、`workflow-card.test.ts` |
| 真实 `write_file` + Worktree | `apps/desktop/src/worker/write-agent.e2e.test.ts` |

桌面手测：`pnpm dev` 后打开 Git 仓库会话，让主 Agent 调用 Workflow 工具，例如「列出可用的 saved workflow」或「用 `repo-understand` 理解 `packages/orchestration`」。

内置模板：`repo-understand`、`architecture-review`、`code-review`（均必填 `args.target`）。也可把 YAML 放到项目 `.jojo/workflows/` 或 `~/.jojo/workflows/`（项目覆盖用户，再覆盖 builtin）。对话中会出现 WorkflowCard，可取消 / 恢复。

`explore` / `code-review` / `synthesize` 只读；`general` 写入独立 Worktree，主工作区与 Git Index 不变。没有窗口级 Playwright。

## 结构

```text
apps/desktop/             Electron Main、Preload、Renderer、Worker
packages/contracts/       Zod Schema、消息、事件与 IPC 契约
packages/agent-core/      不依赖 Electron 的 Agent 循环
packages/orchestration/   Sub-Agent、Workflow Engine、Isolation、Saved Workflow
packages/providers/       模型协议适配
packages/tools-node/      文件、目录、终端与权限 Gate
packages/storage/         JSONL Session / Workflow Journal 与普通配置
packages/extensions/      MCP 客户端、延迟工具目录与 Skills 发现
```

各 Workspace 的职责与安全边界见 [`docs/technical-implementation/`](./docs/technical-implementation/README.md)。

会话和配置在 Electron `userData`。API Key 由操作系统安全存储加密；普通配置和 JSONL 不含明文密钥。

## 当前验证范围

- Agent Core：工具循环、动态工具刷新、重复 Tool Call、拒绝后继续；
- Orchestration：Sub-Agent 生命周期、Profile / Tool Policy、Workflow DAG、Worktree 隔离、Budget、依赖图 UI；
- Extensions：Skill 发现 / 按需加载、MCP 连接状态和大工具集延迟激活；
- Tools：大文件截断、项目检索、修改 Diff、读后写冲突、精确编辑、回收站、符号链接逃逸和目录外审批；
- Storage：JSONL 损坏尾恢复、单会话运行锁、Workflow Journal Resume；
- Browser / 富内容：域名与 URL 校验、下载文件名净化、浏览器权限 Gate、视觉消息序列化；
- TypeScript、ESLint、Vitest；
- macOS arm64 Electron 生产 package。

真实 Provider 联调、代码签名 / notarization 和干净机器安装测试需要相应密钥及发布环境，不在默认离线测试中执行。

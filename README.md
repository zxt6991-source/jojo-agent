# Jojo Agent

本地优先的 Electron Coding Agent。一次对话绑定一个本地目录，模型可检索和阅读项目；主 Agent 修改文件或执行命令前会展示 Diff / 命令并逐次批准。后台 Sub-Agent 与声明式 Workflow DAG 可并行执行只读分析，或在独立 Git Worktree 中写入且不自动 Merge。核心 Runtime 通过稳定的公共 API 和组合层同时服务 Electron、普通 Node 测试与无界面 Server Host，不依赖 Renderer 或 Electron IPC。

上手细节见 [`docs/current-features.md`](./docs/current-features.md)。Sub-Agent / Workflow 设计以 [`docs/subagent-workflow-unified-design-roadmap.md`](./docs/subagent-workflow-unified-design-roadmap.md) 为准；与代码冲突时以 Contracts、Runtime 和测试为准。早期 MVP 规划仍见 [`ts-desktop-agent-mvp-roadmap.md`](./ts-desktop-agent-mvp-roadmap.md)。

## 已实现

- Electron Main / sandboxed Preload / React Renderer / Utility Process；
- OpenAI Chat Completions 兼容 Provider：自定义 Base URL、模型发现、逐轮选模型、流式输出；
- Agent Core：多轮工具循环、上下文估算、大结果回收、历史压缩、拒绝回填、重复调用保护；
- Runtime 公共边界：`AgentRuntime`、`RuntimeSession`、`RuntimeLane`、`RunHandle`、版本化 Contract，以及统一的 Provider / Tool / Permission / Approval / Memory / Hook 注入；
- Runtime Composition 与 App Service：同一套 Runtime 可由 Electron Worker、普通 Node 程序和 `apps/server` 的 headless 入口复用；
- Headless Network Server：版本化 Zod Protocol、Server Core、Control / Observer Lease、幂等 mutation、REST / WebSocket、远程审批与断线后 Run 查询恢复；
- Client SDK：`JojoClient` / `JojoSession` / `JojoRun` 远程对象模型，自动注入认证和幂等键，并以 WebSocket 事件 + REST Snapshot 恢复运行结果；
- 十个主 Agent 工具：`read_file`、`list_files`、`grep`、`glob`、`web_search`、`web_fetch`、`write_file`、`edit_file`、`delete_file`、`terminal`；
- 工作目录边界、真实路径 / 符号链接检查、写前冲突检测、精确编辑、回收站、Terminal 超时与进程组回收；会话删除通过 Main 生命周期门禁与 Storage tombstone / 跨实例串行化阻止晚到写入复活 JSONL；
- Desktop IPC 边界使用严格 Zod Schema 和负载大小限制，覆盖 Main ↔ Worker 命令与事件，以及 Preload 推送到 Renderer 的消息；非法消息会被拒绝并记录协议违规；
- 主会话文件修改与 Terminal 逐次审批；工作区外读取逐次审批；
- 多会话侧边栏、对话 / 轨迹视图、Markdown 消毒、审批弹窗、停止、加密 API Key；
- MCP（stdio / Streamable HTTP）与本地 `SKILL.md`；工具 Schema 过大时改为 manifest + describe/call；
- 受控 CDP 浏览器（沙箱或附加本机 Chrome）、图片附件与视觉消息；
- 后台 Sub-Agent：Profile（`explore` / `general` / `code-review` / `synthesize`，可叠加 user/project）、Tool Policy、Continue / Send / Close、Structured Output；
- Workflow DAG：依赖与并发、Timeout / Cancel、Retry、Typed Inputs、Tool Step、foreach / condition / 嵌套 Saved Workflow、Budget、资源组与 Provider 限流、JSONL Journal / Resume；
- 可写 Agent 强制 Git Worktree 隔离，Branch / Diff 可审查，默认不自动 Merge；
- WorkflowCard：步骤列表、依赖图、时间线、Usage、预算、错误码、结构化输出与 Isolation Diff；
- 生命周期 Hooks：用户 `~/.jojo/hooks.yml`、项目 `.jojo/hooks.yml`（fingerprint 信任 / 可禁用）、设置页状态与 Reload。

尚未实现：`jojo serve` 独立 CLI 产品化、Worker Runtime Backend、Workflow / Browser / Memory 远程 API、可视化 Workflow 编辑器、pipeline / human / HTTP Step、Scheduler、专用 Git 提交工具、自动更新与云同步。

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

Runtime 与真实 Electron 边界冒烟：

```bash
pnpm test:runtime-smoke
pnpm test:e2e:electron
```

`test:runtime-smoke` 不启动 Electron，验证 headless Runtime Composition；`test:e2e:electron` 使用离线 Scripted Provider 启动真实 Main、Preload、Renderer 与 Utility Process，不需要 API Key 或外网。

### Headless Server 与 Client SDK

`apps/server` 导出 `createNetworkServer()`，默认只允许监听 `127.0.0.1`；非回环地址必须同时显式启用 `allowRemote` 并配置 token。网络层提供 `/healthz`、`/readyz`、`/api/v1` REST 资源与 `/api/v1/events` WebSocket。

Client SDK 示例：

```ts
import { JojoClient } from '@desktop-agent/client';

const client = new JojoClient({
  baseUrl: 'http://127.0.0.1:7788',
  token: process.env.JOJO_SERVER_TOKEN
});

await client.connect();
const session = await client.createSession({ executionScope: { kind: 'none' } });
const run = await session.run({ input: '分析这个项目', providerId: 'openai', model: 'gpt-5', laneId: 'main' });
console.log(await run.result());
await client.close();
```

`pnpm build` 使用 Electron Forge 生成当前平台安装产物。只生成未封装应用目录：

```bash
pnpm --filter @desktop-agent/desktop package
```

## 测试

自动化测试用 Fake / Scripted runner，不打真实 LLM：

```bash
pnpm test
```

边界加固的关键覆盖：

| 能力 | 测试 |
|---|---|
| Runtime 公共 API / Contract Suite | `packages/agent-runtime/test/public-runtime.test.ts` |
| Node headless Runtime Composition | `packages/runtime-composition/test/headless-runtime.test.ts` |
| 无 Electron 的 Server Host 消费者 | `apps/server/src/server-runtime.test.ts` |
| Worker IPC strict schema / size guard | `packages/contracts/test/desktop-ipc.test.ts` |
| Preload push runtime validation | `apps/desktop/src/preload/push-validation.test.ts` |
| Session delete lease / JSONL 防复活 | `apps/desktop/src/main/session-lifecycle.test.ts`、`packages/storage/test/session-delete-race.test.ts` |
| 真实 Electron 离线冒烟 | `apps/desktop/e2e/smoke.spec.ts` |

Electron E2E 覆盖应用启动、离线回合、审批允许 / 拒绝、取消慢回合，以及运行中删除与并发发送竞态；删除场景还会重启应用确认会话和 JSONL 没有复活。CI 在 Linux 上通过 Xvfb 运行这组测试。

### Workflow

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

`explore` / `code-review` / `synthesize` 只读；`general` 写入独立 Worktree，主工作区与 Git Index 不变。

## 结构

```text
apps/desktop/             Electron Main、Preload、Renderer、Worker
apps/server/              无 Electron 的 headless Server Host 组合入口
packages/contracts/       Zod Schema、消息、事件与 IPC 契约
packages/agent/           模型、消息、工具执行原语与兼容 Agent 循环
packages/agent-runtime/   公共 Runtime API、Durable Operation、Lane、恢复与测试 Contract Suite
packages/runtime-composition/ Provider、Tool、权限、Memory、Hook 等 Runtime 能力组合
packages/app-service/     面向 Desktop / Server Transport 的 Runtime 应用服务
packages/server-protocol/ REST / WebSocket 共用的版本化 Zod Protocol
packages/server-core/     Connection、Lease、Idempotency、AuthZ 与命令协调
packages/server-http/     Fastify REST / WebSocket Transport
packages/client/          不依赖 Runtime 的 Jojo Server Client SDK
packages/orchestration/   Sub-Agent、Workflow Engine、Isolation、Saved Workflow
packages/browser-automation/ 可复用的 CDP 浏览器驱动与 Host 适配
packages/providers/       模型协议适配
packages/tools-node/      文件、目录、终端与权限 Gate
packages/storage/         SQLite Runtime、JSONL Session / Workflow Journal 与普通配置
packages/extensions/      MCP 客户端、延迟工具目录与 Skills 发现
packages/hooks/           生命周期 Hook Engine、hooks.yml 加载与项目信任
packages/memory/          会话压缩、记忆检索 / 候选与 Runtime Memory 适配
```

各 Workspace 的职责与安全边界见 [`docs/technical-implementation/`](./docs/technical-implementation/README.md)。

会话和配置在 Electron `userData`。API Key 由操作系统安全存储加密；普通配置和 JSONL 不含明文密钥。

## 当前验证范围

- Agent Core：工具循环、动态工具刷新、重复 Tool Call、拒绝后继续；
- Runtime：公共 API、跨 Host Contract Suite、headless Composition 与无 Electron Server 消费；
- Orchestration：Sub-Agent 生命周期、Profile / Tool Policy、Workflow DAG、Worktree 隔离、Budget、依赖图 UI；
- Extensions：Skill 发现 / 按需加载、MCP 连接状态和大工具集延迟激活；
- Hooks：配置校验、项目信任 / Disable、Shell 超时与输出上限、Runtime 恢复语义；
- Tools：大文件截断、项目检索、修改 Diff、读后写冲突、精确编辑、回收站、符号链接逃逸和目录外审批；
- Desktop 边界：Main ↔ Worker 与 Preload 推送的运行时校验、IPC 大小限制、协议违规拒绝；
- Storage：SQLite Runtime conformance / crash resume、JSONL 损坏尾恢复、单会话运行锁、删除 tombstone / 并发防复活、Workflow Journal Resume；
- Browser / 富内容：域名与 URL 校验、下载文件名净化、浏览器权限 Gate、视觉消息序列化；
- Electron E2E：离线启动 Main / Preload / Renderer / Worker、回合、审批、取消、运行中会话删除与重启恢复；
- TypeScript、ESLint、Vitest；
- macOS arm64 Electron 生产 package。

真实 Provider 联调、代码签名 / notarization 和干净机器安装测试需要相应密钥及发布环境，不在默认离线测试中执行。

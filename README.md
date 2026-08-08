# TypeScript Desktop Agent

一个本地优先的 Electron AI Agent MVP。它可以流式对话、读取项目文件、列出目录，并在用户逐次批准后执行本地命令。实现以 [`ts-desktop-agent-mvp-roadmap.md`](./ts-desktop-agent-mvp-roadmap.md) 为范围基准。

## 已实现

- Electron Main / sandboxed Preload / React Renderer / Utility Process 四层运行时；
- OpenAI Chat Completions 兼容 Provider，支持流式文本、分片 Tool Call、超时、取消和错误分类；
- 纯 TypeScript Agent Core，支持多轮工具循环、拒绝回填、重复调用保护和最大迭代限制；
- `read_file`、`list_files`、`terminal` 三个工具；
- 工作目录约束、真实路径与符号链接检查、输入/输出上限、Terminal 超时与进程组回收；
- Terminal 每次审批，工作目录外文件读取逐次审批；
- JSONL 会话创建、重命名、删除、恢复和损坏尾记录容错；
- 操作系统安全存储加密 API Key；
- Markdown 消毒、工具卡片、审批弹窗、停止按钮与 Provider 设置；
- Electron Forge、ASAR 和 Electron Fuses 生产打包配置。

明确未实现路线图中 MVP 之后的写文件、代码编辑、MCP、Skills、浏览器、子 Agent、记忆与自动化。

## 开发

要求 Node.js 22+ 与 pnpm 10+。

```bash
pnpm install
pnpm dev
```

首次启动后：

1. 打开“设置”，填写 OpenAI 兼容 API Base URL、模型和 API Key；
2. 选择一个本地项目目录创建会话；
3. 输入任务。文件读取与目录列出默认限制在项目中，Terminal 始终弹出审批。

常用质量命令：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm build` 使用 Electron Forge 生成当前平台安装产物；只生成未封装的应用目录可运行：

```bash
pnpm --filter @desktop-agent/desktop package
```

## 结构

```text
apps/desktop/          Electron Main、Preload、Renderer、Worker
packages/contracts/   Zod Schema、消息、事件与 IPC 契约
packages/agent-core/  不依赖 Electron 的 Agent 循环
packages/providers/   模型协议适配
packages/tools-node/  文件、目录、终端与权限 Gate
packages/storage/     JSONL Session 与普通配置
```

会话和配置存储在 Electron `userData` 目录。API Key 独立保存在加密文件中，普通配置和 JSONL 会话均不包含明文密钥。

## 当前验证范围

- Agent Core：工具循环、重复 Tool Call、拒绝后继续；
- Tools：大文件截断、符号链接逃逸、目录外审批；
- Storage：JSONL 损坏尾恢复、单会话运行锁；
- TypeScript、ESLint、Vitest；
- macOS arm64 Electron 生产 package。

真实 Provider 联调、代码签名/notarization 和干净机器安装测试需要相应密钥及发布环境，因此不在默认离线测试中执行。

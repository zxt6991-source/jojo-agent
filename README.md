# TypeScript Desktop Agent

一个本地优先的 Electron Coding Agent。它可以流式对话、检索和读取项目，在用户审阅 Diff 并逐次批准后修改文件或执行本地命令。实现以 [`ts-desktop-agent-mvp-roadmap.md`](./ts-desktop-agent-mvp-roadmap.md) 为范围基准。

## 已实现

- Electron Main / sandboxed Preload / React Renderer / Utility Process 四层运行时；
- OpenAI Chat Completions 兼容 Provider，支持自定义服务地址、模型发现、逐轮模型选择和统一流事件；
- 上下文窗口估算、大 Tool Result 回收、安全历史压缩、缓存用量归一化与输出截断续写；
- 纯 TypeScript Agent Core，支持多轮工具循环、拒绝回填、重复调用保护和最大迭代限制；
- `read_file`、`list_files`、`grep`、`glob`、`write_file`、`edit_file`、`delete_file`、`terminal` 八个工具；
- 修改前读取检查、SHA-256/mtime/大小冲突检测、精确文本编辑、原子替换与应用回收站；
- 工作目录约束、真实路径与符号链接检查、输入/输出上限、Terminal 超时与进程组回收；
- 文件修改展示逐行 Diff 并每次审批；Terminal 每次审批，工作目录外文件读取逐次审批；
- 按项目目录分组的多会话侧边栏（也可切成单列表），支持搜索、相对时间和运行/审批状态点；默认模型生成标题/摘要，以及会话创建、重命名、删除、恢复和损坏尾记录容错；
- 操作系统安全存储按 Provider 加密 API Key；
- Markdown 消毒、可折叠工具行、对话/轨迹视图、审批弹窗、停止按钮、模型服务设置与输入框模型选择；
- Electron Forge、ASAR 和 Electron Fuses 生产打包配置。
- MCP stdio / Streamable HTTP 客户端、工具发现、连接状态与逐次审批；超过 24 个 MCP 工具时按搜索结果延迟激活；
- 本地 `SKILL.md` 发现、启停和 `load_skill` 按需注入，自动扫描项目内 `.codex/skills` 与 `.agents/skills`。

尚未实现浏览器、子 Agent、记忆、自动化和专用 Git 写操作。

## 开发

要求 Node.js 22+ 与 pnpm 10+。

```bash
pnpm install
pnpm dev
```

首次启动后：

1. 打开“设置”，配置 OpenAI Chat Completions 兼容服务的 API Base URL 和 API Key，再获取模型列表并选择默认模型；
2. 选择一个本地项目目录创建会话；
3. 在输入框右下角选择本轮模型并输入任务。项目内检索默认允许；每次文件修改会先展示 Diff，Terminal 也始终弹出审批。

配置扩展时点击左下角“MCP 与 Skills”：面板通过 MCP / 技能标签页、搜索、状态和开关管理已发现的扩展；右上角“配置 MCP”可编辑 Server JSON，“目录设置”可添加额外 Skill 目录。Skill 也会从应用 `userData/skills`、用户级 `.agents` / `.codex` Skills 目录以及项目 `.codex/skills` / `.agents/skills` 自动发现。Agent 可经审批使用 `install_skill` 非交互安装项目 Skill，并在当前 Turn 动态刷新。所有外部 MCP 工具调用都会逐次请求批准。

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
packages/extensions/  MCP 客户端、延迟工具目录与 Skills 发现
```

各 Workspace 的职责、接口边界、核心流程、安全约束和演进方案见 [`docs/technical-implementation/`](./docs/technical-implementation/README.md)。

会话和配置存储在 Electron `userData` 目录。API Key 独立保存在加密文件中，普通配置和 JSONL 会话均不包含明文密钥。

## 当前验证范围

- Agent Core：工具循环、动态工具刷新、重复 Tool Call、拒绝后继续；
- Extensions：Skill 元数据发现/按需加载、MCP 连接状态和大工具集延迟激活；
- Tools：大文件截断、项目检索、修改 Diff、读后写冲突、精确编辑、回收站、权限位保留、符号链接逃逸和目录外审批；
- Storage：JSONL 损坏尾恢复、单会话运行锁；
- TypeScript、ESLint、Vitest；
- macOS arm64 Electron 生产 package。

真实 Provider 联调、代码签名/notarization 和干净机器安装测试需要相应密钥及发布环境，因此不在默认离线测试中执行。

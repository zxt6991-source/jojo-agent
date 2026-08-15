# TypeScript Desktop Agent

一个本地优先的 Electron Coding Agent。它可以流式对话、检索和读取项目，在用户审阅 Diff 并逐次批准后修改文件或执行本地命令。实现以 [`ts-desktop-agent-mvp-roadmap.md`](./ts-desktop-agent-mvp-roadmap.md) 为范围基准。

## 已实现

- Electron Main / sandboxed Preload / React Renderer / Utility Process 四层运行时；
- OpenAI Chat Completions 兼容 Provider，支持自定义服务地址、模型发现、逐轮模型选择和统一流事件；
- 上下文窗口估算、大 Tool Result 回收、安全历史压缩、缓存用量归一化与输出截断续写；
- 纯 TypeScript Agent Core，支持多轮工具循环、拒绝回填、重复调用保护和最大迭代限制；
- `read_file`、`list_files`、`grep`、`glob`、`web_search`、`web_fetch`、`write_file`、`edit_file`、`delete_file`、`terminal` 十个工具；
- 修改前读取检查、SHA-256/mtime/大小冲突检测、精确文本编辑、原子替换与应用回收站；
- 工作目录约束、真实路径与符号链接检查、输入/输出上限、Terminal 超时与进程组回收；
- 文件修改展示逐行 Diff 并每次审批；Terminal 每次审批，工作目录外文件读取逐次审批；
- 按项目目录分组的多会话侧边栏（也可切成单列表），支持搜索、相对时间和运行/审批状态点；默认模型生成标题/摘要，以及会话创建、重命名、删除、恢复和损坏尾记录容错；
- 操作系统安全存储按 Provider 加密 API Key；
- Markdown 消毒、可折叠工具行、对话/轨迹视图、审批弹窗、停止按钮、模型服务设置与输入框模型选择；
- Electron Forge、ASAR 和 Electron Fuses 生产打包配置。
- MCP stdio / Streamable HTTP 客户端、工具/资源/提示词发现、`list_changed` 在线刷新、会话恢复、显式重连与逐次审批；工具 Schema 超过上下文 token 预算时自动切换为 manifest + describe/call；
- 本地 `SKILL.md` 发现、启停和 `load_skill` 按需注入，自动扫描项目内 `.codex/skills` 与 `.agents/skills`。
- 独立沙箱窗口中的 CDP 受控浏览器，支持多页面管理、稳定元素引用、安全自动重定位、内存内动作录制/回放与受限失败恢复，以及结构读取、等待、滚动、点击、输入、按键、下拉选择、工作区文件上传、后退、刷新、截图、下载和页面诊断；普通搜索和公开页阅读走 `web_search` / `web_fetch`，不经过浏览器。
- 图片附件、对话内预览、JSONL 恢复和 OpenAI Chat Completions 视觉消息。

尚未实现子 Agent、记忆、自动化和专用 Git 写操作。

## 开发

要求 Node.js 22+ 与 pnpm 10+。

```bash
pnpm install
pnpm dev
```

首次启动后：

1. 打开“设置”，配置 OpenAI Chat Completions 兼容服务的 API Base URL 和 API Key，再获取模型列表并选择默认模型；
2. 选择一个本地项目目录创建会话；
3. 在输入框右下角选择本轮模型并输入任务；可用“＋”添加最多 4 张图片。项目内检索以及公开网页搜索/抓取默认允许；每次文件修改会先展示 Diff，Terminal 也始终弹出审批。

“设置 → 浏览器”可启停浏览器工具并配置域名白名单（支持 `*.example.com`）。未列出的域名首次打开或新建页面时需批准；网页点击、输入、按键、下拉选择、文件上传、关闭页面和下载始终逐次批准。`browser_read` 会为可见语义元素返回 `e1`、`e2` 形式的会话内引用，后续元素动作优先使用 `ref`；DOM 重排导致原 selector 失效时，Main 会根据标签、名称、角色及稳定属性重新定位，候选含糊或置信度不足则停止并要求重新读取。浏览器流程可在当前应用进程内录制并回放；开始录制和回放都需批准，录制列表不回显输入文字，回放只重试能够确认动作尚未执行的元素缺失/等待超时。普通搜索和已知公开 URL 应使用 `web_search` / `web_fetch`，不要打开沙箱浏览器。页面列表、切换、等待、滚动、后退、刷新以及 Console / 网络 / 页面错误诊断自动允许，但顶层导航仍受 Main 进程域名规则约束。网页弹窗只允许已批准域名，其他弹窗被拒绝并回报 Agent。上传文件必须位于当前工作区且通过真实路径和大小检查；浏览器下载保存在应用 `userData/browser-downloads/<session-id>/`。

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
- Browser/Rich content：域名与 URL 校验、下载文件名净化、浏览器权限 Gate、页面结构格式化和视觉消息序列化；
- TypeScript、ESLint、Vitest；
- macOS arm64 Electron 生产 package。

真实 Provider 联调、代码签名/notarization 和干净机器安装测试需要相应密钥及发布环境，因此不在默认离线测试中执行。

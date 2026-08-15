# Desktop Agent 当前功能与上手指南

> 文档状态：2026-08-11
> 当前版本：0.1.0（MVP + Coding Agent Phase 1 + Phase 3 MCP/Skills）
> 说明：本文以当前仓库代码为准，只描述已经实现的能力。路线图中的规划不等于可用功能。

## 1. 先用一分钟认识项目

Desktop Agent 是一个本地优先的 Electron 桌面 AI Agent。它把一次 AI 对话绑定到一个本地目录，让模型在明确的权限边界内了解项目并执行操作。

当前版本最适合以下场景：

- 阅读和解释一个本地代码仓库；
- 查找项目结构、配置和实现入口；
- 在审阅逐行 Diff 后创建、精确编辑或删除项目内文本文件；
- 在用户逐次批准后运行测试、构建或其他本地命令；
- 观察 Git 工作区中已有或本轮产生的文件变化。

它现在可以完成范围明确的小型代码任务，并可通过 MCP 与本地 Skills 扩展能力，但仍不是完整的自主编程 Agent：没有专用 Git 写操作、浏览器和子 Agent 等能力。

专用写工具只允许修改工作目录内的 UTF-8 文本，执行前展示 Diff 并询问一次。获批的终端命令仍可能绕过这些文件工具限制并修改其他内容，因此用户仍需检查完整命令。

## 2. 五分钟运行起来

### 2.1 环境要求

- Node.js 22 或更高版本；
- pnpm 10 或更高版本；
- 一个支持 OpenAI Chat Completions、SSE 流式响应和 Tool Calls 的模型服务；
- Git 为可选依赖，仅“文件修改审阅”功能需要它。

先确认本机版本：

```bash
node --version
pnpm --version
git --version
```

### 2.2 安装并启动开发版

在仓库根目录执行：

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会启动 Electron Forge 开发环境，而不是浏览器网页。

### 2.3 完成首次配置

应用启动后：

1. 点击左下角“设置”；
2. 填写 API Base URL，例如 `https://api.openai.com/v1`；
3. 填写 API Key，点击“刷新模型”从 Provider 的 `/models` 接口获取可用模型；
4. 选择默认模型并保存；
5. 点击“新建会话”或“选择项目目录”，选择一个本地目录；
6. 在输入框右下角选择本轮使用的模型，输入任务并按 Enter 发送，Shift+Enter 可换行。

Base URL 应填写到服务的 API 根路径。应用会自动在末尾追加 `/chat/completions`，不要填写完整的 Chat Completions 接口地址。

已获取的模型列表会缓存在普通配置中。修改 Base URL 或 API Key 后，保存时会自动重新查询模型；如果 Provider 不兼容 `/models` 接口，设置页会直接显示错误。

### 2.4 建议用这组任务验证环境

先发送一个只读任务：

```text
先列出项目两层目录，再阅读 README.md，用三点说明这个项目是做什么的。暂时不要运行命令。
```

如果只读任务正常，再验证终端审批：

```text
请运行项目的测试，并总结结果。不要修改文件。
```

模型请求 `terminal` 时，界面底部会显示待执行的命令。检查无误后选择“允许一次”或按 Enter；选择“拒绝”或按 Esc 会把拒绝结果返回给模型，而不会直接中断整轮对话。

## 3. 使用时需要理解的六个概念

| 概念 | 在本项目中的含义 |
|---|---|
| 会话（Session） | 一段可恢复的对话，同时绑定一个固定的本地工作目录。会话可创建、重命名和删除。 |
| 工作目录（Workspace） | Agent 默认可以查看的目录，也是相对路径、终端 `cwd` 和 Git 修改审阅的边界。 |
| 一轮（Turn） | 从用户发送一条消息开始，到模型完成、失败或被取消为止。同一会话一次只能运行一轮。 |
| Provider | 把内部消息和工具定义转换成 OpenAI Chat Completions 请求的模型适配器。 |
| 工具调用（Tool Call） | 模型不是直接操作电脑，而是请求应用执行 `read_file`、`list_files` 或 `terminal`。 |
| 审批（Approval） | 对高风险或越界操作进行的一次性授权。目前终端命令和工作目录外文件读取需要审批。 |

选择目录不是简单的界面操作，而是在划定本会话的权限范围。若要处理另一个项目，建议创建新会话并选择对应目录。

## 4. 一条消息在应用中如何流转

```mermaid
flowchart LR
    U["用户 / React 界面"] -->|"白名单 IPC"| M["Electron Main"]
    M -->|"启动任务"| W["Utility Process Worker"]
    W --> A["Agent Core"]
    A <-->|"流式请求"| P["OpenAI 兼容 Provider"]
    A --> G["权限 Gate"]
    G -->|"自动允许或用户批准"| T["本地工具"]
    T -->|"Tool Result"| A
    A -->|"Agent Event"| M
    M -->|"状态与增量文本"| U
    W --> S["JSONL 会话存储"]
```

实际流程如下：

1. Renderer 把消息通过 Preload 暴露的白名单 API 交给 Main；
2. Main 将任务转给独立的 Utility Process Worker；
3. Worker 读取会话历史，并调用 Agent Core；
4. Provider 向 `{baseUrl}/chat/completions` 发起流式请求；
5. 模型如需工具，Agent Core 先经过权限 Gate，再执行或等待用户审批；
6. 工具结果作为 Tool Message 回填给模型，模型可以继续调用工具或给出最终回答；
7. 消息追加写入 JSONL，同时通过事件把增量文本和工具状态显示到界面。

Worker 与界面进程分离，因此 Agent 运行异常不必直接获得 Renderer 的 Node.js 权限；Worker 意外退出后，Main 会尝试在 1 秒后重新启动它。

## 5. 当前可以做什么

### 5.1 会话与聊天界面

- Electron 单窗口、单实例运行；
- 按本地项目目录分组展示会话，也可切换为按最近活动排列的单列表；
- 项目按最近会话排序；同一项目内默认只展开最近 5 个会话，当前会话若在更早记录中会自动露出；
- 标题栏内搜索会话标题或项目名，最多返回 20 条；占位「新会话」不进入搜索；
- 会话行显示相对时间，悬停后换成重命名和删除；运行中为蓝点，等待审批为黄点；
- 在左侧项目模块中创建、选择、重命名和删除会话；
- 新会话发送第一条提问时，使用默认模型生成标题，失败时回退到提问内容；
- 每个会话绑定所属项目的本地工作目录；
- 流式展示模型文本；
- 渲染 Markdown 标题、列表、引用和代码块；
- 使用 DOMPurify 清理模型生成的 HTML；
- 将持久化消息折叠为对话节点流：用户气泡、助手正文、工具行、压缩标记和内部系统行；
- 工具行默认折叠，标题旁显示路径或命令摘要，展开后查看 IN/OUT；
- 历史工具调用会随会话重新载入一起恢复，不再只存在于当前轮次的临时状态里；
- 标题栏可在「对话」和「轨迹」之间切换；轨迹按轮次列出用户、助手和工具记录，选中后查看输入与输出；
- 向上滚动会暂停自动跟随，避免检查旧记录时被新输出打断；
- Enter 发送，Shift+Enter 换行；
- 运行期间可停止当前轮次；
- 展示加载、空状态和错误信息；
- 配置 OpenAI Chat Completions 兼容 Provider，并逐轮选择其模型；
- 审批卡片支持按钮以及 Enter 允许、Esc 拒绝快捷键。

工具调用和结果会写入会话记录。重新打开会话时，对话视图会按原始顺序恢复工具行；轨迹视图按轮次展示同一份记录。

### 5.2 Git 工作区修改审阅

如果会话目录位于 Git 仓库中，应用可以：

- 读取已跟踪和未跟踪文件的修改；
- 展示文件级新增、删除行数；
- 在审阅面板中切换文件并查看逐行 Diff；
- 提示二进制文件，截断过大的 Diff；
- 将结果限制在当前会话选择的工作目录中，即使该目录只是 Git 仓库的一个子目录；
- 一轮任务结束后，优先只展示相对任务开始时发生变化的文件。

这里的审阅面板是**只读视图**，不能接受、撤销或编辑补丁。空会话即使工作区已有修改也不会显示修改卡；发送过消息后才会显示。非 Git 目录仍能对话和使用工具，只是没有 Diff 审阅结果。

当前最多收集 100 个变更文件，每个文件的 Patch 最多保留约 250,000 字节，超过限制时会显示截断提示。

## 6. 八个内置工具

### 6.1 `read_file`：读取文本文件

输入示例：

```json
{ "path": "README.md" }
```

行为和限制：

- 按 UTF-8 文本读取；
- 相对路径以会话工作目录为基准，也接受绝对路径；
- 默认最多读取 512,000 字节，超出部分截断；
- 通过真实路径检查 `..` 和符号链接，避免伪装成目录内文件；
- 工作目录内自动允许，目录外必须逐次批准；
- 目标不存在或不是普通文件时返回失败结果。

### 6.2 `list_files`：递归查看目录

输入示例：

```json
{ "path": ".", "depth": 2 }
```

行为和限制：

- 只允许列出工作目录内部内容；
- 默认深度为 3，可选范围为 0～5；
- 默认最多返回 500 个条目；
- 忽略 `.git`、`node_modules`、`dist`、`out`、`coverage`、`.next` 和 `.cache`；
- 跳过指向工作目录外部的符号链接；
- 结果按名称排序，并用 `dir` 或 `file` 标记类型。

### 6.3 `grep` 与 `glob`：项目检索

- `glob` 按 `**/*.ts` 一类模式查找文件；
- `grep` 按固定文本查找并返回 `路径:行号:内容`，支持 glob 和大小写选项；
- 两者只搜索工作目录内，忽略 `.git`、`node_modules`、构建和缓存目录，并限制结果数量。

### 6.4 `write_file`、`edit_file` 与 `delete_file`：修改文本文件

- `write_file` 创建新文件，或完整替换已经完整读取的现有文件；
- `edit_file` 只替换已读取文件中的精确文本；匹配不唯一时必须显式选择全部替换；
- `delete_file` 删除已经读取的文件；
- 三者只允许工作目录内 UTF-8 文本，每次执行前展示新增/删除行和逐行 Diff；
- 审批前和执行时都会检查 SHA-256、mtime 与大小，外部编辑后拒绝盲目覆盖；
- 覆盖和删除前把原文件保存到 Electron `userData/trash/<session-id>/`；写入使用同目录临时文件原子替换，并保留原权限位。

### 6.5 `terminal`：执行本地程序

输入示例：

```json
{
  "command": "pnpm",
  "args": ["test"],
  "cwd": ".",
  "timeoutMs": 120000
}
```

行为和限制：

- 每次执行都需要用户明确批准；
- 以“可执行程序 + 参数数组”启动，默认不经过 Shell；
- `command` 只能填写可执行文件名或路径，参数必须逐项放入 `args`；
- 继承开发环境时会移除 API Key、Token、密码、凭据以及危险的 Node 启动参数；
- `cwd` 必须在会话工作目录内；
- stdout 和 stderr 会流式显示；
- 默认超时 120 秒，可选范围为 1～300 秒；
- 默认最多收集 1,000,000 字节输出；
- 停止轮次或超时后会尝试终止整个进程组。

因为默认不使用 Shell，`&&`、管道、重定向和通配符不会自动生效。模型仍可能请求显式运行 `sh -c` 等命令；这类请求同样会完整显示在审批卡片中，应特别谨慎检查。

## 7. 权限规则

| 操作 | 工作目录内 | 工作目录外 |
|---|---|---|
| `read_file` | 自动允许 | 每次询问 |
| `list_files` | 自动允许 | 拒绝 |
| `grep` / `glob` | 自动允许 | 拒绝 |
| `write_file` / `edit_file` / `delete_file` | 每次展示 Diff 并询问 | 拒绝 |
| `terminal` | 每次询问 | `cwd` 不允许越出工作目录 |
| MCP 外部工具 | 每次询问 | 由 MCP Server 自身决定；审批前需检查参数 |

这些规则限制的是内置工具的直接行为，不是操作系统级沙箱。尤其是终端命令获批后，会以当前应用进程继承的用户权限运行；命令本身仍可能访问工作目录外资源。当前权限 Gate 只校验终端的 `cwd`，不会解析命令参数的语义。

拒绝审批后，Agent Core 会生成错误码为 `user_denied` 的 Tool Result 并继续循环，模型可以解释未完成原因或尝试不需要该权限的方案。权限策略直接拒绝则使用 `permission_denied`。

## 8. Agent 循环与 Provider

### 8.1 Agent 循环

一轮任务会把用户消息加入历史，然后反复执行“调用模型 → 执行工具 → 回填结果”，直到模型不再调用工具。默认最多执行 12 次模型迭代。

当前保护措施包括：

- 默认最多进行 12 次模型迭代；
- 同一 Tool Call ID 只执行一次；
- 未知工具返回失败结果；
- 工具失败或审批被拒绝后仍允许模型继续回答；
- 同一会话不能并行运行两个轮次；
- 用户可取消当前轮次。

对外事件还包括归一化 `usage`、`context.updated` 和 `output.continuing`，用于展示缓存用量、上下文压缩与截断续写状态。

### 8.2 Provider 与上下文

当前仅注册 `OpenAICompatibleProvider`，支持：

- SSE 流式文本；
- 分片 Tool Call 参数聚合与 JSON 解析；
- input/output/cache read/cache write token usage 事件；
- AbortSignal 取消；
- 90 秒默认模型请求超时；
- 认证、限流、服务异常、网络、超时和空响应错误分类。

应用按 Provider 配置创建 adapter。上下文接近预算时会回收大型 Tool Result，并在不拆散 Tool Call/Result 配对的前提下压缩旧历史；`length` 会触发有界自动续写。界面展示上下文估算和本轮 token/cache usage。

当前不支持其他模型协议。DeepSeek、Kimi、GLM 等服务需要提供兼容的 Chat Completions、SSE、Function Tools 和 `/models` 接口。

### 8.3 MCP 与 Skills

点击左下角“MCP 与 Skills”可编辑扩展配置并查看连接/发现状态。面板采用 MCP / 技能标签页和紧凑列表，支持按名称、描述、来源或路径搜索；每行直接展示来源、连接状态或工具数量，并用开关启停。原始 MCP JSON 和额外 Skill 目录收进右上角的高级配置入口，日常管理不需要直接面对配置文本。

MCP 支持：

- 以 `command` + `args` 启动本地 stdio server；
- 连接 Streamable HTTP endpoint；
- 自动发现工具并映射为 `mcp__<server>__<tool>`；
- Remote MCP OAuth：支持浏览器授权、PKCE、动态客户端注册、refresh token 和安全凭据存储；
- Streamable HTTP 可选择 `auto` 协商或 `legacy` 直接使用 2025 `initialize`，兼容不支持 `server/discover` 的服务；
- 显示连接中、已连接、停用、失败状态及工具数量；
- 每个外部工具调用都先请求一次批准；
- 总工具数超过 24 时只先暴露搜索工具，按任务关键词激活最多 12 个匹配工具。

Skills 会从 `userData/skills`、用户级 `~/.agents/skills` / `~/.codex/skills` / `~/.config/agents/skills`、设置目录以及项目 `.codex/skills` / `.agents/skills` 扫描 `SKILL.md`。文件使用成熟 YAML 解析器读取必填的 `name` 和 `description` frontmatter；同 ID 时按“项目 > 用户 > 自定义 > 默认”覆盖。发现结果明确记录 Skill 根目录及 `scripts`、`templates`、`references` 文件，`load_skill` 也会把这些绝对目录告诉模型。设置面板支持创建、编辑、导入、导出、用本地目录更新和将整个 Skill 根目录移入废纸篓，并可按 Skill ID 启停。

模型可通过需审批的 `install_skill` 把 Skill 非交互安装到当前项目 `.agents/skills`；工具固定使用 `--yes --agent universal --copy`，并在安装后验证文件、动态刷新目录，使新 Skill 在当前 Turn 的下一步即可加载。Agent Core 会阻止同一轮第三次执行完全相同的工具调用，并识别不同查询返回相同只读内容的情况；触发后只再允许两个恢复工具步骤，随后暂停工具并要求模型根据已有证据直接回答，避免重复搜索耗尽迭代上限。

MCP 的 `env` 和静态 HTTP `headers` 位于当前用户可读的普通配置；OAuth client registration、token 和 PKCE/discovery 状态使用操作系统安全存储加密。不要把长期高权限 token 手工写入 headers。
启用 stdio server 会在应用连接时立即以当前用户权限启动其 `command`。逐次审批只覆盖后续 MCP 工具调用，不能限制 server 进程的启动代码，因此只能配置可信程序。

## 9. 会话、配置和密钥保存在哪里

所有数据都放在 Electron 的 `app.getPath('userData')` 目录中，实际根路径随操作系统和应用名称变化。目录内部结构为：

```text
userData/
├── config.json                 # Base URL、默认模型和可用模型列表
├── config.json.bak             # 上一次普通配置的备份
├── secrets/
│   └── provider-key.bin        # 操作系统安全存储加密后的 API Key
├── sessions/
│   └── <session-id>.jsonl      # 会话元数据、标题变更和消息
├── skills/                     # 全局安装的本地 SKILL.md 目录
└── trash/
    └── <session-id>/<entry>/   # 文件工具覆盖/删除前的副本与恢复元数据
```

会话存储具有以下特征：

- 采用 JSONL 追加写入，每条记录带 `schemaVersion: 1`；
- 保存用户消息、助手消息、Tool Call 和 Tool Result；
- 应用重启后可恢复会话与消息；
- 损坏或未写完的行会被跳过，其他完整记录仍可读取；
- 会话列表按对应文件的修改时间排序；
- 删除会话会直接删除对应 JSONL 文件，界面没有回收站。

普通配置通过临时文件替换，并在覆盖前保留 `.bak`。API Key 与普通配置分开保存，Renderer、`config.json` 和会话 JSONL 都不持久化明文密钥。设置中的 API Key 留空表示保留原密钥，当前界面没有单独的“清除密钥”操作。

## 10. 进程和包的职责

项目使用 pnpm workspace，包含一个桌面应用和六个共享包：

| 模块 | 当前职责 | 新手何时需要看 |
|---|---|---|
| `apps/desktop` | Electron Main、Preload、React Renderer、Worker 和打包配置 | 修改界面、IPC、窗口、任务编排或打包时 |
| `packages/contracts` | 消息、事件、IPC、配置类型及 Zod Schema | 新增跨进程字段或能力时先看 |
| `packages/agent-core` | 不依赖 Electron 的 Agent 工具循环 | 修改模型与工具如何反复协作时 |
| `packages/providers` | OpenAI Chat Completions 兼容协议 | 接入或排查模型服务时 |
| `packages/tools-node` | 文件、目录、终端工具和权限 Gate | 新增工具或修改审批策略时 |
| `packages/storage` | JSONL 会话和普通配置存储 | 修改持久化格式时 |
| `packages/extensions` | MCP stdio/HTTP 客户端、延迟工具发现和 Skills | 修改外部扩展机制时 |

四类运行时职责：

- Renderer：显示会话、对话节点流、轨迹、审批、设置和 Diff；
- Preload：通过 `contextBridge` 只暴露白名单业务 API；
- Main：管理窗口、IPC、目录选择、安全存储、Git Diff 和 Worker 生命周期；
- Worker：运行 Provider、Agent Core、工具、权限判断和会话写入。

## 11. 想修改某个功能，从哪里开始

| 目标 | 主要入口 |
|---|---|
| 修改 React 界面和交互 | `apps/desktop/src/renderer/main.tsx` |
| 修改对话节点折叠或工具摘要 | `apps/desktop/src/renderer/conversation.ts` |
| 修改对话 / 轨迹展示组件 | `apps/desktop/src/renderer/ConversationViews.tsx` |
| 修改左侧栏分组、搜索或会话行 | `apps/desktop/src/renderer/sidebarSnapshot.ts`、`apps/desktop/src/renderer/Sidebar.tsx` |
| 修改全局样式 | `apps/desktop/src/renderer/styles.css` |
| 修改 Renderer 可调用的 API | `apps/desktop/src/preload/preload.ts` |
| 新增或修改 IPC | `packages/contracts/src/desktop.ts`（由 `src/index.ts` 聚合导出）→ `apps/desktop/src/preload/preload.ts` → `apps/desktop/src/main/main.ts` |
| 修改窗口、安全存储或 Worker 管理 | `apps/desktop/src/main/main.ts` |
| 修改 Git 文件变化采集 | `apps/desktop/src/main/workspace-changes.ts` |
| 修改一轮 Agent 的执行逻辑 | `packages/agent-core/src/index.ts` |
| 修改 Provider HTTP/超时/错误处理 | `packages/providers/src/openai-compatible-provider.ts` |
| 修改 Chat Completions 请求或流解析 | `packages/providers/src/chat-completions-request.ts`、`packages/providers/src/chat-completions-stream.ts` |
| 修改底层 SSE 解码 | `packages/providers/src/sse.ts` |
| 新增工具或调整权限 | `packages/tools-node/src/index.ts` |
| 修改 MCP 或 Skills | `packages/extensions/src/index.ts` |
| 修改会话或配置格式 | `packages/storage/src/index.ts` |
| 修改 Electron 打包和安全 Fuses | `apps/desktop/forge.config.ts` |

新增跨进程功能时，通常需要先在 `packages/contracts` 定义 Schema、类型和 IPC 名称，再依次接通 Preload、Main/Worker，最后接入 Renderer。不要让 Renderer 直接访问 Node.js API。

## 12. 开发、测试与打包

常用命令：

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 启动 Electron 开发环境 |
| `pnpm typecheck` | 运行 TypeScript 类型检查，不生成文件 |
| `pnpm lint` | 运行 ESLint，任何 warning 都视为失败 |
| `pnpm test` | 一次性运行 Vitest 测试 |
| `pnpm test:watch` | 监听文件变化并运行 Vitest |
| `pnpm build` | 通过 Electron Forge 为当前平台生成分发产物 |
| `pnpm --filter @desktop-agent/desktop package` | 只生成未封装的应用目录 |

当前共有 69 个单元测试，覆盖：

- Agent 工具循环、重复 Tool Call 和审批拒绝后继续；
- 动态工具刷新、MCP 大工具集延迟激活和 Skill 按需加载；
- Provider 请求序列化、SSE 分片解析、Tool Call 聚合、错误分类、超时与取消；
- 大文件截断、目录符号链接逃逸和工作目录外读取审批；
- JSONL 损坏尾恢复和单会话并发锁；
- Git 已跟踪/未跟踪文件 Diff、非 Git 目录和会话子目录范围。

提交代码前建议依次运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm build` 成本更高，涉及 Electron 打包或准备发布时再运行。GitHub Actions 会执行依赖安装、Lint、类型检查、测试和 Linux Electron Package 构建。

## 13. Electron 安全措施

当前已启用：

- `nodeIntegration: false`；
- `contextIsolation: true`；
- Renderer sandbox；
- `webSecurity: true`；
- CSP 限制；
- 禁止创建任意新窗口；
- 限制跨来源导航；
- IPC 发送方和来源校验；
- IPC 参数通过 Zod 验证；
- Preload 不暴露原始 `ipcRenderer`；
- Renderer 不直接访问 Node.js、文件系统或子进程；
- 生产构建使用 ASAR；
- Electron Fuses 关闭 RunAsNode、`NODE_OPTIONS` 和调试参数等能力。

这些措施降低了 Renderer 被利用后的风险，但不替代终端命令审批。批准命令前仍应阅读完整命令和参数。

## 14. 当前尚未实现

- 通用 unified patch 输入工具（当前提供完整写入与精确文本编辑）；
- Git 提交、分支等专用写操作；
- 多 Provider 注册、列表和会话级切换；
- 浏览器自动化；
- 图片等多模态消息；
- 子 Agent 和工作流；
- 长期记忆和向量数据库；
- 定时任务与后台自动化；
- 自动更新；
- 云端账号、同步和协作；
- 代码签名与 macOS notarization；
- 默认 CI 中的真实模型集成测试。

判断某项能力是否存在时，以本节、八个内置工具和实际源码为准，不要只依据路线图或界面外观。

## 15. 常见问题

### 为什么模型只回答，不读取项目？

是否调用工具由模型决定。可以在任务中明确写出“先列出目录并阅读相关文件，再回答”。如果所用模型不支持 Tool Calls，它只能进行普通文本对话。

### 为什么设置保存成功，但发送后报错？

设置页只保存配置，不主动验证服务。请依次检查 Base URL 是否只填到 API 根路径、模型名是否存在、API Key 是否有效，以及服务是否支持流式 Chat Completions 与 Tool Calls。

### 为什么 `&&` 或管道没有效果？

`terminal` 默认直接启动一个程序，不经过 Shell。优先让模型把任务拆成多次清晰的命令。若它请求 `sh -c`，审批前需要额外检查其中的完整脚本字符串。

### 为什么看不到文件修改卡？

请确认目录位于 Git 仓库中、会话已经发送过至少一条消息，并且修改位于会话选择的目录内。该视图最多展示 100 个文件，过大内容会截断。

### 点击停止后，已经写入的内容会回滚吗？

不会。停止会取消模型请求并尝试终止正在运行的进程，但不会撤销已经完成的命令、文件变化或已追加的会话消息。

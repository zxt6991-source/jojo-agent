# Tools Node 技术实现方案

路径：`packages/tools-node`  
包名：`@desktop-agent/tools-node`

## 1. 定位与安全边界

Tools Node 提供 Node.js 环境中的本地能力及默认权限策略，公开 API 包含：

- `ReadFileTool`：读取 UTF-8 文件；
- `ListFilesTool`：递归列出目录；
- `GrepTool` / `GlobTool`：有界项目检索；
- `WebSearchTool` / `WebFetchTool`：公开网页搜索与 HTTP(S) 抓取；
- `WriteFileTool` / `EditFileTool` / `DeleteFileTool`：可审阅的项目内文本修改；
- `TerminalTool`：启动单个本地程序；
- `DefaultPermissionGate`：决定允许、拒绝或请求用户审批；
- `createDefaultTools()`：为每次调用创建一组新的默认工具实例。

权限 Gate 负责调用前决策，工具执行器负责最终边界校验。调用方即使绕过 Gate 直接执行工具，仍不能越过目录限制；`TerminalTool` 还会再次要求 `context.approved`，避免绕过审批直接启动进程。

## 2. 模块结构

`src/index.ts` 只承担稳定的公开导出和默认工具组装，具体职责按模块拆分：

| 模块 | 职责 |
|---|---|
| `inputs.ts` | 十个工具共用的 Zod 输入 schema 与默认值 |
| `workspace-paths.ts` | 工作目录规范化、真实路径解析和包含关系判断 |
| `tool-result.ts` | 统一构造工具执行结果 |
| `read-file-tool.ts` / `file-snapshots.ts` | 文件读取、字节截断与读后快照 |
| `list-files-tool.ts` | 有界目录遍历、排序、忽略规则与符号链接防护 |
| `grep-tool.ts` / `glob-tool.ts` / `search-files.ts` | 固定文本、glob 检索与安全遍历 |
| `web-url.ts` / `web-html.ts` | HTTP(S) URL 校验、SSRF 地址拦截与 HTML 清洗 |
| `web-search-tool.ts` / `web-fetch-tool.ts` | 公开搜索回退链与有界 GET 抓取 |
| `file-tools.ts` / `file-mutation.ts` | 修改准备、审批后二次校验与原子替换 |
| `unified-diff.ts` / `file-trash.ts` | Diff 预览与覆盖/删除备份 |
| `terminal-tool.ts` | 子进程启动、输出收集、取消、超时与进程回收 |
| `default-permission-gate.ts` | 输入预检和默认权限决策 |

这种结构让路径策略和输入规则只有一个来源，同时保持 `@desktop-agent/tools-node` 的原有导入方式不变。

## 3. 路径安全模型

所有路径以会话工作目录为基准，统一经过以下流程：

1. 使用 `path.resolve` 生成绝对路径；
2. 使用 `realpath` 解析工作目录和真实目标；
3. 使用 `path.relative` 判断目标是否仍在真实根目录内。

该流程同时处理 `../` 路径穿越、绝对路径、指向目录外的符号链接和不同平台的路径分隔符。创建新文件时解析并校验其真实父目录；已有目标使用自身真实路径，因此写工具也不能通过符号链接越界。

目录遍历会对每个条目再次执行 `realpath` 和包含关系检查。越界符号链接、损坏链接以及遍历期间消失或无法解析的条目都会被跳过。

## 4. 工具实现

### 4.1 `read_file`

读取 UTF-8 普通文件，默认最多返回 512,000 字节。实现只读取“上限 + 1”字节来判断是否截断，不会先把整个大文件载入内存。完整读取会记录 SHA-256、mtime 和大小，供后续修改做并发冲突检测。工作目录内自动允许，目录外需要逐次批准；`web_fetch` 写入 `os.tmpdir()/jojo-web-fetch/` 的临时文件视为例外，Gate 与执行器都会自动允许且不写入修改快照。直接调用执行器时，其他目录外读取同样要求 `context.approved`。目录目标返回 `not_a_file`，超限结果设置 `truncated` 并附带截断位置。

### 4.2 `list_files`

递归列出工作目录内目录，深度范围为 0～5，默认深度为 3、最多返回 500 个条目。每层按名称排序，并忽略 `.git`、`node_modules`、`dist`、`out`、`coverage`、`.next` 和 `.cache`。

输出格式固定为 `dir <relative-path>` 或 `file <relative-path>`。达到条目上限时停止遍历，设置 `truncated` 并追加 `[entry limit reached]`。目录外列表请求始终拒绝，不提供审批升级。

### 4.3 `grep` 与 `glob`

两者只遍历工作目录内的普通文件，忽略常见依赖、构建和缓存目录，并跳过越界符号链接。`glob` 支持 `*`、`**` 和 `?`；`grep` 做固定文本逐行搜索，支持大小写控制和可选 glob，跳过大于 1 MB 或含 NUL 的文件。结果上限为 1～1,000 条。`grep` 额外允许搜索 `web_fetch` 落盘的临时文件；`glob` 仍拒绝工作目录外路径。

### 4.4 `web_search` 与 `web_fetch`

这两个工具负责普通公开信息检索，不经过 Electron 浏览器。Worker 提示模型：已知公开 URL 和搜索查询应使用它们；登录墙、需要 JavaScript 渲染或交互的页面才使用 `browser_*`。

`web_search` 按环境变量组装后端：存在 `BRAVE_SEARCH_API_KEY`、`TAVILY_API_KEY` 或 `SERPER_API_KEY` 时优先走对应 API，否则依次请求 DuckDuckGo HTML、DuckDuckGo Lite 和 Bing HTML。任一后端返回至少一条结果即停止；全部失败才报 `network`。查询经 Zod 校验后自动允许。

`web_fetch` 只做 HTTP(S) GET。Gate 用 `parseHttpUrl` 拒绝非 HTTP(S)、内嵌凭据和非法 URL，不在 Gate 里做 DNS。执行器对每个跳转目标调用 `assertSafeHttpUrl`：解析全部 A/AAAA 记录，拦截链路本地、组播、全零/广播、AWS `fd00:ec2::254` 以及 Google metadata 主机。回环和 RFC1918 私网允许，便于抓取本机开发服务。默认跟随最多 10 次重定向、30 秒超时；清洗后正文不超过 64 KB 时内联返回，更大页面最多读取 5 MB 并写入 `os.tmpdir()/jojo-web-fetch/`，工具结果只含 URL、状态、类型、大小、标题大纲、前 40 行预览和文件路径，随后用 `read_file` / `grep` 按需查看。超过 24 小时的临时文件会在下次落盘时清理。HTML 默认转为 Markdown。二进制 Content-Type 只回报类型，不回填正文。

网页正文和搜索摘要一律视为不可信外部数据。

### 4.5 文件修改工具

`write_file` 可创建文件或替换完整读取的文件，`edit_file` 对已读取文件执行唯一的精确文本替换，`delete_file` 删除已读取文件。统一限制为工作目录内、不超过 2 MB 的 UTF-8 文本。

Gate 在请求审批前准备 unified diff；执行器获批后再次准备同一修改并复核快照，因此审批等待期间发生外部编辑会返回 `file_conflict`。覆盖或删除前按会话保存原文件和元数据到应用回收站；写入采用目标同目录的独占临时文件和原子 rename，并保留现有权限位。关键约束在执行器内再次检查，不能通过绕过 Gate 直接写入。

### 4.6 `terminal`

使用 `spawn(command, args)` 执行单个程序，设置 `shell: false`，参数不会经过 shell 拼接。`command` 含空白字符会以 `invalid_input` 在审批前拒绝，避免模型把整条命令误当成可执行文件名。输入限制如下：

- `args` 最多 100 项；
- `cwd` 默认是会话工作目录且必须位于该目录内；
- `timeoutMs` 范围为 1～300 秒，默认 120 秒；
- 汇总输出默认最多 1,000,000 字节。

子进程环境继承父进程的开发工具路径，但会剔除名称表明其为 API Key、Token、密码、凭据或私钥的变量，同时移除 `NODE_OPTIONS` 和 `ELECTRON_RUN_AS_NODE`；`SSH_AUTH_SOCK` 作为 Git SSH 所需的非密钥套接字路径保留。这样运行 `/usr/bin/env` 不会把 Provider 或 IDE 注入的 Token 回填给模型。

每次调用都需审批。Gate 会先校验输入和 `cwd`，无效或越界调用不会弹出无意义的审批；执行器会再次校验 `context.approved` 和 `cwd`。

stdout/stderr 会实时上报，并在上限内汇总到最终结果。非 Windows 平台使用独立进程组；取消或超时先向进程组发送 `SIGTERM`，1 秒后仍未退出则升级为 `SIGKILL`。Windows 上终止子进程本身。最终结果区分：

| 场景 | `code` |
|---|---|
| 启动失败 | `spawn_failed` |
| 非零退出 | `nonzero_exit` |
| 用户/上游取消 | `cancelled` |
| 超时 | `timeout` |

Terminal 审批只代表用户同意运行该命令，不是操作系统沙箱。获批程序仍继承应用用户权限，其参数也可能主动访问工作目录外的资源。

## 5. 默认权限矩阵

| 工具 | 工作目录内 | 工作目录外 |
|---|---|---|
| `read_file` | 自动允许 | 逐次询问；执行时复核审批状态。`web_fetch` 临时落盘文件自动允许 |
| `list_files` | 自动允许 | 拒绝 |
| `grep` / `glob` | 自动允许 | 拒绝；`grep` 对 `web_fetch` 临时落盘文件自动允许 |
| `web_search` | 输入校验通过后自动允许 | 不依赖工作目录 |
| `web_fetch` | URL 语法校验通过后自动允许；执行时再解析 DNS 并拦截危险地址 | 不依赖工作目录 |
| `write_file` / `edit_file` / `delete_file` | 逐次展示 Diff 并询问；执行时复核审批与快照 | 拒绝 |
| `terminal` | 输入及 `cwd` 校验通过后逐次询问 | 越界 `cwd` 直接拒绝 |

未知工具和不符合 Zod schema 的输入均由 Gate 拒绝。Agent Core 在工具执行完成后写入真实 `callId`，因此工具实现无需了解模型调用 ID。

## 6. 输出与资源限制

文件字节数、目录条目数、递归深度、终端参数数、运行时间和终端汇总输出都设置了硬上限，避免大输入占满 Agent 上下文或应用内存。

Terminal 达到输出上限后不再收集或上报更多内容，但会继续等待进程自然退出、取消或超时。超时和取消采用有界的两阶段终止策略，避免只发送 `SIGTERM` 时进程长期不退出。

## 7. 测试方案

自动化测试当前覆盖：

1. 文件读取与字节截断；
2. 目录稳定排序、深度、忽略规则和条目上限；
3. 越界符号链接防护；
4. 目录外读取审批和 Terminal 越界 `cwd` 预拒绝；
5. Terminal 直接调用的审批复核、输出、非零退出、取消和超时；
6. 写入前读取、精确编辑歧义、审批 Diff 与审批后外部修改冲突；
7. 覆盖/删除备份、原子写入后的内容和权限位；
8. glob/grep 过滤、忽略目录与结果截断；
9. 默认工具顺序及实例隔离；
10. 公开网页 URL 安全、HTML 清洗、搜索回退、本地抓取、大页面落盘与危险重定向拦截。

后续可继续补充平台专项测试，包括 Terminal 进程树回收、Windows 终止行为，以及多字节 UTF-8 恰好落在截断边界时的展示策略。

## 8. 扩展约束

- 新工具必须在执行器内部保留关键安全校验，不能只依赖 Gate。
- 新增路径能力时复用 `workspace-paths.ts`，避免重新实现字符串前缀判断。
- 新增 HTTP 抓取能力时复用 `web-url.ts`，对每个跳转目标重新解析并拦截危险地址。
- 写工具必须继续采用临时文件与原子替换，并在执行前生成可审阅变更和复核读后快照。
- 新增终端能力时维持 `shell: false`；若确需 shell，应作为独立高风险工具和审批类型设计。
- 能力继续增长时，可在 contracts 中引入只读、写入、进程和网络标签，供审批 UI 统一展示风险级别。

# Tools Node 技术实现方案

路径：`packages/tools-node`  
包名：`@desktop-agent/tools-node`

## 1. 定位与安全边界

Tools Node 提供 Node.js 环境中的本地能力及默认权限策略，公开 API 包含：

- `ReadFileTool`：读取 UTF-8 文件；
- `ListFilesTool`：递归列出目录；
- `TerminalTool`：启动单个本地程序；
- `DefaultPermissionGate`：决定允许、拒绝或请求用户审批；
- `createDefaultTools()`：为每次调用创建一组新的默认工具实例。

权限 Gate 负责调用前决策，工具执行器负责最终边界校验。调用方即使绕过 Gate 直接执行工具，仍不能越过目录限制；`TerminalTool` 还会再次要求 `context.approved`，避免绕过审批直接启动进程。

## 2. 模块结构

`src/index.ts` 只承担稳定的公开导出和默认工具组装，具体职责按模块拆分：

| 模块 | 职责 |
|---|---|
| `inputs.ts` | 三个工具共用的 Zod 输入 schema 与默认值 |
| `workspace-paths.ts` | 工作目录规范化、真实路径解析和包含关系判断 |
| `tool-result.ts` | 统一构造工具执行结果 |
| `read-file-tool.ts` | 文件读取与字节截断 |
| `list-files-tool.ts` | 有界目录遍历、排序、忽略规则与符号链接防护 |
| `terminal-tool.ts` | 子进程启动、输出收集、取消、超时与进程回收 |
| `default-permission-gate.ts` | 输入预检和默认权限决策 |

这种结构让路径策略和输入规则只有一个来源，同时保持 `@desktop-agent/tools-node` 的原有导入方式不变。

## 3. 路径安全模型

所有路径以会话工作目录为基准，统一经过以下流程：

1. 使用 `path.resolve` 生成绝对路径；
2. 使用 `realpath` 解析工作目录和真实目标；
3. 使用 `path.relative` 判断目标是否仍在真实根目录内。

该流程同时处理 `../` 路径穿越、绝对路径、指向目录外的符号链接和不同平台的路径分隔符。目标不存在时 `realpath` 会失败：Gate 将其转为拒绝原因，直接执行工具时由 Agent Core 转为工具错误。当前工具只处理已有目标路径。

目录遍历会对每个条目再次执行 `realpath` 和包含关系检查。越界符号链接、损坏链接以及遍历期间消失或无法解析的条目都会被跳过。

## 4. 工具实现

### 4.1 `read_file`

读取 UTF-8 普通文件，默认最多返回 512,000 字节。实现只读取“上限 + 1”字节来判断是否截断，不会先把整个大文件载入内存。工作目录内自动允许，目录外需要逐次批准；直接调用执行器时，目录外读取同样要求 `context.approved`。目录目标返回 `not_a_file`，超限结果设置 `truncated` 并附带截断位置。

### 4.2 `list_files`

递归列出工作目录内目录，深度范围为 0～5，默认深度为 3、最多返回 500 个条目。每层按名称排序，并忽略 `.git`、`node_modules`、`dist`、`out`、`coverage`、`.next` 和 `.cache`。

输出格式固定为 `dir <relative-path>` 或 `file <relative-path>`。达到条目上限时停止遍历，设置 `truncated` 并追加 `[entry limit reached]`。目录外列表请求始终拒绝，不提供审批升级。

### 4.3 `terminal`

使用 `spawn(command, args)` 执行单个程序，设置 `shell: false`，参数不会经过 shell 拼接。输入限制如下：

- `args` 最多 100 项；
- `cwd` 默认是会话工作目录且必须位于该目录内；
- `timeoutMs` 范围为 1～300 秒，默认 120 秒；
- 汇总输出默认最多 1,000,000 字节。

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
| `read_file` | 自动允许 | 逐次询问；执行时复核审批状态 |
| `list_files` | 自动允许 | 拒绝 |
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
6. 默认工具顺序及实例隔离。

后续可继续补充平台专项测试，包括 Terminal 进程树回收、Windows 终止行为，以及多字节 UTF-8 恰好落在截断边界时的展示策略。

## 8. 扩展约束

- 新工具必须在执行器内部保留关键安全校验，不能只依赖 Gate。
- 新增路径能力时复用 `workspace-paths.ts`，避免重新实现字符串前缀判断。
- 新增写工具时采用临时文件与原子替换，并在执行前生成可审阅变更。
- 新增终端能力时维持 `shell: false`；若确需 shell，应作为独立高风险工具和审批类型设计。
- 能力继续增长时，可在 contracts 中引入只读、写入、进程和网络标签，供审批 UI 统一展示风险级别。

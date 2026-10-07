# OpenCode、Hermes Agent 对 jojo 的借鉴分析

研究日期：2026-10-07（Asia/Shanghai）  
对象：当前工作区中的 Jojo Agent、anomalyco/opencode、NousResearch/hermes-agent  
交付类型：源码对比与演进建议，不包含功能实现。

## 1. 结论与决策建议

**两个项目都值得借鉴，但 jojo 最需要的是补齐能力之间的闭环。** OpenCode 更适合参考代码修改、诊断反馈、上下文维护和 Provider 适配；Hermes 更适合参考历史会话召回、技能沉淀和长期助手的知识组织。

jojo 已有统一 Runtime、权限治理、持久团队、Workflow DAG、Durable Scheduler、Channel Outbox、记忆候选治理与语义检索。继续增加一套调度器、记忆系统或子 Agent 框架，收益有限，反而会扩大维护面。建议沿现有 Contracts → Runtime/App Service → Host/Channel 的边界扩展。

优先做三个方向：

1. **验证反馈闭环**：代码变更后能明确记录哪些验证通过、哪些失败、哪些未运行；先用项目已有 lint/typecheck/test，再按需接 LSP。
2. **可追溯的历史会话召回**：用户问“上次为什么这样选”时，先找到原始消息及时间、项目、来源，再形成回答。现有 memory_search 不等于检索所有历史会话。
3. **保留语义的大结果回收**：当前任务、已加载技能、关键错误应优先保留；旧工具输出降级成可回读引用，避免固定头尾截断丢失中间证据。

随后建设“任务经验 → Skill 草稿 → 检查 → 激活 → 使用反馈”的链路。受控 Patch、多协议 Provider、会话撤销和程序化工具编排分阶段推进。

这些是基于代码结构和使用路径的工程判断，**没有进行三项目的真实模型成功率、延迟或成本对照测试**，不能据此宣称某项目整体更可靠或更高效。

## 2. 研究范围与版本

### 2.1 固定的源码基线

| 项目 | 分支 / 本地基线 | 本次核对的 Commit |
|---|---|---|
| jojo | 当前工作区；开始研究时 `git status --short` 为空 | `8547a1e8237aa88aa520261971f0078718efce5b` |
| OpenCode | 官方仓库 `dev` | `ecc4916b5a9608c30e6dd58a67f2137b594407ca` |
| Hermes Agent | 官方仓库 `main` | `7583a6610ef7226a3dfc1d6721582210d742754a` |

外部源码按固定 SHA 阅读；文末链接可复查该版本。官网文档作为补充，属于滚动更新内容。

核对重点包括：OpenCode 的 edit/apply_patch、snapshot/revert、compaction、Provider transform、Agent 配置与 SDK；Hermes 的 session_search、skills、skill_manage、/learn、记忆存储、Prompt 缓存、execute_code/RPC，以及工具延迟发现的评测方案；jojo 的对应 Contracts、Runtime、Storage、Extensions、Memory、Tools、Server 和编排入口。

本次不是全仓安全审计，也没有运行外部项目。项目 README 的定位性描述与源码实现分开使用；“未发现”表示在本次核对范围内没有找到对应实现，不代表对所有外部扩展作穷尽证明。

### 2.2 两个容易误读的细节

- Hermes README 宣传 FTS5 会话检索配合 LLM 总结，但本次版本的 `tools/session_search_tool.py` 明确采用原始数据库消息返回，**不调用 LLM**。本文以这个当前实现为准。[H1]
- OpenCode 官网当前明确说明 **LSP 默认关闭**，并提醒语言服务器可能失同步、占内存或拖慢工作流；项目已有诊断 CLI 在很多场景更合适。因此本文推荐按需诊断，而非全语言 LSP 默认常驻。[O7]

jojo 部分旧技术说明仍写着“长期记忆和定时自动化尚未实现”，或把会话正文描述为 JSONL；当前 README 和源码已具备记忆、Scheduler、Runtime SQLite。本文以当前源码为判断基准，不把旧文档中的缺失项重新列成需求。

## 3. 项目定位与适合借鉴的层次

| 维度 | OpenCode | Hermes Agent | jojo 的借鉴方向 |
|---|---|---|---|
| 核心定位 | 面向软件开发的 Coding Agent | 长期使用、跨会话学习的通用助手 | 保持本地优先，补强 Coding 与长期助手的结合 |
| 技术风格 | TypeScript；本次核心源码使用 Effect 服务 / Layer；客户端与服务端接口 | Python 为主要 Agent/工具实现，Gateway 与大量集成；本次已有其他客户端目录 | 学接口与机制，避免迁移对方运行框架 |
| 工具执行 | 文件修改、Patch、诊断反馈、MCP、会话变更关联 | 通用工具、技能管理、历史召回、程序化工具调用 | 复用 jojo Tool/Permission Contract |
| 会话与上下文 | 工具结果 prune、摘要、模型预算、快照撤销 | 原文检索、会话谱系、有限窗口读取、缓存稳定性 | 分清事实来源、上下文投影和长期知识 |
| 经验积累 | 可配置 Agent / Skills 与开发工作流 | 提示驱动的技能沉淀、技能更新、受限记忆 | 在候选治理之上增加程序性知识 |
| 后台执行 | 本文重点未评估其全部后台能力 | Gateway、cron、多终端环境 | 改进 jojo 既有 Scheduler/Channel 产品路径 |

OpenCode 最有价值的启发是让开发动作具备明确的变更与验证反馈；Hermes 最有价值的启发是让日常任务留下可检索证据和可复用程序。二者都不构成替换 jojo Runtime 的理由。

## 4. jojo 当前基线：已有能力与增量空间

| 能力 | 本次 jojo 核对结果 | 增量空间 |
|---|---|---|
| Runtime 公共边界 | AgentRuntime / Session / Lane / RunHandle，Composition 与 App Service | 将新增能力挂到公共服务，而非只写在 Electron Worker |
| 权限与沙箱 | Governance、指纹 Grant、Domain Gate、Process Sandbox | 新入口继续逐次进行相同治理 |
| 文件修改 | 精确文本替换、读前快照、冲突检测、审批 Diff、临时文件 rename、回收站 | 多文件 Patch、验证反馈、可撤销变更日志 |
| 上下文 | 固定头尾回收、预算估算、原子 Tool 配对、压缩投影、Memory handoff | 按用途保留内容、按需回读、实际 usage 校准 |
| 记忆 | Markdown、候选治理、触发召回、FTS/语义混合检索 | 单独检索未沉淀为 memory 的历史消息 |
| Skills / MCP | Skill metadata 目录和按需加载，资源目录发现，MCP 延迟发现 | Skill 草稿与版本来源；目录膨胀时的检索与评测 |
| Spawn / Team / Workflow | Profile、持久 Inbox/Task、隔离 Worktree、DAG 与预算 | 完成结果的质量门槛和证据回传 |
| Scheduler / Channels | Durable SQLite、运行历史、恢复、Telegram/飞书、审批和 Outbox | 面向常用任务的创建、排障与结果模板 |
| Provider | 当前内置注册项为 OpenAI Chat Completions 兼容；另有动态贡献注册边界 | 原生协议、模型能力声明与协议回放测试 |
| Server / SDK | 版本化 Zod、REST/WS、幂等、Lease、断线快照恢复、JojoClient | API Schema 与 SDK/文档自动校验；后续 ACP |
| 评测 | Fake/Scripted 单测、Runtime/Electron 冒烟、记忆检索指标 | 真实模型的任务成功率与效率 A/B |

主要本地证据：[文件修改](../packages/tools-node/src/file-mutation.ts)、[文件快照](../packages/tools-node/src/file-snapshots.ts)、[上下文](../packages/agent/src/context-manager.ts)、[投影](../packages/agent-runtime/src/context/projection.ts)、[Memory Runtime](../packages/memory/src/runtime.ts)、[Skills](../packages/extensions/src/skills.ts)、[Provider Registry](../packages/providers/src/registry.ts)、[Server Protocol](../packages/server-protocol/src/index.ts)。

注意：jojo 的 `FileSnapshotRegistry` 用于判断文件是否在读后变化，不是 OpenCode 那种可按会话操作撤销的内容快照。这两种机制不能因为名称相似就视为同一能力。

## 5. 借鉴一：代码修改与验证反馈闭环

### 5.1 OpenCode 的实际机制

`edit.ts` 在编辑后通知 LSP 更新文件，并将诊断反馈放回工具结果；`apply_patch.ts` 先解析 Patch、准备变更和审批信息，再执行写入并收集诊断。它还提供多种文本匹配策略，且对过大的匹配跨度和非唯一匹配设置拒绝条件。[O1][O2]

值得借鉴的是“写入 → 反馈 → 修复”的链路。宽松匹配只是其中一个实现选择，不应作为首要目标；`apply_patch` 的存在也不代表其整个多文件写入具有数据库级原子性。

### 5.2 jojo 的最小实现

先增加可选 `VerificationProfile`，声明项目的 lint、typecheck、test 命令，以及超时和预算。项目配置只提供建议命令，**不因为文件来自项目仓库就取得执行授权**；运行仍进入 Terminal/Process Sandbox/Governance。

每次 Run 保存验证记录：

- 验证命令、cwd、代码版本或变更标识；
- 开始时间、退出码、输出引用；
- `passed / failed / skipped / cancelled`；
- 验证覆盖的范围与最终变更是否晚于验证。

Agent 最终回答和 UI 都应读取这份事实记录。必须区分“文件已写入”与“验证通过”；最后一次修改发生在测试之后时，不应继续显示该修改已被验证。

LSP 后续作为独立可选服务：按 Workspace/语言启用，具备启动超时、资源限制、版本标识与失败降级。先支持 TypeScript 等主要使用语言；不在第一阶段下载几十种语言服务器。

### 5.3 实现入口与验收

入口：`packages/tools-node`（执行及结果）、`packages/agent-runtime`（Run 事实记录）、`packages/contracts`（验证状态）、`apps/desktop`（结果展示）；可通过现有 Hooks 提供触发点，但共享事实不能只保存在 Host Hook 中。

验收：测试失败会进入下一轮修复；取消后显示 cancelled；未运行显示 skipped；项目命令不能扩大权限；修改后旧验证失效；断线重连能找回同一验证结果。

## 6. 借鉴二：原始历史会话召回

### 6.1 Hermes 的实际机制

当前 `session_search` 根据参数提供发现、读取、锚点附近滚动和最近会话浏览；结果保留 session/message 等定位信息。实现按会话谱系去重，对 cron 来源降低排序优先级，并隐藏部分内部会话来源；读取形态限制单消息内容，避免一条旧工具结果重新撑爆上下文。[H1][H2]

最有价值的细节是：**自动化会话会污染普通检索排名**。定时日报大量重复项目名时，直接 BM25 排序容易挤掉用户真正问过的决策。jojo 已有 Scheduler 与 Team，尤其需要考虑来源分层。

### 6.2 jojo 的最小实现

新增独立 `session_search` / `session_read_window` 能力，底层读取 Runtime SQLite 正文，避免重新依赖旧 JSONL。记忆存储继续保存经过整理的长期知识，历史检索负责找原始证据。

第一版以 FTS 为主，返回 `sessionId、entryId/seq、时间、项目、来源、角色、snippet`。默认优先当前项目的人机主会话；Scheduler、Team、Spawn 的输出通过来源筛选或降权进入结果。对新建会话、压缩、Fork、Lane/Run 等关系明确建模，不能把所有有 parent 的记录都当成同一对话。

检索结果应可点击跳到原会话，窗口读取按总字符、单条消息和页数限制。敏感字段、内部事件和工具原始负载不默认全部索引；删除会话后同步清理索引，永久删除记录仍具有优先权。

查询范围由当前用户与执行身份确定。飞书群聊、远程 Client 或 Team Member 调用时，不能仅凭 `scope=all` 读到所有私人对话。复用 App Service 的身份与访问控制，查询前过滤允许的会话集合。

### 6.3 实现入口与验收

入口：`packages/storage/src/sqlite-runtime-store.ts`、`packages/app-service` 的会话查询边界、`packages/contracts/application`、Runtime Tool 装配及桌面跳转；FTS 算法可参考现有 Memory Index，但两种索引保留各自生命周期。

验收：能找回中文改写、错误码、旧设计选择；自动日报不能淹没主会话；结果可定位原文；已删除会话不可检索；跨项目与 Channel 身份不可越权；每次返回满足大小限制。

不建议第一版加一个独立 LLM 摘要器。先验证检索质量，当前 Agent 可以基于有限原文解释结论，减少无来源摘要和额外费用。

## 7. 借鉴三：上下文的分层保留与回读

### 7.1 OpenCode 与 Hermes 的启发

OpenCode 的 prune 反向遍历旧工具结果，保护近期工具输出、跳过 `skill`，达到一定可回收量才标记旧结果已压缩；Compaction 另有近期尾部保留与摘要处理。预算判断还使用模型限制及 usage 中的 input/output/cache 等信息。[O3]

Hermes 的记忆存储有硬字符预算，保存会话稳定的 Prompt 快照；Prompt 缓存代码区分稳定前缀和动态内容，并按 Provider 路由处理缓存标记。[H5][H6]

可以借鉴内容用途与时间的分层，以及稳定 Prompt 的思想。不要原样照搬 OpenCode 的固定 token 常量，也不要把 Hermes 的字符预算当成所有模型的精确 token 预算。

### 7.2 jojo 的最小实现

jojo 当前 `reclaimToolResults` 对超过 12,000 字符的结果保留头尾各 4,000 字符。这个确定性实现成本低，但测试输出中部的失败、Skill 中部的约束和文档中的关键表格可能丢失。

建议分三层处理：

| 内容 | 请求上下文中的策略 | 完整内容的位置 |
|---|---|---|
| 当前用户约束、未完成任务、必要 Skill 指令 | 优先保留；容量不足明确处理 | 原始 SessionEntry / Skill 版本 |
| 最近步骤的错误与验证结果 | 保留重点与有限原文 | ToolResult / Artifact |
| 旧搜索结果、文件读取、重复工具输出 | 简短摘要或索引引用 | 可按范围回读的持久结果 |

回收策略依据 tool 类别和语义，不只依据字符数；结果写入独立持久引用，并提供 `result_read` 类工具按字符或行窗口读取。优先复用已有 Artifact/资源访问机制，避免再建一套文件协议。

重要细节：jojo `load_skill` 用 `loadedSkillIds` 防止重复读取。若 Skill 正文被压缩掉，但这个集合仍认为已加载，模型可能既缺约束又无法重新获得正文。新增保护策略时要同时校验“该版本正文是否仍可见”，或允许按精确版本回读。

完整历史保持可审计，prune 只改变请求投影。Provider usage 用来观察估算偏差，不能替代请求前预算；overflow 后最多执行有界的再压缩与重试，不允许陷入重试循环。

### 7.3 实现入口与验收

入口：`packages/agent/src/context-manager.ts`、`packages/agent-runtime/src/context`、`packages/extensions/src/skills.ts`、`packages/tools-node/src/artifact-storage.ts` 与附件资源访问边界。

验收：关键失败位于输出中段时仍可找回；Skill 压缩后可恢复准确版本；Tool Call/Result 保持配对；原始历史不被破坏；回读执行相同资源访问校验；可观察 reclaimed tokens、压缩次数及 overflow 重试次数。

## 8. 借鉴四：把任务经验沉淀成 Skill

### 8.1 Hermes 的实际机制与边界

Hermes `skills_list` 只提供目录信息，`skill_view` 按需返回正文和资源；`skill_manage` 管理技能文件。`/learn` 用普通 Agent Turn 汇总用户给定来源或刚完成的流程，再通过现有工具生成 Skill；大型材料采用精简 SKILL.md 加按主题拆分的 references。[H3][H4]

其 Prompt 指引将任务相关流程、坑点和偏好优先归入 Skill，把始终相关的事实放入受限 memory。这里的“学习”主要是提示、工具和文件的持续改进，不能理解为模型权重自动训练。[H4][H5]

边界也要看到：当前 agent-created Skill 的安全扫描是可选配置，默认不启用；扫描异常路径也不等价于严格 fail closed。因此应参考知识生命周期，不能照搬这项默认治理策略。[H3]

### 8.2 jojo 的最小实现

复用已有 Memory Candidate 的触发信号和 evidence 管线，增加 Skill Candidate 类型；事实、规则与可执行流程分别进入合适的归宿，避免同一经验复制到 Memory、Skill、Workflow 三处。

推荐流程：

```mermaid
flowchart LR
    E[已完成任务及验证证据] --> C[经验候选]
    C --> D[Skill 草稿或既有 Skill 的变更]
    D --> L[格式与依赖检查]
    L --> R[Diff 审阅与权限决策]
    R --> A[激活指定版本]
    A --> U[后续使用]
    U --> F[失败与修正证据]
    F --> C
```

优先提供显式“把这次流程保存为技能”，降低起步复杂度；再增加低频自动候选。一次性网页摘要、未经验证的猜测、外部文档自带指令不应自动晋升为经验。

草稿建议包含：触发条件、输入输出、依赖、过程、已知失败、验证办法、来源会话/工具证据、版本与适用平台；长文放 references，脚本放 scripts。生成时不固化私有 token、临时路径、OS 用户名或个人邮件地址。

更新既有技能应先读当前版本，再生成 Diff；进入用户级目录要走现有安装/写入治理，不能利用“模型在学习”绕过权限。候选生成不自动扩张授权或修改 Team/Provider 配置。

### 8.3 实现入口与验收

入口：`packages/memory/src/candidates` 的候选证据、`packages/extensions/src/skills.ts`、`skill-installer.ts`、Extensions Contract 和 Skills 设置页。草稿与已激活技能分开扫描，避免半成品进入目录。

验收：同主题先更新已有技能；草稿可预览和删除；格式无效不可激活；具备来源与版本；回滚后下一 Turn 用正确内容；技能使用失败可以产生修正候选；治理拒绝不会改变当前可用技能。

## 9. 借鉴五：受控多文件 Patch 与撤销

### 9.1 分开处理两个需求

**Patch 输入**解决模型如何表达一批相关修改；**撤销日志**解决如何恢复 Agent 已经造成的变更。两者独立建设，不能把“支持 Diff”当成“可以安全 Undo”。

OpenCode 的 apply_patch、分级文本匹配以及独立 snapshot Git 目录提供了参考。它的 snapshot 与 session patch 关联，revert/unrevert 在会话非忙碌时处理变更与撤销状态。[O1][O2][O4]

jojo 第一阶段保持精确编辑默认行为；可先增加 CRLF/LF 规范化和非写入式匹配建议，不启用不可解释的宽松替换。多文件 Patch 先解析、解析真实路径、生成所有 Diff，再统一检查和审批。

### 9.2 建议的数据约束

- 每个目标保存 beforeHash、afterHash、内容引用、Run/ToolCall/actor。
- 审批后到执行前重新核对 hash；任一冲突中止，不能把旧 Diff 批准当成对新文件的授权。
- 同 Workspace 的文件写入使用明确串行/锁策略，跨文件部分失败有可恢复 Journal。
- 撤销前要求当前 hash 等于 afterHash；用户或其他进程改过则显示冲突，不覆盖。
- Undo 的范围明确：Agent 文件变更可恢复，外部 API、邮件、数据库或任意 Terminal 副作用不能统一承诺撤销。
- Worktree 隔离继续保护可写 Sub-Agent；主会话撤销是它的补充，不替代隔离。

入口：`file-mutation.ts`、`file-tools.ts`、Storage 与桌面 Diff；Operation 恢复只恢复有明确执行证据的状态，不重复执行未知副作用。

验收：多文件冲突时不产生偷偷提交的局部修改；部分写入失败可解释与恢复；Undo 不覆盖用户后续编辑；崩溃后 Journal 可对账；二进制、符号链接、越界和大文件继续受既有边界限制。

## 10. 借鉴六：Provider 适配与稳定 Prompt

OpenCode `provider.ts` 和 `transform.ts` 集中处理模型与协议差异，包括消息内容、工具调用、推理、缓存和模型选项。Hermes 也将稳定系统前缀与易变化内容分开，并处理不同路由的缓存差异。[O5][H6]

jojo 已有 Provider Registry 和 Contribution 接口，但当前内置实现仍集中在 Chat Completions 兼容协议。可以接入多个兼容服务，不代表已原生覆盖所有协议。

建议先定义少量显式能力：协议类型、tool calling、视觉输入、输出限制、推理状态、usage/cache 计量和取消语义。新增 adapter 实现现有 ModelProvider；供应商条件留在 adapter，不向 Runtime 分支扩散。

第二协议的选择由实际使用需求决定，可评估 OpenAI Responses 或 Anthropic Messages；本报告不假设二者都必须同时做。先用脱敏的协议 fixture 验证工具 ID、流中断、推理块、图片、上下文溢出和 usage，再开展真实模型测试。

Prompt 建设优先保证工具 Schema 排序、稳定 ContextBlock 和版本化 Memory Snapshot 的确定性。缓存命中提升是待验证目标；不能因为加了 cache_control 就声称一定降费。稳定前缀也不能压住最新用户纠正或保留已经失效的权限描述。

入口：`packages/providers`、`packages/contracts/src/model.ts`、模型元数据 resolver、ContextContributionRegistry。

验收：同一输入跨适配器保持 Tool 配对；stream 取消不吞掉结尾状态；推理信息不误入普通回答；模型切换后预算正确；观测 input/output/cache tokens，重放结果确定。

## 11. 借鉴七：接口生态与程序化工具编排

### 11.1 Server Schema / SDK / ACP

OpenCode 仓库包含 OpenAPI 描述和 SDK 生成类型，SDK 包声明 OpenAPI TypeScript 生成依赖；官网提供 SDK 和服务器接入文档。[O6]

jojo 已有 Zod Protocol、JojoClient、幂等与恢复语义，值得增加 Schema、HTTP 路由、SDK 与文档的一致性检查。当前 `scripts/generate-docs.mjs` 已生成能力和 Operation 文档，应该沿这条路线增加覆盖，而非迁移对方网络框架。

ACP 可以在确有 IDE 接入需求时作为 App Service 上的 adapter；先实现会话、消息、工具更新、取消和审批映射。协议适配必须保留 jojo 的 executionScope、principal、approvalId 和恢复事实，不能变成绕过治理的第二执行入口。

### 11.2 Hermes execute_code：参考机制，延后产品化

Hermes 的 execute_code 让脚本通过 RPC 调用选定工具。Host 管线执行 token 校验、工具 allowlist、调用预算和分发日志，本地/远程采用不同传输。[H7]

对 jojo，大量表格或多 API 数据整理可能因此减少模型逐步看到中间结果的开销。但 README 的“零上下文成本”不能按字面采信：脚本、最终输出仍占上下文，内部工具调用也消耗资源。

jojo 已有 Workflow DAG 和 Tool Step，固定流程优先保存为 Workflow。只有真实任务证明动态数据编排值得做时，再增加受限脚本环境；可先支持只读数据变换和明确 allowlist，每个内部调用继续进入原 Tool Runtime、Governance、Audit 和资源预算。

编排审批不能一次性授权脚本所有未知副作用。父 Run 取消应停止脚本和子调用；RPC 必须绑定 Run/actor/有效期，恢复不得复用过期授权。

## 12. 不建议直接照搬的设计

| 设计 | 原因 | jojo 应采取的路径 |
|---|---|---|
| 替换 Runtime 为对方 Agent Loop | jojo 已有 Durable Operation、Lane、恢复、权限与 Host 边界 | 将具体能力实现为 Tool/Service/adapter |
| 复制另一套 cron / Gateway | Scheduler 和 Channel Outbox 已存在 | 优化模板、绑定、健康状态和投递体验 |
| 自动修改所有已安装技能 | 污染共享技能、覆盖用户定制、难以回滚 | 候选、Diff、指定版本和作用域 |
| 全量 LSP 自动常驻与下载 | 资源、版本和执行信任成本高 | 项目验证命令优先，LSP 按需启用 |
| 多种模糊替换无条件启用 | 错误匹配会伤害 jojo 的精确预览与冲突保障 | 精确匹配优先，非唯一拒绝，候选跨度透明 |
| 一次性支持所有云终端 Backend | 环境、密钥、恢复与隔离矩阵迅速扩大 | 先验证一个 OCI/SSH 等明确需求 |
| 先引入外部用户画像服务 | 现有本地 Memory 已可承载偏好，会增加数据与运维边界 | 先做好本地事实来源、范围和生命周期 |
| 用 Prompt 宣称“自我进化” | 不能证明复用有效，也不能替代验证 | 记录学习来源、使用成功与回归结果 |

MIT 根许可证已在本次源码中核对。后续若直接移植代码，应记录具体文件和版本，保留相应许可与版权声明，并核查关联依赖和第三方资源；本文建议本身不包含大段代码复制。

## 13. 建议落地顺序

这里的 P1/P2/P3 表示演进优先级，不表示已有生产故障的严重度。工作量 S/M/L 是范围估计，不是工期承诺；验证闭环、跨会话检索与撤销的复杂度尤其取决于持久化和权限细节。

| 优先级 | 项目 | 范围 | 收益依据 | 前置条件 |
|---|---|---|---|---|
| P1 | VerificationProfile + 验证事实记录 | M | 给代码完成状态提供证据 | Run / ToolResult 与权限边界 |
| P1 | 大结果分层回收与持久回读 | M | 避免关键证据丢失，保持长任务可继续 | Artifact 访问和 Skill 可见性 |
| P1 | 当前项目历史会话搜索 | M–L | 找回未进入 Memory 的过去决策 | Runtime SQLite 与身份过滤 |
| P1 | 真实任务评测最小集 | S–M | 避免优化只改善 token 不改善完成率 | 隔离数据、固定模型、明确评分 |
| P2 | 显式“保存为技能”与版本草稿 | M | 将已验证重复流程变成可复用资产 | 候选证据、格式检查、治理 |
| P2 | 受控 apply_patch | M–L | 多文件修改表达更自然 | Mutation 预检、并发与失败 Journal |
| P2 | 第二 Provider 协议 | L | 改善实际常用模型的适配 | 能力模型和协议 fixture |
| P2 | API/SDK/文档一致性检查 | M | 稳定外部入口与生态 | 现有 Operation Manifest |
| P3 | 会话文件 Undo/Redo | L | 用户可恢复 Agent 文件修改 | Patch Journal、冲突保护 |
| P3 | 可选 LSP 服务、ACP | M–L | 根据项目/IDE 需求扩展 | 公共服务和安全生命周期 |
| P3 | 程序化工具编排 / 新终端 Backend | L | 真实批处理/远程任务才值得引入 | 测量收益、嵌套权限与取消 |

推荐按结果验收分四个阶段：

1. **阶段 A：让现有执行有证据。** 完成验证记录、大结果回读和评测基线；先在实际 jojo 开发任务上跑通。
2. **阶段 B：让历史可以使用。** 做当前项目会话搜索与点击原文；再允许显式把成功流程转成 Skill。
3. **阶段 C：改善代码与模型接口。** 上受控 Patch，选择一种第二协议，扩大 API/SDK 一致性检查。
4. **阶段 D：扩展能力面。** 以需求和评测决定 Undo、LSP、ACP、程序化编排及远程 Backend。

如果当前重心是飞书长期助手，阶段 B 可以提前；如果重心是桌面 Coding Agent，阶段 A 与受控 Patch 更值得先做。两种排序都复用相同 Runtime，而非分别做两套产品内核。

## 14. 如何证明借鉴有效

Hermes 的工具延迟发现评测目录包含基线/实验 A/B、固定 checkout、隔离环境、脚本交互、成本/耗时与错误分类；其方案还强调失败运行留在准确率分母、基础设施错误另计。这比只观察“工具目录变短了”更有借鉴价值。[H8]

jojo 已有 `packages/memory/src/semantic/eval.ts`，包含 Recall@K、MRR、Precision@K、负例误报和延迟统计，值得扩展到 Session Recall；无需从头建立检索评测。

建议第一版任务集覆盖以下场景，每类采用多个实例并记录完整轨迹：

| 场景 | 主要判据 |
|---|---|
| 修改 TS 代码并修复类型错误 | 变更正确，验证状态和最终回答一致 |
| 用户问上一周设计选择 | 找到正确消息和来源，不编造记忆 |
| 中文同义改写与错误码搜索 | 召回质量、引用定位、无越权 |
| cron 重复日志与用户决策混合 | 主会话仍能进入前列 |
| 工具结果中段藏有失败 | 回收后能回读并识别关键证据 |
| 压缩发生在 Skill 执行中途 | 约束可恢复，不因已加载标志丢失 |
| 同类流程第二次执行 | Skill 确实减少重复探索，最终正确性不下降 |
| 用户编辑文件后再 Undo / Patch | 冲突被拒绝，用户改动保留 |
| Server 重连、Channel 审批和取消 | 结果一致，无重复副作用或遗漏审批 |

统一记录任务成功率、input/output/cache tokens、模型调用数、工具调用数、用户往返次数、耗时及失败类别。每次只变一个关键机制；优先用固定 Provider/模型/设置和相同输入，随机性大的单元增加重复样本。

所有质量门槛先由基线确定，再在实验前写清楚。本文不编造成功率或预计节省百分比；少量脚本单测通过不能证明真实模型工作流更好。

## 15. 源码与文档索引

外部源码链接全部固定到本次 SHA；官网链接属于滚动文档。以下编号对应正文，便于将建议转成实现任务时复查。

### OpenCode

- **[O1] 文件编辑及匹配策略**：[edit.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/tool/edit.ts)
- **[O2] Patch 预处理、审批与诊断**：[apply_patch.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/tool/apply_patch.ts)
- **[O3] 上下文**：[compaction.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/session/compaction.ts)、[overflow.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/session/overflow.ts)
- **[O4] 变更快照与会话撤销**：[snapshot/index.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/snapshot/index.ts)、[session/revert.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/session/revert.ts)
- **[O5] Provider**：[provider.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/provider/provider.ts)、[transform.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/provider/transform.ts)
- **[O6] API/SDK**：[OpenAPI](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/sdk/openapi.json)、[SDK package](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/sdk/js/package.json)、[官网 SDK 文档](https://opencode.ai/docs/sdk/)
- **[O7] LSP 的默认行为与取舍**：[官网 LSP 文档](https://opencode.ai/docs/lsp/)
- Agent 配置：[agent.ts](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/opencode/src/agent/agent.ts)
- 根许可证：[LICENSE](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/LICENSE)

### Hermes Agent

- **[H1] 原文会话检索**：[session_search_tool.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/session_search_tool.py)
- **[H2] 检索与 FTS**：[hermes_state_search.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/hermes_state_search.py)、[hermes_state_fts.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/hermes_state_fts.py)
- **[H3] 技能发现、读取、更新与扫描边界**：[skills_tool.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/skills_tool.py)、[skill_manager_tool.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/skill_manager_tool.py)
- **[H4] 显式学习与知识归宿**：[learn_prompt.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/agent/learn_prompt.py)、[prompt_builder.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/agent/prompt_builder.py)
- **[H5] 有预算的记忆与会话 Prompt**：[memory_tool_store.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/memory_tool_store.py)、[system_prompt.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/agent/system_prompt.py)
- **[H6] Prompt 缓存**：[prompt_caching.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/agent/prompt_caching.py)
- **[H7] 脚本与工具 RPC**：[code_execution_tool.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/code_execution_tool.py)、[code_execution_rpc.py](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/tools/code_execution_rpc.py)
- **[H8] 真实任务 A/B 方案**：[core_tool_deferral/README.md](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/evals/core_tool_deferral/README.md)
- 定位与宣传描述：[README](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/README.md)
- 根许可证：[LICENSE](https://github.com/NousResearch/hermes-agent/blob/7583a6610ef7226a3dfc1d6721582210d742754a/LICENSE)

### jojo 的实现导航

| 改进项 | 当前文件 / 目录 |
|---|---|
| 文件变更与冲突 | `packages/tools-node/src/file-mutation.ts`、`file-snapshots.ts`、`file-tools.ts` |
| 结果与 Artifact | `packages/tools-node/src/artifact-storage.ts`、`tool-result.ts` |
| Context 与 Compaction | `packages/agent/src/context-manager.ts`、`packages/agent-runtime/src/context/` |
| Session 原文持久化 | `packages/storage/src/sqlite-runtime-store.ts` |
| Memory 候选与召回 | `packages/memory/src/candidates/`、`runtime.ts`、`tools/memory-tools.ts` |
| 检索评测 | `packages/memory/src/semantic/eval.ts` |
| Skills 生命周期 | `packages/extensions/src/skills.ts`、`skill-installer.ts` |
| Context 贡献与稳定缓存 | `packages/extensions/src/api/context-registry.ts` |
| Provider | `packages/providers/src/registry.ts`、`chat-completions-request.ts`、`chat-completions-stream.ts` |
| 远程接口 | `packages/server-protocol/src/index.ts`、`packages/server-http/src/server.ts`、`packages/client/` |
| 公共应用服务 | `packages/app-service/src/jojo-app-service.ts` |
| Scheduler / Channel | `packages/scheduler/src/`、`packages/channel-runtime/src/` |
| 编排 | `packages/orchestration/src/subagent/`、`workflow/` |
| 能力文档生成 | `scripts/generate-docs.mjs` |

新功能实现前需重新核对 jojo 的 HEAD 和公共 Contract，以上入口对应研究时基线。

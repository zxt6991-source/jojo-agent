# OpenCode / Hermes 比较报告开发落地

本文件对应 `jojo-opencode-hermes-comparative-analysis.md` 的 A → B → C → D 路线，记录本次实现、使用入口与尚未验证的部分。实现复用现有 Tool Runtime、Durable Lane、Governance、SQLite 和 App Service。

待完成项的具体接口、开发步骤、权限边界和验收计划见 [后续实现方案](./jojo-opencode-hermes-remaining-implementation-plan.md)。该文档为设计，不代表这些能力已经实现。

## 阶段状态

| 阶段 | 本次实现 | 验收边界 |
| --- | --- | --- |
| A | VerificationProfile、持久验证记录、UI 状态、压缩后原始输出回读、错误片段保留、Skill 原文保护、任务评测评分器 | 代码回归已运行；真实模型 A/B 尚未运行 |
| B | 项目会话词法检索、有限原文窗口、点击定位、主路径过滤、显式版本化 Skill 草稿与激活 | SQLite Host 支持检索；不提供向量语义检索和自动学习候选 |
| C | 结构化多文件 Patch、审批内容指纹、OpenAI Responses、共享 REST/WS/SDK Schema 与生成文档校验 | Responses 使用脱敏 fixture 验证；未接真实 Provider；Patch 使用精确编辑 |
| D | Patch 文件 Journal 的 Undo / Redo / Recover | LSP、ACP、动态脚本编排、远程 Backend 保持需求门槛；单文件工具和 Terminal 的副作用不纳入本版 Journal |

## 验证与大结果

项目可设置 `.jojo/verification.json`，本仓库已有 lint/typecheck/test 示例。Agent 先调用 `verification_profile {}`，再将返回的 `terminalInput` 交给 `terminal`。项目配置只提供建议，不执行、不授予权限。`timeoutMs` 约束单条命令，`budgetMs` 是计划提示，尚非跨命令累计执行预算。

终端检查保存命令、参数、cwd、开始结束时间、退出码、passed/failed/skipped/cancelled、覆盖范围、变更标识和原结果引用。权限拒绝不会记为测试失败。最新 Profile 未执行项显示 skipped。最终模型指令和聊天 UI 读取事实记录；持久 Runtime 从原始 Lane 读取，不依赖压缩摘要。

变更标识采取保守策略：成功文件修改及任意后续 Terminal 会令旧结果过期，因为 Terminal 可能修改代码。它不是 Git tree hash，也无法监测所有外部编辑。多个检查串行执行时，早期检查可能显示过期；不要据此声称所有最终文件已经被验证。

大结果在模型上下文内缩减时保留头尾、有限错误片段和 `callId`。使用 `result_read {"callId":"…","offset":20000,"limit":6000}` 回读中间部分；offset 为 UTF-16 字符偏移，最大窗口 12,000 字符。原结果保持在持久消息中，仅当前 Session 当前 Lane 的祖先可读，压缩不会删除原文。`load_skill` 正文受到保留，重复加载仍默认去重；显式 `reload:true` 或指定 SHA-256 `revision` 可控制重载。

## 会话历史

`session_search {"query":"数据库 SQLite","source":"main","limit":10}` 在获准范围检索原始 user/assistant 文本；`session_read_window {"sessionId":"…","anchorSeq":4}` 读取有限邻近原文。返回来源、时间、项目、Entry ID 和序号；Desktop 结果提供原文定位按钮。

SQLite FTS5 trigram 索引支持中文和错误码，短词采用词法 fallback。索引随条目删除同步清除，永久 Session tombstone 保持有效。检索仅返回 durable main 路径上的条目，排除内部消息、附件和工具原始载荷。主会话优先；scheduler/team/spawn 来源由可信消息或 Session 元数据标识。当前不聚合独立子 Lane，也不提供语义相似度。

本地主 Agent 的用户触发可搜索同一 workspace 的 Session；Channel、Team、API 运行限定当前 Session。App Service 对非 local principal 默认拒绝历史访问；`source:all`、通用 read scope 不能扩大访问。Host 可通过 `canReadSessionHistory(ctx, sessionId)` 显式定义每个身份的 Session 范围，过滤后才提交 SQLite 查询。Headless Server 也暴露该 Host 配置。

公共接口：

- GET `/api/v1/sessions/:sessionId/search`
- GET `/api/v1/sessions/:sessionId/read-window`
- WS `session.search` / `session.read-window`
- `JojoClient.searchSessionHistory` / `readSessionHistoryWindow`

接口复用 Application Operation Zod Schema；HTTP、WS 和 SDK 集成测试覆盖同一返回、窗口上限与身份拒绝。

## 显式保存为 Skill

用户要求“把这次成功流程保存为技能”后，Agent 调用 `skill_draft`。输入包含触发条件、输入输出、依赖、步骤、已知失败、验证方法、适用平台、来源 Tool Call、当前通过的验证 Call 和可选前一版本。

草稿保存到 `.jojo/skill-drafts/<name>/<sha256>.json`，不会进入 active Skill discovery。来源证据必须来自当前分支；验证必须通过且未过期。生成器拒绝常见凭据、用户名、个人邮箱和临时绝对路径。该检测不是完整 DLP；审批仍需审阅内容。聊天返回 Markdown 草稿 Artifact，可用文件工具查看或删除。

`skill_activate {"name":"…","revision":"…"}` 校验草稿结构、来源字段和版本哈希，生成 `.agents/skills/<name>/SKILL.md` 并走既有读前快照、具体 Diff 和审批。激活后后续 Turn 发现新版本。回滚时先完整读取现有文件，再激活旧草稿版本。版本与来源写入 frontmatter；发现时冻结本次 Skill 描述，加载时校验明确 revision。

本版没有自动候选生成、用户级安装、独立草稿设置页、脚本生成与 references 拆分、使用反馈自动评分。这些不应被描述为“自我进化”。

## Patch 和文件恢复

`apply_patch` 接收 `changes` 数组，最多 20 个 write/edit/delete；edit 只接受精确唯一 oldText 或明确 replaceAll。既有文件必须先读。示例：

```json
{"changes":[{"operation":"edit","path":"src/a.ts","oldText":"return 1;","newText":"return 2;"},{"operation":"write","path":"src/b.ts","content":"export const b = 2;\n"}]}
```

审批前生成全部 Diff、解析真实路径并检查重复目标。执行时对审批内容指纹和每个文件的旧内容哈希复核；本机同 workspace 的原生文件写入串行执行。最多单文件 2 MB、合计旧新内容 8 MB；二进制、目录、越界和不受允许的路径保持拒绝。

Patch Journal 在 Host 配置的回收目录下按 Session 哈希隔离，保存旧新内容、哈希、权限、每一步 intent 和状态。部分失败/取消只回滚仍匹配预期哈希的文件；发现外部编辑则保留并返回 needs_recovery。它是可恢复文件变更，不是跨文件数据库事务，也不是跨 Host 锁。

`file_undo {"journalId":"…","action":"undo"}` 生成反向 Diff；redo 恢复已撤销 Patch；recover 对账 prepared/applying/needs_recovery 的 Journal。要求同 Session、同 canonical workspace，禁止覆盖后来用户编辑。文件删除后恢复保留原权限。进程重启后可通过持久 ToolResult 中的 journalId 请求恢复，不自动重放未知写入。

本版 Journal 覆盖 apply_patch 及其恢复操作；普通 write_file/edit_file/delete_file 的既有回收机制保留。终端、网络、外部 API、邮件和数据库副作用不承诺撤销。目录创建不随 Undo 删除。Journal 保留原文件内容，属于 Host 私有数据，未增加自动过期清理策略。

## 第二 Provider 协议

Models 设置新增 `openai_responses`，使用原生 `/responses` 和 `store:false`。工具定义按名称排序，保留 function call ID，支持图片、文本、工具返回、usage/cache-read、取消、超时、上下文溢出与异常流。加密 reasoning 状态作为受约束 Provider metadata 持久化并按模型回放，不作为用户答案文本输出。

协议映射依据 [Responses 迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses) 和 [流式事件定义](https://developers.openai.com/api/reference/resources/responses/streaming-events)。fixture 回放不代表所有兼容服务均支持 Responses，也不代表已获得缓存收益。未实现第二协议内的自动重试或额外图片降级。

## 评测与阶段 D 门槛

`evals/agent-tasks/tasks.json` 定义真实任务标准，`scripts/evaluate-agent-tasks.mjs` 汇总带原始 trace/evidence 的评分。固定 Provider、模型、checkout、settingsHash；失败纳入成功率分母，基础设施错误单列；缺少资源指标则拒绝汇总。使用：

```sh
node scripts/evaluate-agent-tasks.mjs scored-runs.json
```

尚无真实模型 A/B 结果，未声称成功率提升、降费或检索质量达标。继续评测需要固定 Provider/模型并在隔离 fixture 中重复运行。现有单元与集成测试只能证明被覆盖的实现行为。

报告将阶段 D 明确设为“以需求和评测决定”。LSP 需要具体语言、版本、资源上限和失败降级；ACP 需要确定 IDE 及协议映射；动态脚本编排需先证明既有 Workflow 无法满足任务；远程 Backend 需确定 SSH/OCI 等目标与隔离边界。本次没有证据消除这些门槛，因而保留待评估，不添加默认开启的服务或占位执行入口。

## 本次验证记录

2026-10-07 最终工作区检查：

- `pnpm test`：208 个测试文件通过、1 个跳过；1,280 个测试通过、2 个跳过。包含 SDK REST/WS 真实本地连接、主路径检索、身份隔离、压缩后回读、Skill 激活和 Patch 恢复回归。
- `pnpm lint`、`pnpm typecheck`：通过。
- `pnpm test:architecture`：7 个测试及依赖边界检查通过。
- `pnpm docs:check`：通过。
- `node --test scripts/evaluate-agent-tasks.test.mjs`：2 个评分器测试通过。

上述为代码验证结果，未运行真实 Provider A/B 或打包发布；不据此推断模型任务成功率和费用改善。Electron 交互 E2E 的后续验证见下。

### Electron 交互 E2E 补充验证

2026-10-07 运行 `pnpm test:e2e:electron`，包括实际 Electron Main/Preload/Renderer/Worker 构建与启动。首轮 26 项通过（42.2 秒）；检查日志发现新增 Terminal structuredResult 尚未被严格 IPC Schema 接纳，导致 tool.finished 事件的协议告警。

已补齐有大小限制的 structuredResult、verification、verificationChecks IPC 字段，Terminal 不再传递未定义的 signal 属性。新增 IPC 合同回归，并在终端密钥交互用例断言无 IPC 协议告警。修复后完整重跑：**26 项通过，41.1 秒**；lint/typecheck 通过，相关 IPC、Terminal 与 Preload 回归通过。

覆盖附件与拖放、文档预览、崩溃/审批恢复、历史迁移、模型元数据、权限、会话绑定、Channel 密钥、取消和 Team 设置。使用离线 E2E Provider，不是实际模型验收；没有覆盖本次每个新功能的独立交互场景。日志仍有关闭/重启附近的 Runtime unavailable 和 Session not found 提示，以及测试主动触发的 HTTP 503/CSP 拒绝，未导致用例失败。生命周期日志清理未在本次扩大修改。


## 2026-10-07：待完成方案第一批核心实现

已按 remaining implementation plan 推进 R01、R02、R08 的核心代码，整个 R01～R12 路线尚未完成。剩余内容和启动条件继续在[实现方案状态表](./jojo-opencode-hermes-remaining-implementation-plan.md#本轮实现状态2026-10-07)跟踪。

### 验证 Profile V2 与批次执行

在项目 `.jojo/verification.json` 保存配置，例如：

```json
{
  "version": 2,
  "inputs": {
    "mode": "paths",
    "include": ["src/**", "test/**", "package.json", "pnpm-lock.yaml"],
    "exclude": [],
    "maxFiles": 25000,
    "maxBytes": 134217728
  },
  "budgetMs": 300000,
  "commands": [
    { "id": "lint", "kind": "lint", "command": "pnpm", "args": ["lint"], "cwd": ".", "scope": "project" },
    { "id": "types", "kind": "typecheck", "command": "pnpm", "args": ["typecheck"], "cwd": ".", "scope": "project" },
    { "id": "tests", "kind": "test", "command": "pnpm", "args": ["test"], "cwd": ".", "scope": "project" }
  ]
}
```

先调用 `verification_profile {}`，再用返回的 `batchId` 调用 `verification_run {"batchId":"…"}`；可传 `checkIds` 选择子集。也可按返回的 terminalInput 逐条执行。配置只是建议，每条实际命令仍单独经过原有权限、沙箱和审批；父调用不替代子命令审批。被 Hook 阻止、被拒、未运行、取消与超时都有独立事实。

从 Profile 创建起计算 budgetMs，审批等待计时；命令超时不能超过剩余预算或父 Run 墙钟上限。预算耗尽后活动进程取消，余项跳过。重新调用 Profile 是显式新批次。ToolResult 持久保存 Profile/hash/revision/deadline，状态从分支证据推导；未知副作用不会在恢复时自动执行。

只读 Host 指纹采集覆盖相对路径、内容 SHA-256、存在/删除状态和可执行位；include/exclude 及扫描限制参与 scopeHash。V1 默认 Git tracked + 未忽略 untracked，非 Git 默认采集为 unknown；V2 可明确指定 paths。自动排除 `.git`、`.jojo`、node_modules、.vite、dist、coverage；实际 exclusions 随记录保存。无法读取、符号链接、越界、过大和不稳定范围不能显示为当前已验证。最后一次复核未覆盖的范围也不能复用旧观察。

连续 lint/typecheck/test 在同一完整范围内容不变时同时 current；代码在检查中变化时保留执行 passed，validity 为 stale。外部编辑在最终模型请求/Skill 证据判断时重新核对，Desktop 展示 current/stale/unknown。空闲期间未安装 watcher，尚不承诺即时刷新。历史 V1 记录继续保守失效。

子命令使用独立 callId、原始结果与 result_read 引用，计入父工具调用数并走 Pre/PostToolUse。持久 child trace 在模型上下文投影时移除，父批次摘要包含子结果引用，保证 Provider 工具调用和结果配对。原始账本和 UI 仍保留证据。

### Electron 交互与生命周期

新增五个场景：三项验证独立审批及重启保留/外部编辑失效；原始长日志中段回读（先确认模型上下文发生回收）；历史命中与原文定位；多文件 Patch/Undo/Redo 逐次审批；验证过的 Skill 草稿保存/预览及拒绝激活不产生 active 文件。完整 Electron 回归为 **31 项通过（最终重跑 50.8 秒）**，新增场景断言无 IPC protocol violation 和 Renderer pageerror。它们采用隔离数据目录与确定性模型决策，真实工具、治理、Runtime、IPC 都执行。

Main 正常关闭停止新 Worker 命令和 Session metadata 请求，排空待请求，关闭引起的 Worker exit 不制造 turn.failed；非预期 exit 仍报告并重启。Renderer transcript 用 generation 避免旧响应覆盖新页面，后台刷新消费拒绝；关闭/删除后的 workspace 查询返回空变更。复杂中断、取消、Skill 编辑/回滚和 Responses SSE Electron 矩阵仍待补齐；没有以通过的 happy path 替代这些验收。

### Operation 绑定覆盖

`packages/contracts/src/application/bindings.json` 声明现有 22 个 Operation 的 Core/HTTP/WS/SDK/IPC 关系。`pnpm test:bindings` 检查遗漏 Operation、HTTP 目标方法、WS dispatch、SDK 方法及已声明 IPC 的共享合同解析，失败即阻止 CI；变异回归确认删除/错接会失败。`pnpm docs:generate` 同步生成 [绑定报告](./current-bindings.generated.md)。

当前部分 Desktop DTO 和内部 Scheduler 操作尚没有中立一对一绑定，报告逐项标缺口及原因；静态检查不证明权限、幂等或恢复行为。V2 batch/revision 已补严格 IPC 合同回归，不能把全目录静态覆盖当作 R08 全量行为验收。

最终完整 Vitest 回归：**1293 通过、2 跳过，62.05 秒**；lint、typecheck、架构检查、绑定检查、docs:check、git diff --check 通过。新增合同/运行时检查覆盖 unknown/范围缺测、外部编辑与可执行位、累计审批/进程预算、父工具数、子 Hook、严格 IPC 保留 V2 字段及模型调用配对。

全量回归后进一步加固了采集文件的路径/inode 复核、Profile 取消传播、批次 UUID 与子调用全父 ID 哈希；父结果和模型指令使用有界证据摘要，避免大范围配置重复导致 IPC 超限。上述变化已通过定向 Runtime/工具回归及静态检查；完整原始证据保留在分支账本。

最终 Electron 重构建后的回归曾暴露 Patch 审批测试过早读取文件；已改为等待对应持久工具结果，再检查文件和下一次审批。修正后完整重跑：**31/31 通过，50.8 秒**。新增最大范围/20 检查摘要的 IPC 限额回归通过，最终 lint/typecheck/绑定/架构/docs 检查通过。


## 第二批开发：离线评测与单文件 Journal（2026-10-07）

- R03 新增 `pnpm eval:offline`：隔离目录 + 公开 Runtime + 真实审批/工具，当前独立评分覆盖 Patch 冲突，默认重复两次。结果保存在 test-results/agent-evals；不调用真实 Provider。`pnpm test:evals` 验证 V1/V2 汇总、缺测覆盖、unresolved 拒绝虚报成功、脏源树身份和计划边界。
- R06 抽出 FileMutationJournalService，普通 write/edit/delete 与 Patch 共享恢复机制，保持旧回收站和 V1 Journal 兼容。文件提交/删除补 fsync，Journal 保存可信 Run/actor/toolCallId；Skill 工具返回结果保留 Journal 引用。三种普通工具均可经 file_undo 审批 Undo/Redo；后续用户编辑会拒绝恢复。
- 新增普通文件创建/权限恢复/重启/后续冲突测试，以及三种单文件工具的 Electron 审批及 Undo/Redo 用例。
- 仍待：其余离线任务、真实 Provider/A/B；JournalV2 内容 blob、Run 合成撤销、恢复管理 UI、保留策略和双 Host 锁。完整范围及启动条件见 remaining-implementation-plan.md 第 14 节。


第二批验证结果：完整 Vitest 1298 passed / 2 skipped（65.13s）；完整 Electron E2E 34/34 passed（56.4s）；evals Node 测试 7/7，离线 Patch 冲突 fixture 2/2。lint、typecheck、architecture、application bindings、docs:check 和 diff whitespace 检查通过。首次沙箱全量测试因本地端口 listen EPERM 失败，在获准环境重跑后通过；没有用跳过这些测试来获得通过结果。


## 第三次推进：七类离线任务的独立评分（2026-10-07）

R03 默认离线计划扩展为七类，每类重复两次。新增中段失败回读、真实进程验证取消、SQLite 历史决策及自动日报排序、真实 TypeScript 编译修复、Skill 压缩后 revision/约束保持。公共 Runtime 管线和真实工具执行，scripted Provider 只给出固定决策；由原始账本、文件、编译退出码和当前输入哈希评分。

新增 12 个 fixture 回归测试（7 个正常路径 + 5 个失败条件），任务目录标准缺项强制 unresolved。运行期间源码状态 pending，完成一致性检查才 verified；源码变化归类为基础设施错误，汇总拒绝 pending。每次要求全新的输出目录，保留独立 trace/manifest/评分文件。

运行：`pnpm eval:offline`；fixture 回归：`pnpm test evals/agent-tasks/offline-fixtures.test.ts`；报告格式回归：`pnpm test:evals`。reconnect 真实传输 fixture、真实 Provider 矩阵和正式 A/B 仍待完成。


macOS 强沙箱回归发现 Node 加载工作区脚本会被祖先目录 metadata 拒绝。已增加仅限 exact literal 父目录的 metadata 读取；真实 Seatbelt 测试同时确认脚本可加载、父目录列表及未挂载 sibling 内容仍被拒绝。TypeScript 编译器先复制到隔离工作区，并纳入输入哈希；不依赖对宿主 repo 的隐式读取。


本次最终回归：`JOJO_STRONG_SANDBOX_TEST=1 pnpm test` 为 1313 passed / 1 skipped（71.62s），包含两个真实 macOS Seatbelt 测试；完整 Electron E2E 34/34 passed（59.6s）；fixture 回归 12/12；报告格式/计划 Node 回归 9/9；typecheck、lint、architecture、docs:check 通过。七类默认离线计划为 14 次运行，单独验证通过；最终 trace 与来源清单使用新的输出目录保存。

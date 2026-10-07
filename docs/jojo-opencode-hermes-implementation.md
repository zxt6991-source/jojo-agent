# OpenCode / Hermes 比较报告开发落地

本文件对应 `jojo-opencode-hermes-comparative-analysis.md` 的 A → B → C → D 路线，记录本次实现、使用入口与尚未验证的部分。实现复用现有 Tool Runtime、Durable Lane、Governance、SQLite 和 App Service。

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

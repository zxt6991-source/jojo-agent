# OPT-03：恢复执行上下文的持久化与一致性

状态：详细实施设计，尚未实现。基线：`e544bae`。本文只规划 execution snapshot 与 `resumeOperation` 的上下文恢复；本次不修改生产代码。

## 1. 目标、边界与交付结果

同一 operation 在进程重启前后，应保持任务身份、原触发来源、指令、模型选择、预算和 Memory 绑定；执行时使用当前有效的 Host 凭据、权限和能力实例。
恢复相同任务语义，不代表恢复旧授权，也不保证模型重新请求会生成逐字相同的答案。
本期首先覆盖 Desktop 已有显式 `resumeOperation` 路径，同时保持 Runtime 不依赖 Electron。
Server 启动默认 interrupt，不自动 resume；已终态 operation 不允许复活，用户再次尝试应创建新 Run。
终态结果投影、受控终止、Lane 条件释放和 Server 启动对账由 [OPT-02](./opt-02-runtime-recovery.md) 定义，本文不新增另一套恢复状态机或存储事务 API。
验收结果：捕获新 operation 的完整语义快照；恢复前完成校验；任一不可重建条件明确报错，禁止悄悄套用当前默认设置继续执行。

## 2. 当前实现及缺口

| 位置 | 基线行为 | 对恢复的影响 |
| --- | --- | --- |
| `packages/agent-runtime/src/public/runtime.ts:299` | resume 只恢复 providerId、model、maxIterations，并写入新的 resume trigger | instructions、actor、workflow、team、部分 budget 丢失 |
| `packages/agent-runtime/src/public/runtime.ts:426` | 重新读取 session scope，调用 providers/tools/hooks/runContext resolver | 相同 operation 的目录和身份可能随 Host 当前状态变化 |
| `packages/agent-runtime/src/harness/runner.ts:541` | 统一正常执行与 resume；从 meta.config 恢复 loop budget/safety | 已有预算恢复能力，应扩展而非重写 |
| `packages/agent-runtime/src/harness/runner.ts:660` | startOperation 持久化身份、模型、maxIterations 与 config | 缺少指令和运行语义快照 |
| `packages/agent-runtime/src/harness/runner.ts:980` | 每次请求组合 ambient context 与 options.instructions | 丢失的基础指令直接影响下一次模型请求 |
| `packages/agent-runtime/src/operation/meta.ts:5` | OperationMeta 没有 execution 字段 | 无法证明当前恢复请求与原运行等价 |
| `packages/runtime-composition/src/environment-registry.ts:40` | provider 直接取 lane 的内存绑定 | 不能仅凭 Runtime context 就认定绑定到了原 provider |
| `apps/desktop/src/worker/worker.ts:1017` | 基础提示和 MCP instructions 混入一个字符串数组 | 来源消失，难以识别扩展变化与重复注入 |
| `apps/desktop/src/worker/worker.ts:1113` | 检查旧 provider/model 后恢复，再提交新输入 | Host 重建当前环境后才恢复，但旧 instructions 未传回 |

现有 Memory snapshot、hook context、usage 和 operation progress 已持久化，不把它们再复制进 execution snapshot。
现有公共恢复测试 `packages/agent-runtime/test/public-runtime.test.ts:208` 主要验证恢复完成和事件顺序；需新增完整上下文等价性测试。

## 3. 核心设计：不可变快照，现用依赖重新解析

快照记录“原运行以什么身份、目标和配置执行”；Host 提供“现在是否仍能以这些条件执行”。两者校验通过才进入 runner。
`OperationMeta.execution` 与初始 OperationState 在现有 `startOperation` 中一起写入，之后不可修改；resume 不再创建 operation，不修改原 trigger。
历史消息、附件、Memory 内容、hook 注入从现有 SessionEntry 路径恢复；不在快照内保存第二份 transcript 或模型请求全文。
进行中的 iteration、usage、startedAt、toolCalls 仍由 OperationState.progress 提供，不能因为 resume 归零。
快照中的 actor/profile/workflow/team 都是任务语义，不能直接转换成系统角色或权限授权。

## 4. 拟议 TypeScript 类型

以下类型和字段均为拟议 API；基线中不存在。复用现有 `RunBudget`、`RuntimeActor`、`RuntimeTriggerContext`、`RuntimeWorkflowContext`、`RuntimeTeamContext`、`ContextBlock` 和 Memory binding 类型。
建议在 `packages/agent-runtime/src/public/execution.ts` 定义可公开的语义类型，在 `operation/execution-snapshot.ts` 定义校验与规范化；避免再创建 provider、context 或 permission registry。

```ts
// 拟议：只含不携带凭据的 provider 绑定信息。
export type RuntimeProviderBinding = {
  providerId: string;
  model: string;
  configurationFingerprint: string; // sha256:<64 hex>
};

// 拟议：沿用 ContextBlock 身份和优先级；不复制缓存实现。
export type ExecutionInstructionBlock = Pick<
  ContextBlock, 'id' | 'source' | 'content' | 'priority'
> & {
  kind: 'instruction';
  sourceFingerprint: string; // producer/config 版本，不是进程内计数器
  contentHash: string;       // 对未截断 UTF-8 内容计算
};

export type OperationExecutionSnapshotV1 = {
  schemaVersion: 1;
  capturedAt: number;
  origin: 'public-runtime' | 'trusted-harness';
  executionScope: ExecutionScope;
  actor: RuntimeActor;
  trigger?: RuntimeTriggerContext;
  workflow?: RuntimeWorkflowContext;
  team?: RuntimeTeamContext;
  providerBinding: RuntimeProviderBinding;
  budget: Required<RunBudget>; // 有效值，已计算默认值
  instructions: {
    // request 的顺序保持不变；不按文本去重用户明确传入的指令。
    requested: string[];
    // 已规范化、按现有 registry 顺序排列的非秘密上下文贡献。
    contributed: ExecutionInstructionBlock[];
    compositionVersion: 1;
    fingerprint: string;
  };
  runContext: {
    executionPolicyFingerprint: string;
    projectIdentity?: ProjectIdentity;
    memoryBinding?:
      | SubAgentMemoryBinding
      | WorkflowMemoryBinding
      | TeamMemberMemoryBinding;
  };
};

// 拟议：在现有 OperationMeta 上增加可选字段，用于读取历史数据。
// v1 新建的公共 Run 必须有 execution；“可选”不代表可以无快照恢复。
type OperationMetaDelta = {
  execution?: OperationExecutionSnapshotV1;
};

// 拟议：inspectRun 可返回的脱敏语义摘要，不含指令正文。
export type RuntimeExecutionSummary = Pick<
  OperationExecutionSnapshotV1,
  'schemaVersion' | 'executionScope' | 'actor' | 'trigger' |
  'workflow' | 'team' | 'providerBinding' | 'budget' | 'runContext'
> & { instructionFingerprint: string };

// 拟议：供已有 Host resolver 接线，不引入新的环境管理器。
// ModelProviderResolver.describe?: (context) => binding | Promise<binding>
// RuntimeRunContext.instructionBlocks?: ExecutionInstructionBlock[]
// RuntimeRunContext.executionPolicyFingerprint?: string
// RuntimeRunSnapshot.execution?: RuntimeExecutionSummary
// RuntimeResolutionContext.recovery?: { operationId: string }
```

`Required<RunBudget>.maxIterations` 必须等于 meta.maxIterations；重复值仅服务公共摘要，校验器强制一致，不允许两个来源各自修改。
`config` 已承载 dynamicIterationBudget、iterationExtensionStep、loopSafety、资源预算；v1 继续使用它，不再复制到 execution。
新增稳定字段一律走 schemaVersion 升级；读取端先按 unknown 检查版本，再进入对应严格 schema，禁止直接 `as OperationExecutionSnapshotV1`。
executionPolicyFingerprint 来自原 profile、workflow step、team member 的任务工具边界与配置；主 Agent 使用产品策略版本。它不包含会话批准缓存或凭据，当前权限撤销仍由 gate 决定。

## 5. 持久化位置与存储一致性

SQLite 使用现有 `operations.meta_json`，JSONL 使用现有 `operation.started.meta`，MemoryStore 继续 clone meta；无需新增 execution 表或独立 JSON 文件。
`packages/storage/src/sqlite-runtime-store.ts:264` 已在事务内写入 operation 和占用 Lane；快照加入同一 meta 序列化即可。
`packages/storage/src/runtime-store.ts:314` 已通过按 session 排队追加 operation.started；不能先单独写快照再起 operation。
`packages/agent-runtime/src/memory-store.ts:125`、JSONL 和 SQLite 三种实现必须运行相同的新快照一致性用例。
在 `startOperation` 写入边界和 `loadOperation` 读取边界调用共享快照校验；兼容读取没有 execution 的旧记录，不赋予其恢复资格。
`saveOperationState` 保留 meta 原样，不加入“更新 execution”方法；状态机和 Lane 释放仍沿用 OPT-02 的接口。
校验 schemaVersion、字节限额和哈希后再调用 provider/tools/hooks；快照读取失败不触发外部请求。
业务事件、Telemetry 和 HTTP run 查询默认只输出摘要与错误码，不记录快照正文；日志不得打印无法解析的原始 meta_json。

## 6. 正常 start 的字段映射与顺序

| 输入来源 | 保存到哪里 | 正常执行/恢复时的用途 |
| --- | --- | --- |
| session metadata 的 scope | execution.executionScope | resolver scope；workspace 时派生 workingDirectory，否则空串 |
| request.actor 或既有 main 默认 | execution.actor | provider/tools/hooks/permission/telemetry 的任务身份 |
| request.trigger | execution.trigger | 保留原始 scheduler/channel/workflow 等触发语义 |
| request.workflow / team | execution.workflow / team | Hook 与编排归属；不使用 Host 当前选中成员替代 |
| request.providerId / model 与 describe 结果 | execution.providerBinding；meta 原字段保留 | 解析同一逻辑 provider、模型与非秘密配置 |
| request.budget 与 runner 既有默认值 | execution.budget；maxIterations 与 meta 对齐 | 保留 contextWindowTokens、maxOutputTokens、allowPartialOnLimit |
| request.instructions | execution.instructions.requested | 保持原顺序、内容和重复项 |
| runContext.instructionBlocks | execution.instructions.contributed | 稳定来源、内容哈希、扩展指纹 |
| runContext.projectIdentity / memoryBinding | execution.runContext | 恢复项目和既有 Memory snapshot 引用 |
| runContext.executionPolicyFingerprint | execution.runContext | 识别同名 profile/member 的定义变化，防止悄悄扩大任务工具范围 |
| loop budget/safety | 原 meta.config | 保留当前已有预算与护栏恢复逻辑 |
| 新 signal、provider/tool/hook 实例 | 不持久化 | 当前进程资源；正常结束仍 dispose |

1. 验证请求与 Session/Lane，计算有效 scope、actor、预算和 operation ID；参数非法时不写 operation。
2. provider.describe 使用当前 Host 配置计算绑定指纹；检查返回 ID/model 与请求一致，再执行现有 resolver。
3. Host 用现有 ContextContributionRegistry 构建贡献，Runtime 校验并复制 instructions 和 runContext，冻结本次语义。
4. runner 使用共享默认值规范化函数补齐有效预算；必须在创建 tool snapshot 和 `startOperation` 前完成，避免一处 8192、另一处自定 output 限额。
5. `startOperation` 一次写入 execution、原 config 和初始 state；之后按原路径追加输入、执行 hooks、构建模型请求。
6. 全流程不把 snapshot 当作调用者可注入的 RunRequest 字段；只允许可信 Runtime/内部 harness 构造。

共享规范化函数复用 `createIterationBudgetPolicy`、已有上下文默认常量；不在 public/runtime 与 runner 各实现一次默认预算。
runner 目前一进入 executeAgentTurn 就 createRunnerData，并可能读取 getTools；需后移至快照和预算准备完成后，直接 harness 恢复路径也不能绕过预检。
受信任的直接 harness 调用需提供可描述的 provider 绑定和语义输入；未升级旧调用可运行但标记为 legacy，不生成看似完整的 v1。

## 7. resume 的字段恢复与顺序

保持现有 `resumeOperation({ operationId, signal? })` 签名；不允许通过 resume 请求覆盖模型、预算、actor 或 instructions。
先调用 OPT-02 的终态判定：终态只查询，不 resume；尚未终止的 operation 才进入以下过程。

1. 加载 operation/session/lane，校验版本、身份、哈希、字段大小和 meta/config/state 的交叉一致性。
2. 从快照恢复 actor、原 trigger、workflow、team、scope、providerBinding 和有效 budget；不从当前 UI 或新输入提取。
3. 验证 session 当前 scope 与快照一致、工作目录仍存在、项目 canonicalPath 与 projectIdentity 对得上；变化返回 typed error。
4. 构造 RuntimeResolutionContext；`trigger` 仍是原触发器，另设 recovery.operationId 表达恢复方式；继续发布既有 run.resumed 事件。
5. provider.describe 对比原绑定；Host 重新解析 provider、tool source、hooks、permission、approval、attachmentAccess 和 runContext。
6. 当前 runContext.projectIdentity/memoryBinding/executionPolicyFingerprint 必须与快照一致；缺失不退回空 binding，不能从别的 Lane 随意取最新 Memory；策略变化返回 runtime_resume_policy_changed。
7. 当前 contributed blocks 与快照校验等价；校验通过后只使用快照内容，不能把当前贡献再追加一次。
8. 进入 resumeAgentTurn，用恢复出的 instructions、预算、hookMeta 和 scope；原 history 仍由持久路径投影，不追加空用户消息。
9. 使用原 OperationState.progress 的累计消耗、iterationLimit 和 startedAt；不重置壁钟预算，停机时间计入原 maxWallTimeMs。
10. 清理新建的临时 binding/toolSource，保留原 operation ID；成功恢复后 Desktop 才按既有产品流程处理排队的新输入。

`model_pending` 必须校验 request.providerId/model/maxOutputTokens 与快照一致，并把同一个 output 限额传给 runModelStep；不能仅恢复 state.request 而实际请求仍用默认 8192。
允许正常执行时按已有机制懒加载工具；恢复时尚未完成的工具必须由当前工具源提供并重新验证当前授权，副作用不确定性处理沿用 OPT-02。
预检失败发生在任何模型请求、工具调用和 run.resumed 发布之前；返回错误，不伪造 run.failed 终态。Host 决定修复依赖后再试或调用 OPT-02 受控终止。
需要结束不可恢复旧运行时，使用 OPT-02 拟议 `interruptOperation({ operationId, reason: 'resume_unavailable' })`；仅适用于没有 live handle、持有 Lane 互斥和 Host 单写所有权的旧 operation，不能替代正在执行任务的 cancel。

## 8. Provider 解析与 Host 接线

`ModelProviderResolver.describe` 是拟议的增量能力；生产 Host 对新 v1 operation 必须实现，测试 provider 可提供稳定的 fixture 指纹。
指纹输入仅包含 adapter/protocol 类型、provider 配置 ID、规范化 endpoint、模型配置和影响请求语义的非秘密参数；使用字段白名单和稳定 JSON 排序。
不把 API key、Bearer token、任意 headers、URL userinfo 或带凭据 query 纳入快照或指纹。生产配置若依赖 URL 凭据，先迁至 secret broker，不以“散列后可写入”替代治理。
同一个 providerId 指向不同 endpoint/adapter 时返回 runtime_resume_provider_changed；原 provider 被移除或模型不可用时返回 runtime_resume_provider_unavailable，不能选择默认 provider。
凭据轮换且语义配置未变时正常恢复；当前凭据缺失返回 runtime_resume_credential_required，由 Host 处理登录/密钥输入。
RuntimeEnvironmentRegistry.bind 仍是唯一 lane 环境路由；为 binding 增加描述信息并在 providers.resolve/describe 校验请求，不让 describe 宣称 A 而 resolve 实际返回 B。
Desktop 先从新增的 inspectRun.execution 摘要拿到旧 provider/model/actor，再建立本次临时环境；不能先按 UI 当前模型绑定后企图由 resume 修正。
新摘要只提供经过校验的语义字段，不提供指令正文或凭据；Server 如需暴露给网络客户端，仍需现有资源归属检查，本期无需新增 HTTP endpoint。
现有 createJojoRuntime 只传递扩展后的 resolver/runContext；不新增 Desktop 专用 Runtime、不序列化 RuntimeEnvironmentRegistry 的 Map。

## 9. 指令来源、防重复与扩展变化

request.instructions 是调用者提供的完整、原序静态提示；原值深拷贝，不能共享可变数组，也不能把环境快照 append 回 request。
将 Desktop 的 `...mcpManager.getInstructions()` 从 request.instructions 移入 runContext.instructionBlocks；基础产品提示仍放 request.instructions。
优先复用现有 ContextContributionRegistry.build 的去重和排序逻辑；不新增第二个 ContextRegistry，也不用 prompt 文本匹配猜来源。
贡献块使用 `(kind, source, id)` 稳定身份；同来源同 key 同 hash 只保留一次，同 key 不同正文视为冲突；跨来源冲突沿用现有 registry 优先级规则。
MCP 当前 adapter 使用 `server-${index + 1}`，需改为配置 server ID 派生的稳定 ID；可对 McpManager 增加携带 ID 的 getInstructionContributions，保留旧 getInstructions 兼容调用。
sourceFingerprint 使用扩展 ID/version、非秘密配置和策略版本；ContextContributionRegistry.version 是进程内计数器，不能作为跨进程指纹。
内容 hash 覆盖原始 UTF-8；最终 fingerprint 覆盖 compositionVersion、requested 的有序列表以及 contributed 的身份、顺序、正文 hash、sourceFingerprint。
正常 run 中工具发现仍可动态变化，但本 operation 的基础 instruction contribution 固定；新的扩展提示从下一 Run 开始生效。
恢复时先重新建立当前可信扩展，再比较源集合与指纹；集合或指纹变化返回 runtime_resume_instructions_changed，不把旧版与新版同时拼接。
扩展被移除、禁用或失去 trust 时拒绝恢复，即使旧正文仍在数据库也不能借此继续加载被撤销的扩展能力。
用户确需使用新扩展版本：通过 OPT-02 结束旧 operation，再以新的 Run 生成新快照；P0 不支持修改旧快照后原地继续。
持久化的 HookContext/MemorySnapshot 不再转成 contributed blocks；维持 runner 的 ambient context 投影，并保留已有 hook entry ID 防重复机制。
当前 `schedulerNow` 插入指令的文案应改为“本 operation 发起时间”，防止恢复后仍称旧时间为当前时间；调度实际时钟由工具即时读取。
本期不自动重写已保存的时间提示、不在恢复时引入新的动态时间 block；需要重新理解相对时间的业务请求应作为新 Run 提交。

## 10. 持久语义与当前授权的区别

| 内容 | 持久化策略 | 恢复处理 |
| --- | --- | --- |
| actor/profile、workflow/team IDs | 保存在 execution | 作为身份线索，重新验证当前项目归属与成员配置 |
| scope、projectIdentity、Memory binding | 保存引用与非秘密语义 | 精确匹配，Memory 正文继续读取 SessionEntry |
| provider/model、instruction fingerprints | 保存白名单与正文 hash | 与当前可用依赖核对，不静默换供应商 |
| API key/OAuth token/cookie/terminal secret | 严禁进入 execution | 从现有 safeStorage/secret broker 重新获取 |
| PermissionGate/ApprovalBroker、会话批准缓存 | 不保存到 execution | 用当前策略重新检查，不把 actor=main 当授权 |
| tool/hook/provider/summarizer 实例、AbortSignal | 不可序列化 | 由当前 Host 新建，并在执行完成后清理 |
| tools state 中历史批准标记 | 保留原状态供审计 | 不作为恢复后副作用的独立授权凭证；当前 gate 必须参与 |

这是恢复快照的安全边界，不承诺自动清洗全库旧消息中的用户自发秘密；本项至少保证不会新增凭据快照或从 Host 配置整体序列化泄漏凭据。
指令采集端只接收明确声明可持久化的产品/扩展提示。Host 已知秘密值匹配、常见 credential 字段检查发现污染时拒绝保存并仅报告字段路径，禁止默默替换正文导致语义改变。
对于任意文本无法仅靠正则证明“不含秘密”；因此禁止把 env、headers、完整 provider config 或插件运行对象作为指令来源，测试需注入金丝雀凭据验证不会出现在文件和日志。

## 11. 字段校验和大小限制

所有限额按 UTF-8 字节计，作为 v1 协议常量；读取旧记录前先限制 meta_json 长度，再解析、校验，防止先分配巨大字符串树。

| 字段 | 拟议限制 | 超出或不匹配时 |
| --- | --- | --- |
| execution 总序列化大小 | 512 KiB；meta 总大小 768 KiB | runtime_execution_snapshot_too_large |
| requested instructions | 最多 128 条，单条 32 KiB，总 192 KiB | 拒绝写入，不静默截断 |
| contributed blocks | 最多 128 块，单块 32 KiB，总 192 KiB | 同上；重复 key 冲突拒绝 |
| ID/profile/source | ID/source 最多 512 字节；profile 沿用现有 64 字符约束 | 严格 schema 错误 |
| workflow/team/memory binding | 各自不超过 16 KiB；沿用现有字段 schema | 禁止额外任意 metadata |
| workspace/canonicalPath | 最多 16 KiB，无 NUL；恢复时 realpath 核对 | runtime_resume_scope_changed |
| custom scope.data | 16 KiB、深度 ≤ 16、节点 ≤ 4096，Host 白名单字段 | 超限或含秘密字段拒绝 |
| token/iteration budget | 正安全整数，模型/context/output 相互约束 | 拒绝 NaN/Infinity/负值/越界，不提升原上限 |
| hash 与版本 | sha256: + 64 小写 hex；schemaVersion=1 | 未知版本拒绝恢复，hash 不匹配视为损坏 |

config 的资源预算沿用已有字段，补 finite/非负及明确禁用语义校验；不要把 undefined 序列化为 null 后再误当 0。
平台当前安全策略可以收紧权限，但模型硬上限小于原 context/output 预算时不可静默改写快照；返回配置不兼容，让 Host 决定新 Run。
普通 SHA-256 提供内容一致性检测，不提供数据库防篡改证明；文件被篡改后不能仅凭重新计算出的 hash 授权执行。

## 12. 老 operation 与版本兼容

默认方案：新 Run 强制写 v1；旧终态正常查询；旧非终态缺 execution 时拒绝自动/直接恢复，返回 runtime_resume_context_missing。
不使用当前 config、当前扩展提示或空 instructions 生成“伪原始快照”，也不从 transcript 反推 profile 和原触发器。
UI 给出明确原因和下一步：“该运行缺少可恢复的执行配置；结束旧运行后重新发起。”结束动作复用 OPT-02，新 Run 有新 ID。
本期不实现批量迁移或 best-effort resume 开关；若未来能从可信旧业务运行记录完整重建，单独设计带来源审计的迁移工具。
schemaVersion > 1 的记录保留在原存储可供新版读取，当前版本不覆盖、不降级；不存在版本号的记录不能默认当作 v1。
旧测试可继续使用 legacy meta 验证查询/损坏处理；声称支持 public resume 的 fixture 必须显式构造 v1 快照。
发布回滚需验证旧二进制能否拒绝新快照，不能依赖 JSON 忽略未知字段：恢复开关或数据格式能力检查必须随第一个生产发布一起部署。

## 13. 接口影响和错误语义

| 接口/文件 | 改动 | 兼容性 |
| --- | --- | --- |
| public/run.ts | RunRequest 和 RunBudget 字段保持 | 不向普通调用者开放 execution 注入 |
| public/runtime.ts | inspectRun 增加 execution 摘要；context 增加 recovery；provider 增加 describe | 旧查询调用者无行为变化；生产 resolver 需升级 |
| RuntimeRunContext/EnvironmentRegistry | instructionBlocks、provider binding 描述与一致性验证 | 继续使用现有 binding/dispose 生命周期 |
| operation/meta.ts、harness/runner.ts | optional execution；新建归一化，恢复按快照映射 | 老数据可读，缺快照不执行恢复 |
| 三个 RuntimeStore | 共享边界校验、meta 序列化保留字段 | 不增加表和新的状态提交方法 |
| Desktop worker 与 MCP adapter | 先检查旧 operation，再绑定其 provider；拆出带来源贡献 | 正常新输入行为保持；恢复错误可解释 |

拟议错误码还包括 runtime_execution_snapshot_invalid、runtime_execution_snapshot_version_unsupported、runtime_resume_memory_binding_changed、runtime_resume_environment_unavailable。
接口抛错消息不得包含 instructions、provider secret 或原始 scope.data；错误 detail 只含 operationId、字段路径、版本和可公开的 fingerprint。
运行预检错误与已进入执行后的失败必须区分；如何最终持久化 terminal outcome、何时释放 Lane，统一遵守 OPT-02。

## 14. 测试矩阵

| 层级 | 场景 | 必须断言 |
| --- | --- | --- |
| schema/unit | 全字段 round-trip、未知版本、超限、深层 custom scope、非法预算、hash 变化 | 拒绝边界准确；错误不泄露正文 |
| store conformance | Memory/JSONL/SQLite start-load、state 更新、关闭重开 | execution 不变；原 meta/config 不丢失 |
| public Runtime | main/subagent/workflow/team_member/channel_user + scheduler trigger | 所有 resolver、hooks、telemetry 收到原身份；trigger 不被 resume 覆盖 |
| public Runtime | 自定 48k context、1024 output、allowPartialOnLimit=true 后恢复 | 模型请求、tool snapshot、超限行为与原运行相同 |
| runner | ready/model_pending/tools/checkpoint/final_response 恢复 | 每个阶段不丢 instructions；pending 请求与实际 output 限额一致 |
| runner budget | 已耗 usage/toolCalls/iteration/壁钟时间后重启 | 累计继续，耗尽即按现有 guard 收敛，预算不重置 |
| composition | provider ID 相同但 endpoint/adapter 改变、key 轮换、key 缺失 | 前者拒绝；轮换可继续；缺 key 不触发模型请求 |
| extensions | 同一 MCP 两次恢复、源顺序变化、正文变化、扩展撤销 trust | 无重复；稳定 ID 不受枚举顺序影响；变化明确阻断 |
| Memory | 三种 binding、缺 snapshot、项目切换、目录被符号链接替换 | 精确校验，不读取另一项目/成员 Memory |
| permissions | 原批准后策略撤销、成员禁用、原 actor 仍存在 | 旧元数据不提升权限；新的副作用由当前 gate 决定 |
| Desktop E2E | 实际建立快照，模拟进程中断，重启并恢复 | 原 actor/instructions/budget/provider 均可观测且一致 |
| compatibility | 无快照旧运行、未知版本、已终态 operation | 不执行模型/工具；可查询；新 Run 重试另建 ID |
| privacy | provider/header/env/MCP 注入金丝雀秘密 | execution、SQLite/JSONL 新字段、诊断日志均不含秘密 |

故障夹具必须模拟中断后保留非终态，而非用 runtime.close() 创建已终止操作再尝试恢复；终态规则以 OPT-02 为准。
“等价”比较模型请求 instructions、model、maxOutputTokens、resolver context 和累计预算；不比较随机生成文本、时间戳或临时实例地址。

## 15. 分步 PR 与依赖

1. **PR-03A：快照 schema 与存储兼容。** 增加类型/严格校验、三种 Store 契约测试；旧数据读取保持，暂不开启旧运行的新恢复行为。
2. **PR-03B：正常 start 捕获。** 抽共享默认值归一化、写入新 meta.execution、增加 describe 与摘要；所有生产 Host 接线后强制新 Run 有 v1。
3. **PR-03C：扩展来源与指纹。** 复用 ContextContributionRegistry，MCP 改稳定 ID，Desktop 分离基础/贡献指令；验证重复与变化策略。
4. **PR-03D：resume 映射与 Host 准备。** 完整恢复上下文、严格预检、当前 provider/授权重建、旧数据错误引导；依赖 OPT-02 的终态判定与受控终止。
5. **PR-03E：故障与兼容验收。** Desktop 跨进程用例、凭据轮换、超限预算、老数据与降级版本验证；Server 仍采用 OPT-02 interrupt。

每个 PR 先运行相关 schema/store/runtime/composition 测试与 lint/typecheck；最后一次跑完整单测和 Electron E2E，不能只用构造 meta 的单元测试声称跨进程恢复成功。
上线门槛：新公共 Run 快照写入率 100%；所有恢复失败均有可解释错误且无提前外部调用；恢复后无重复指令、无预算重置、无凭据落盘、无旧运行复活。
本项完成后不必迁移全部历史运行；保留可读历史和安全的新 Run 重试路径即可。

# OPT-02：Runtime 与 Server 崩溃恢复闭环

> 状态：详细实现建议，尚未实施。代码核对基线：`e544bae`，核对日期：2026-09-10。
> 本文新增类型、方法、文件和状态字段均为拟议设计；未注明新增的代码依据指基线已有实现。

## 1. 目标、范围与默认决策

本项解决 Server 重启后“业务 Run 已中断，但 Runtime Lane 仍被旧 operation 占用”的问题。
恢复完成后，用户必须能够在原会话发起新任务，并查询到可解释的旧任务状态。

**默认策略明确选择 `interrupt`：Server 启动时终止遗留的非终态 operation，不自动继续模型请求或工具执行。**
已有 Runtime 终态保留，不因重启改写；缺失 Runtime operation 的业务 Run 按启动未提交处理。
恢复过程只做本地事实核对与持久化修复，不调用模型、业务工具、外部发送接口或 Stop Hook。
终止不等于回滚：进程退出前已经发生的外部效果保留，未知结果标记为未知。

本期不新增 Server HTTP 的人工恢复接口，也不实现跨主机接管或分布式执行租约。
Desktop 现有继续旧 operation 的行为不在本项中改为自动终止。
执行配置快照、恢复身份与当前权限重新验证由 [OPT-03](./opt-03-resume-execution-context.md) 定义。
以后若增加 Server `resume` 策略，必须显式选择并满足 OPT-03；不能改变本文默认策略。

## 2. 当前触发路径与已存在的基础

| 基线位置 | 当前行为 | 对本项的意义 |
| --- | --- | --- |
| `packages/app-service/src/jojo-app-service.ts:216` | 先保存 accepted，再 starting，随后调用 Runtime | 业务数据库与 Runtime 数据库之间存在合法中间状态 |
| `packages/storage/src/sqlite-runtime-store.ts:264` | 创建 operation 与设置 Lane 占用在同一事务内 | 正常创建不会留下只有一半的 operation/Lane 配对 |
| `packages/app-service/src/recovery-coordinator.ts:10` | 启动核对 session、approval、run | 已有恢复协调入口，应增强而非另建平行流程 |
| `packages/app-service/src/recovery-coordinator.ts:37` | 未证明终态的业务 Run 被标为 interrupted | 没有改变 Runtime operation，且 accepted 分支跳过 inspectRun |
| `packages/agent-runtime/src/public/runtime.ts:417` | Lane 有其他 currentOperationId 就拒绝新 run | 导致重启后原会话持续 runtime_lane_busy |
| `packages/app-service/src/jojo-app-service.ts:275` | 无 live handle 的 interrupted Run 取消直接返回 | 用户再次取消无法释放 Runtime 占用 |
| `packages/storage/src/sqlite-runtime-store.ts:295` | 终态写入与条件释放 Lane 在同一事务 | 必须复用的关键事务边界 |
| `apps/server/src/index.ts:117` | reconcile 完成后才构造服务并启动 Channel/Scheduler | 启动顺序已有基础，不能误写成“当前先 ready 后恢复” |
| `apps/desktop/src/worker/worker.ts:1103` | 检查主 Lane 并调用 resumeOperation | Desktop 策略已经不同，公共 Runtime 不能偷偷统一为终止 |

典型复现步骤：

1. 发起请求，两个数据库中分别存在 running Run 与 model_pending/tools operation。
2. 直接强杀 Server 进程，跳过正常 close 与取消逻辑。
3. 重启后，现有 coordinator 将业务 Run 标为 interrupted。
4. Runtime Lane 的 currentOperationId 仍指向旧 operation。
5. 同一 Lane 再次运行报 busy；取消旧 Run 又因业务终态直接返回。

仅补一条“清空 currentOperationId”的 SQL 会让旧 operation 与后续任务同时失去一致性，不作为方案。

## 3. 必须成立的不变量

- R1：新任务只能在恢复结束且所属 Lane 无活动 operation 时启动。
- R2：遗留 operation 的终态提交与其 Lane 占用释放必须原子发生。
- R3：释放条件必须匹配该 operationId，不能释放新任务占用的同名 Lane。
- R4：Runtime 终态不可被恢复重写为另一种终态，更不能回到运行态。
- R5：业务 interrupted 必须有可重复核对的 Runtime 终止事实，或 operation 从未存在的事实。
- R6：恢复不能因重复启动再次执行工具、再次发送消息或重复追加相同工具结果。
- R7：遗留 tool_call 必须有对应结果或明确的不确定结果，避免下一轮提交悬空工具调用。
- R8：审批历史可审计；旧审批不能在新进程中恢复一个已经消失的 Promise 或授权旧执行。
- R9：恢复任何阶段再次退出，下次启动都能继续收敛；不依赖跨数据库事务。
- R10：损坏数据、所有权冲突或存储写失败不能被吞掉后宣告 ready。

## 4. Host、App Service、Runtime 的责任边界

| 层 | 应承担 | 不应承担 |
| --- | --- | --- |
| Host | 数据目录独占、启动闸门、恢复时机、启动失败清理、ready 发布 | 直接编辑 operation JSON 或清 Lane |
| App Service coordinator | 会话元数据对账、审批失效、业务 Run 投影、跨库重试顺序 | 推断工具是否安全、执行工具、接触 Runtime 私有 store |
| Runtime | 枚举占用 Lane、检查 operation、补齐工具结果、保存终态、输出恢复报告 | 持有 HTTP 请求上下文或写 server-state.sqlite |
| Runtime store | 条件校验、终态事务、按 operationId 释放占用、持久化事实 | 自动调用 provider 或选择产品恢复策略 |

CLI 已在 `apps/cli/src/bootstrap/server-bootstrap.ts:20` 获取实例锁，并在打开 Runtime store 前完成。
锁实现位于 `apps/cli/src/bootstrap/instance-lock.ts:22`；不能据此声称所有库调用方已经有独占保护。
本期要求持久化 Server Host 对实际数据库目录维持单写者所有权，覆盖恢复和后续整个服务生命周期。
锁键必须绑定规范化数据目录，不能让两个不同 instanceId 绕过同一数据库的保护。
Headless 嵌入方必须提供同等所有权保障；未提供时拒绝进入持久化恢复，不默认为安全。
这里的所有权证明是 Host 的组合约束，具体适配器建议与现有 CLI 锁共用，禁止伪造“锁已持有”布尔开关。

## 5. 拟新增公共 API 与内部契约

以下为**建议新增**的公共 Runtime 接口，当前代码没有这些类型或方法。

```ts
type RecoveryOutcome = {
  operationId: string;
  sessionId: string;
  laneId: string;
  status: 'interrupted' | 'already_terminal' | 'conflict';
  uncertainToolCallIds: string[];
  errorCode?: string;
};
type RuntimeRecoveryReport = {
  outcomes: RecoveryOutcome[];
  ready: boolean; // 只表示 Runtime 核对通过，不能代替整个 Host ready
};
interface AgentRuntime {
  // 建议新增：Host 显式放弃无 live handle 的遗留执行，不代替活动任务 cancel。
  interruptOperation(input: {
    operationId: string;
    reason: 'host_restart' | 'resume_unavailable';
  }): Promise<RecoveryOutcome>;
  // 建议新增：仅用于 Host 尚未开放执行入口的独占启动阶段。
  recoverInterruptedOperations(input: {
    reason: 'host_restart';
  }): Promise<RuntimeRecoveryReport>;
}
```

返回报告是启动诊断，不作为恢复成功的唯一持久记录；终态本身必须能够重新读取。
找不到 operation 的占用 Lane 以 conflict + runtime_operation_missing 返回，保留现场并阻止 ready。
没有占用 Lane 且业务 Run 无 operation，不属于该 API 的冲突，由 coordinator 对账。
公共 API 不要求 provider、tools 或恢复上下文快照可用，终止路径不能因模型凭据缺失而失败。
单条 interruptOperation 供 OPT-03 预检失败后由 Host 显式选择放弃；它不能重新调用 resume 以绕过预检。
单条入口必须持有同一 Lane 的执行互斥并确认目标无 live handle；正常运行的任务仍使用已有取消流程。
互斥需要覆盖 start/resume 的占用建立阶段，不能仅检查 activeRuns 后在异步间隙继续终止。
未知 operationId 直接返回类型化 not-found 错误；已有终态返回 already_terminal，不改写原因。

建议在 Runtime 内增加启动恢复互斥：同一次并发调用共享同一个 Promise，失败后可显式重试。
API 从进入恢复到完成期间拒绝 startRun/resumeOperation；已有 activeRuns 时拒绝执行启动恢复。
Host 负责保证创建 Runtime 到调用该 API 的间隙也没有任务入口开放。
成功报告不能无限缓存：再次调用必须重新检查 Lane，避免把新损坏状态隐藏在旧报告后面。

建议为已有 Store 方法增加可选条件参数，**不是基线已支持的签名**：

```ts
saveOperationState(state: OperationState, options?: {
  expectedState: OperationState;
  expectedLaneOperationId: string;
}): Promise<void>;
```

条件在已有 `BEGIN IMMEDIATE` 事务内检查，比较当前持久化 state 与 expectedState 的结构值。
本期无需引入数据库全局事务号；如果改用 revision，必须同步升级 SQLite 与 Memory store 的契约测试。
普通写入也应拒绝终态转非终态及不相同终态覆盖；完全相同的终态提交允许幂等返回。
条件失败返回明确冲突，Runtime 重新读取后决定“已终态”还是阻止 ready，不能强行覆盖。

## 6. Runtime 恢复算法与事务边界

扫描来源是 `listSessions()` + 每个 session 的 `listLanes()`，并读取非空 currentOperationId。
不能仅扫描业务 `runs.listRecoverable()`，否则旧版本已标 interrupted 的残留占用和无业务记录的 Lane 会被漏掉。
本期在启动阶段顺序处理 Lane，减少恢复路径的并发复杂度；后续再依据启动耗时增加有界并发。

以下为建议伪代码，`withRecoveryGate`、`settleInterruptedTranscript` 均为拟新增内部函数：

```ts
return withRecoveryGate(async () => {
  assertNoActiveRuns();
  const outcomes = [];
  for (const lane of await listOccupiedLanes()) {
    const operation = await store.loadOperation(lane.currentOperationId);
    if (!operation || !belongsTo(operation, lane)) {
      outcomes.push(conflict(lane, 'runtime_operation_identity_conflict'));
      continue;
    }
    if (isTerminalState(operation.state)) {
      // 通过同一终态保存事务做条件释放，不直接修改 Lane。
      await saveSameTerminalWithExpectedOwner(operation, lane);
      outcomes.push(alreadyTerminal(operation));
      continue;
    }
    const transcript = await settleInterruptedTranscript(operation, lane);
    const terminal = failedByHostRestart(operation, transcript);
    await store.saveOperationState(terminal, {
      expectedState: operation.state,
      expectedLaneOperationId: operation.meta.id
    });
    outcomes.push(interrupted(operation, transcript.uncertainToolCallIds));
  }
  return { outcomes, ready: outcomes.every(item => item.status !== 'conflict') };
});
```

`failedByHostRestart` 建议使用已有 failed phase，错误 code 为 runtime_interrupted；不伪装成用户取消。
该内部构造函数在单条入口也接受 resume_unavailable 原因，持久化实际原因而不一律记成 host_restart。
建议在 error.detail 持久化 reason、原 phase、恢复结果 leafId、uncertainToolCallIds，避免存入工具敏感输入。
`inspectRun` 应保留这份 detail，使第二次启动无需第一次的内存报告也能正确映射业务 interrupted。
该数据是终止审计，不是 OPT-03 执行配置快照。

已有 `saveOperationState` 的事务应按以下顺序增强：

1. BEGIN IMMEDIATE，读取 operation 与所属 Lane。
2. 校验 operation 身份、expectedState 和 Lane owner。
3. 更新 operation 的终态 JSON。
4. 执行现有条件 SQL：`UPDATE lanes SET current_operation_id = NULL ... AND current_operation_id = ?`。
5. COMMIT；发生异常 ROLLBACK，不能产生只终止或只解锁的提交。

终态已存在且 Lane 已释放时重复提交为 no-op；Lane 已归新 operation 时绝不释放新 owner。
初次恢复发现状态冲突后重读一次；若是自然终态就对账，否则明确失败，不进行无界重试。
同步数据库锁等待沿用现有 busy_timeout；超时报告存储失败，Host 不进入 ready。

## 7. 工具效果不确定性与 transcript 修复

已有 interpreter 在 `packages/agent-runtime/src/operation/interpreter.ts:13` 区分 replay safe/never。
默认 interrupt 策略即使遇到 replay safe 也不重放；safe 只对未来显式 resume 路径有意义。
已有 `runner.ts:369` 的 appendInterruptedResults 使用 cancelled，不能原样用于崩溃恢复。
建议抽取共享持久消息辅助函数，新增不调用工具、不发运行事件的恢复专用结果构造逻辑。

| 持久化工具事实 | 恢复动作 | 结果含义 |
| --- | --- | --- |
| 结果 entry 已存在，但 state 仍是 effect_pending | 验证 callId 与所属分支并接回缺失的 leaf 链 | 保留真实结果，不用失败结果覆盖 |
| effect_pending，结果不存在 | 使用原 resultEntryId 补 interrupted_uncertain_effect | 已可能发生效果，成功与否不可证明 |
| planned 或等待审批，结果不存在 | 使用原 resultEntryId 补 interrupted_before_execution | 没有持久化证据表明进入效果执行阶段 |
| completed 且合法结果已存在 | 保留并检查链可达 | 不重复追加或执行 |
| completed 但结果缺失、ID 对应其他调用 | 报数据冲突 | 不猜测工具成功，不静默修复 |

每个未结调用用稳定 resultEntryId 保证幂等；补结果前先读取、核对所属 session 和 callId。
消息追加与更新 leaf 仍可能跨两个提交，必须处理“entry 已写入、leaf 尚未推进”的重启窗口。
只能将当前 leaf 推进到确定紧邻的待接 entry；若该 entry 已在祖先链上则跳过，禁止把 leaf 回退到旧结果。
父子链关系不符合预期时阻止 ready，避免把其他 Lane 的结果接入当前 transcript。
若 assistant 响应已落盘但 state 尚未从 model_pending 推进，须检查 responseEntryId 并补齐其未匹配工具调用。
此窗口尚未进入工具执行；使用确定性恢复结果 ID，保持工具调用与结果配对，不直接重请求模型。
所有 transcript 修复在终态提交前完成；中途退出后仍保留占用，下一次按相同 ID 继续。
恢复不触发 Stop Hook、记忆提取或外部通知；重复恢复不会因此产生第二次业务效果。

## 8. Server 启动顺序与业务对账

保留 `createHeadlessServer` 先 reconcile 后启动服务的结构，并将初始化失败清理覆盖到 reconcile 本身。
当前 reconcile 位于 `apps/server/src/index.ts:117`，在 127 行 try 之前；失败清理边界需向前扩展。

1. Host 获取数据目录所有权；打开 Runtime、Server 状态数据库。
2. 构造 Runtime 与尚未开始监听的组件，所有 Channel/Scheduler/请求入口保持关闭。
3. coordinator 修复 session metadata 创建中间状态。
4. 将持久化 pending approval 标为 interrupted，保留 allowed/denied 等历史结论。
5. 调用建议的 recoverInterruptedOperations，确认无 conflict。
6. 对业务 accepted/starting/running Run 读取 Runtime 事实并更新状态。
7. 再检查不存在应处理的占用 Lane、活动业务 Run 或 pending 审批。
8. 构造 App Service 与 server core；启动 Channel/Scheduler；最后允许 listen 并发布 Host ready。

后台组件初始化即执行工作的能力也必须遵守闸门，不能仅阻止 HTTP 请求。
任何一步失败都关闭已创建资源、保持未就绪，并释放 Host 所有权；不得后台吞错继续启动。

业务映射建议如下：

| Runtime 事实 | 业务 Run 处理 |
| --- | --- |
| completed/cancelled/普通 failed | 使用已有 markCompleted/markCancelled/markFailed 保留真实结果 |
| failed + runtime_interrupted + 恢复审计 detail | markInterrupted；保存清晰原因与不确定工具 ID |
| operation 不存在 | accepted 标 run_start_not_committed；starting/running 标 runtime_interrupted |
| 非终态仍存在或报告冲突 | 不将其伪装终态后继续启动；恢复失败 |

移除 accepted 跳过 inspectRun 的特例；若 accepted 对应已有完成事实，先合法转 starting，再写终态。
每一步沿用 Run.version 乐观检查，冲突后重读；业务终态不自动覆盖成其他终态。
默认 interrupted 的 retryable 建议为 false，明确表示不能自动重放原请求；用户可以创建新的后续 Run。
查询终态结果必须绑定该 operation 的结束位置；优先使用已有 finalEntryId 或本项的恢复 leafId。
`public/runtime.ts:262` 当前使用 Lane 最新 leaf，不能用于证明旧 operation 的最终回复。
旧终态缺少可靠边界时只保留可证明的状态，并标记结果不可完整重建，不借用后来任务的消息。

## 9. 审批、重复恢复与跨库窗口

旧 pending 审批的重发点击应返回 approval_interrupted；现有 broker 在 `approval-service.ts:102` 已支持该错误。
allowed 历史不回滚，但不重建 live pending，也不据此执行崩溃前未完成的工具。
需要继续同一工作时创建新 Run，按当前权限重新判断；显式 resume 的细节遵循 OPT-03。

Runtime SQLite 与 server-state.sqlite 保持独立提交，处理顺序是“Runtime 事实先完成，业务投影后完成”。
若终态与 Lane 已提交、业务状态未提交就崩溃，下次 inspectRun 应重建 interrupted 或真实终态再投影。
若业务状态已提交、ready 未发布就崩溃，下次重复核对必须幂等，不重新创建 Run 或重复追加 transcript。
审批先失效、Runtime 仍未终止的窗口允许存在；Host 未 ready，因此旧审批不能驱动执行。
启动中断不会做补偿式“把 Runtime 改回 running”，也不会通过删除业务记录掩盖不一致。

## 10. 旧数据兼容与范围约束

- 旧版本已将业务 Run 标 interrupted 但 Lane 仍被占用：Runtime 扫描照常终止，保留业务终态。
- 有占用 Lane、没有业务 Run：先终止 Runtime 并报告 orphan operation，不伪造 API 用户与业务输入。
- 旧 operation 缺少 OPT-03 snapshot：interrupt 不依赖该字段，仍可完成终止。
- 旧终态缺少恢复 detail：沿用原有成功、取消或失败语义，不推断为 host_restart。
- Lane 引用缺失 operation、跨 session 身份冲突、损坏 JSON：报告损坏并拒绝 ready；不删除证据。
- 本期新增审计信息可放已有 error.detail JSON，无需假设所有存量数据库已有新列。
- Memory store 与 SQLite store 必须满足同一条件写、终态不可逆和重复恢复约束。
- Desktop 继续走既有 resume 策略；公共终态写保护不能阻止合法的非终态恢复。
- 已终止 operation 不允许再次 resume；新输入只能创建新 Run，不能复活旧 operationId。

## 11. 精确文件清单与 PR 拆分

| PR | 文件 | 拟修改内容 |
| --- | --- | --- |
| 1 | `packages/agent-runtime/src/store.ts` | 建议增加条件终态保存参数 |
| 1 | `packages/agent-runtime/src/memory-store.ts` | 条件写入、终态不可逆与幂等语义 |
| 1 | `packages/storage/src/sqlite-runtime-store.ts` | 增强现有事务，复用条件释放 Lane |
| 1 | `packages/agent-runtime/test/store-conformance.ts` | 两种 store 共用的不变量测试 |
| 1 | `packages/storage/test/sqlite-runtime-store.test.ts` | 事务失败、旧 owner 与终态保护测试 |
| 2 | `packages/agent-runtime/src/public/runtime.ts` | 建议新增恢复 API、互斥、结果 detail 与结束位置读取 |
| 2 | `packages/agent-runtime/src/public/index.ts` | 导出建议新增恢复类型 |
| 2 | `packages/agent-runtime/src/recovery/interrupted-operation.ts`（新增） | 占用扫描、工具结果修复、终止算法 |
| 2 | `packages/agent-runtime/src/harness/runner.ts` | 抽取可复用持久消息逻辑，保持正常取消语义 |
| 2 | `packages/agent-runtime/test/recovery.test.ts` | 不重放、补结果、重复恢复 |
| 2 | `packages/agent-runtime/test/public-runtime.test.ts` | 恢复互斥与历史结果稳定性 |
| 3 | `packages/app-service/src/recovery-coordinator.ts` | 调用 Runtime 恢复、业务事实对账与二次检查 |
| 3 | `packages/app-service/test/recovery-coordinator.test.ts` | accepted 已完成、跨库窗口与旧 interrupted |
| 3 | `apps/server/src/index.ts` | 启动闸门、恢复失败清理与 ready 顺序 |
| 3 | `apps/cli/src/bootstrap/instance-lock.ts`、`apps/cli/src/bootstrap/server-bootstrap.ts` | 数据目录独占核对、适配器复用与生命周期 |
| 3 | `apps/server/src/server-runtime.test.ts` | 恢复前不监听、不执行 Scheduler/Channel |
| 4 | `apps/server/src/server-recovery-crash.test.ts`（新增） | 真实子进程强杀矩阵 |
| 4 | `apps/server/test-fixtures/recovery-host.ts`（新增） | 测试专用 Host、同步检查点与效果计数器 |

PR 1–2 先独立验证 Runtime 契约；PR 3 启用 Server 默认策略；PR 4 的关键强杀用例必须随 PR 3 合并前跑通。
现有业务状态方法足够表达本期映射，不新增 HTTP 路由，也不允许 coordinator 导入 SQLite 私有实现。

## 12. 真实 SQLite 子进程强杀矩阵

测试使用独立临时目录、两个真实 SQLite 文件和一个仅追加的外部效果计数文件。
子进程运行真实 Host/Runtime，ScriptedProvider 只替代网络模型；工具实际更新效果计数文件并 fsync。
父进程等待显式检查点后 SIGKILL，确认退出，再用同一路径启动全新子进程；不得用 close 模拟强杀。
事务内部检查点用测试注入的同步阻塞钩子写标记文件；不依赖固定 sleep，也不暴露生产环境开关。
Windows 使用实际强制结束进程的等价实现并验证退出；不声称其信号机制与 POSIX 相同。

| 强杀检查点/场景 | 重启后核心断言 |
| --- | --- |
| accepted 提交后、Runtime 创建前 | 业务 run_start_not_committed；原 Lane 可运行 |
| startOperation 提交后、业务 running 前 | Runtime interrupted；Lane 释放；业务收敛 |
| model_pending、流尚未完成 | provider 不被恢复调用；不生成伪成功回复 |
| assistant entry 提交后、state 推进前 | responseEntryId 被识别；工具调用配对完整 |
| pending 审批提交后 | 审批 interrupted；旧点击不执行工具 |
| effect_pending 提交后、效果发生前 | 不执行工具；标记不确定结果，不猜测未执行 |
| 效果文件 fsync 后、结果 entry 前 | 效果计数为 1；重启两次仍为 1；结果标未知 |
| 结果 entry 提交后、Lane leaf 更新前 | 复用真实结果并接链；无重复 message |
| 恢复补结果提交后、终态事务前 | 第二次启动跳过已接结果，不回退 leaf |
| 终态 UPDATE 后、Lane UPDATE 前 | 杀后事务回滚；不出现仅一半更新 |
| 终态与 Lane COMMIT 后、业务更新前 | 下次通过 Runtime detail 完成业务 interrupted |
| 业务更新后、Host ready 前 | 重复启动不改写终态、不追加第二份结果 |
| 恢复期间并发 start/resume/recover | 新执行被闸门拒绝；重复恢复共享执行，无双写 |
| 旧 owner 与新 owner 竞争、过期 state 提交 | 条件冲突；新 Lane owner 不被清除 |
| 业务旧 interrupted + Runtime 非终态 | 清理遗留 operation 后原会话可继续 |
| 数据损坏、数据库写失败、所有权已被占用 | 启动失败；没有 ready 或后台调度执行 |

每个成功恢复用例最后必须通过 App Service 在同一 session/Lane 完成一次新的真实 Runtime Run。
不仅断言 busy 消失，还断言新输入、工具结果配对、最终状态、旧任务查询和效果计数正确。
事务原子性用例额外执行 SQLite integrity_check；记录所有未闭合子进程并在测试 finally 中回收。

## 13. 合并验收与交付证据

- 上述 R1–R10 均有对应测试，真实 SIGKILL 用例不能被 Memory store 单测替代。
- 旧业务 interrupted、Runtime 已终态、无业务记录三个历史场景均覆盖。
- 强杀后重复启动两次，效果计数与稳定 message ID 集合不增长。
- Runtime 或业务投影失败时，Server/Channel/Scheduler 均未对外开始工作。
- 运行 `pnpm typecheck`、`pnpm lint`，以及 Runtime、storage、app-service、server 的相关 Vitest 用例。
- PR 附上实际执行命令、平台、通过用例数与失败日志；未执行的跨平台测试明确标注。
- 文档和对外行为说明明确：默认中断可继续会话，但不承诺回滚外部效果或自动继续旧任务。

# 架构收口实施记录

依据：[架构收口与发布验证方案](jojo-agent-architecture-closure-release-validation.md)。

## 已落地的基础改造

- PR-01 的基础架构 Guard：`pnpm test:architecture` 检查 workspace 生产依赖环、关键层依赖方向、声明遗漏、公开 subpath、跨包相对路径、Renderer 对 Node 和 workspace implementation 的依赖。使用 TypeScript AST 识别 import、re-export、动态 import、require 和 import type。Guard 自身有隔离 fixture 测试，已接入 CI。
- PR-03 应用契约下沉：`contracts/application` 定义 Session、Run、Transcript、Approval、应用上下文与错误快照；app-service 已删除 server-protocol 依赖及锁文件中的对应边。Server Protocol 保留现有公开名字，并在中立 Schema 上增加 connectionId、lease、上传凭证和错误 requestId；Server Core 为 Session 查询、创建、修改补充租约。
- PR-02 的版本与能力基础：`BUILD_COMPATIBILITY` 已接入 Server 协议、Runtime contract、Server State、Config、JSONL Session 与 SQLite Runtime 的当前版本；`CAPABILITY_MANIFEST` 为 Server 默认能力和生成文档提供来源。可选服务关闭时不会声明为已启用。自定义 Host 的能力覆盖保留。
- `pnpm docs:generate` / `pnpm docs:check` 生成并检查 README 版本摘要和 `current-features.generated.md`，同时检查根 package 版本与 Manifest 一致。CI 已加入 `docs:check`。
- 修正文档对 Main↔Worker runtime validation 的过时描述。当前没有版本握手，Manifest 明确记录为 `null`。

## 边界与未完成项

当前已完成基础契约、迁移与 Desktop 会话正文事实源切换，不代表整份方案完成。

- Architecture Guard 对 contracts 的 channel-core 依赖有显式允许：该包提供领域接口与 primitives。多个 Feature Implementation 的 Composition Root 限制尚未全面启用，现有 extensions/storage/channel-runtime 等适配边界需先梳理。
- Capability Manifest 尚未驱动 Desktop 功能可见性、CLI doctor 和所有 SDK feature detection；当前描述内置 Host 的能力，不能替代运行中 ServerCapabilities。
- 中立错误快照已下沉，统一 JojoError 异常类及各 Host 错误映射尚未实施。
- Operation Registry 已覆盖 20 项 Session / Run / Approval / Scheduler / Channel 操作。REST 使用 Registry 的 input，Server Core 使用对应 permission，WebSocket 和 Desktop IPC 在共享 Schema 上添加各自 envelope。Desktop 的 Session/Turn 数据模型和审批授权范围仍由 Host 适配，尚未等同于共享应用状态机。
- Desktop 会话正文已统一读写 Runtime；会话标题、项目目录和项目绑定已切换到应用 SQLite；SQLite 已承担在线会话发现；JSONL 仍用于进程首次列表时的兼容扫描、新建时的旧格式记录、旧正文/元数据导入及文件删除 tombstone。Desktop 元数据在线操作已统一进入 SessionMetadataService，Main 仅通过 Worker IPC 调用。
- Desktop 会话准备、新运行、续跑和两端 Scheduler Agent 执行已接入 JojoAppService；Team/Workflow/子代理的 Desktop Agent 执行已接入应用运行索引；编排调度、恢复前的环境准备和 Workflow 直接工具步骤仍由各自服务负责。Desktop 审批查询、决策与持久化现已共用应用服务 Broker；两端重启都会中断旧 pending 审批，Desktop 续跑仍按 Runtime 策略重新检查权限。两端已共用核心 Product Composition，Main/Worker 已拆出 bootstrap、功能 IPC、会话执行控制与密钥适配模块；更全面的共享 Feature 装配及完整跨 Host conformance 仍待实施。
- Desktop 应用运行索引现已持久化到 `runtime/application.sqlite`，启动策略保留待续跑的 Runtime 操作；下文早期阶段关于内存索引的描述为历史状态。会话标题和项目绑定的在线入口已使用 SQLite；在线会话发现已使用 SQLite；旧文件扫描、首次导入和删除屏障仍保留兼容层。
- 发布候选流程已加入三平台构建、签名/公证配置与校验、SBOM、SHA-256 及离线备份恢复；真实签名凭据、干净系统安装和上一正式版 N-1 升级/回滚验收仍需执行，不能把开发回归结果当作发布验收。

## 下一阶段

Desktop 审批、元数据应用入口及 Main/Worker 模块拆分已完成本阶段收口。下一阶段继续完善共享 Feature 装配、跨 Host conformance、能力检测与发布门禁。

其中 Desktop 会话准备和新运行的首次接入已完成，后续优先统一恢复与审批，并处理持久化应用索引的恢复语义，避免直接套用 Server 的重启中断策略而破坏 Desktop 续跑。

## 验证命令

```sh
pnpm lint
pnpm typecheck
pnpm test:architecture
pnpm docs:check
pnpm test
```

全量测试需要本地回环端口和 Chrome 子进程；文件系统沙箱内的 `listen EPERM` 不能作为产品测试结论。Electron E2E 已用于本次事实源切换验证；分发包与多平台发布测试仍需在 Release 阶段执行。

本轮验证结果：lint、typecheck、6 个架构 Guard fixture、仓库架构扫描、docs:check 均通过；沙箱外全量回归 190 个测试文件通过、1 个文件跳过，1148 个测试通过、2 个测试跳过。最后补充的 Session 修改租约断言与应用契约/能力测试定向回归共 8 个测试通过。


## Operation Registry 阶段

- 新增公开入口 `@desktop-agent/contracts/application/operations`，定义操作输入、输出、权限 scope 和不带幂等键的重试语义；Run 启动、Scheduler 手动触发等有副作用操作标为非幂等。
- Channel Schema 从 Server Protocol 下沉到 `contracts/application/channels.ts`，原协议包继续兼容导出；Desktop 从这些 Schema 派生本地受限草稿。
- REST Session / Transcript / Approval / Scheduler / Channel body/query 使用 Registry，Server Run 保留上传凭证 envelope；Server Core 对应权限检查使用 Registry 的现有 scope，不改变权限名称。
- Desktop Scheduler Main/Worker 校验接入 Registry；审批 Main/Worker 共用 Desktop 审批输入；Session/Turn 复用应用字段并保留本地标题、附件及空白校验。
- `docs:generate` / `docs:check` 现在还生成和检查 [应用操作目录](current-operations.generated.md)。Registry 的输出 Schema 用于描述中立结果，不代表所有 Transport 已对输出执行运行时校验。
- 新增跨 Transport 测试覆盖共享 Schema、无效 Channel policy、Scheduler 输入、Desktop secret 引用、审批范围、provider/model 空白值及 WebSocket 严格 envelope。

本阶段验证：全量回归 191 个文件通过、1 个文件跳过，1160 个测试通过、2 个测试跳过；字段校验最后调整后的 12 个跨 Transport 用例另行通过。lint、typecheck、architecture 与 docs:check 均通过。尚未执行本阶段 Electron E2E/打包验证。


## 旧会话迁移基础阶段

- SQLite Runtime schema 从 1 升至 2，新增 `runtime_migrations`。`importLegacyTranscript` 在 `BEGIN IMMEDIATE` 事务中完成消息插入、lane 指针更新、读回 hash 验证及迁移标记写入。
- 标记记录规范化 source hash、去重后的 source count、本次导入 hash/count、保留的 Runtime 消息数与完成时间。同源重试不写入；源有新增时增量导入；Runtime 已有消息保持权威，不用 legacy projection 覆盖它们。
- 对旧 seed 留下的孤立 entry，仅在父指针和内容 hash 均吻合时挂回 main lane；跨 Session ID 冲突、不匹配的孤立 entry 和同源重复 ID 内容冲突会回滚整个导入。
- 主对话与 Scheduler 已替换 `seedRuntimeLaneFromLegacy`。有 active operation 的 lane 返回 busy，保留原有恢复流程。
- `loadForMigration` 拒绝损坏/截断记录与 Session ID 不匹配，避免把有警告的读取结果标记为迁移完成。普通历史读取仍保留原有 warning 行为；损坏源文件需修复后重试，当前不提供自动修复工具。
- JSONL 读取尊重持久化 tombstone，删除后复制回旧文件也不会再次列出会话或加载消息。
- 迁移 fixture 覆盖去重、重开、写 entry/lane/marker 失败回滚、增量失败保留旧标记、旧孤立 entry、跨会话冲突、busy、tombstone、损坏文件和 SQLite v1→v2 升级。
- 修复 Electron Vite 的 contracts 子路径别名。Desktop E2E 构建成功；旧会话导入/重启/删除防复活测试，以及已有的 Electron SIGKILL/model_pending 恢复测试均通过。尚未对导入事务执行 OS 级 SIGKILL；迁移中断目前通过 SQL trigger 故障注入验证。
- 该历史阶段为过渡模式（已由下述事实源切换取代）：Scheduler 可能向 JSONL 追加投递，Runtime 完成后仍有 JSONL projection。迁移标记因此记录最近同步快照，不能被解释为可永久忽略源文件。

阶段验证：全量回归 1171 通过、2 跳过；随后补充的增量回滚用例单独验证。Electron 定向 E2E 2 通过；构建、lint、typecheck、architecture、docs:check 均通过。

## Desktop 会话正文事实源切换

- Renderer 历史加载、Artifact 消息授权、轨迹导出和 Channel 回复查询统一读取 Runtime。读取 main lane 的原始消息链，不使用面向 Provider 的压缩上下文，因此历史压缩不会截断用户可见正文。
- 删除 `legacy-projection.ts` 及 Runtime→JSONL 回填。新对话与 Scheduler 投递不再向 JSONL 写 message；会话列表从 Runtime 补充自动标题和最近消息时间。
- 首次准备会话使用独立的 `legacy-jsonl-main-cutover-v1` 标记。原有增量迁移 API 保留兼容；完成切换的 Desktop 会话永久忽略旧 JSONL 新增正文，避免旧文件复活历史。迁移完成后的读取不依赖 Worker 在线。
- SQLite schema 升至 3，新增持久投递队列和永久删除记录。Scheduler 投递在 main lane 忙时先事务性入队，立即可查询；空闲后原子挂接到 lane，避免覆盖正在运行的 leaf。读取正文与队列使用一致性快照，重复相同 ID 幂等，冲突内容报错。
- 删除先停止会话运行，再写文件存储 tombstone，随后事务性永久删除 Runtime 会话。永久删除记录拒绝迟到的会话重建；元数据删除失败前不会先清空唯一正文。JSONL 仍承担元数据兼容存储，不宣称其已完全退出在线路径。
- Architecture Guard 增加 Desktop 正文 JSONL 读写回归检查。单元测试覆盖压缩前历史、忙时投递、重开、排空失败回滚、冲突、一次性切换及永久删除。Electron 测试改为验证 Runtime 历史，并断言新对话不生成 JSONL message。

验证：全量回归 194 个文件通过、1 个跳过，1178 个测试通过、2 个跳过；完整 Electron E2E 20 项通过。之后补充删除顺序与永久 tombstone 调整，存储定向测试 13 项、Electron smoke/迁移/崩溃恢复 9 项通过；构建、typecheck、lint、7 个架构 fixture、仓库架构检查及 docs:check 均通过。尚未完成打包安装、签名、公证和多平台升级回滚验收。

## Desktop 接入 JojoAppService：会话准备与新运行

- 共享 `JojoAppService.openSession` 支持已有 Host 会话的幂等准备，保留应用元数据和 Runtime 历史；首次迁移准备与主运行的会话入口已使用该用例。
- 新增 `executeRun`，复用 Server 的 `startRun` 状态转换，等待结果写入应用状态后再返回。Desktop 主运行及经该入口执行的 Channel 运行不再直接调用 `lane.run`。
- Host 的 AbortSignal 通过内部 options 传递，不进入 Transport DTO 或持久化请求元数据。Channel runId、actor、trigger 与来源信息保留；本地交互运行明确标记为 user 来源。
- Worker 继续装配 Provider、Tools、Browser、Secret、Permission 等环境，环境绑定在应用用例完成后释放。退出经 App Service 关闭其活动运行及 Runtime。
- 当前 Desktop 使用默认内存应用索引，Runtime SQLite 仍保存持久化运行与正文事实；尚未将 Server 的持久化应用索引和重启中断策略移植到 Desktop。旧 operation 续跑、审批、Scheduler dispatch 仍有独立入口。因此这是 PR-07 的首次接入，不代表应用状态机或 Product Composition 已全部收口。
- 新测试验证会话重开保留元数据与历史、运行完成前提交终态、Channel 来源及 Host 取消；Electron 完整回归 20 项通过。

本阶段验证：全量回归 195 个文件通过、1 个跳过，1182 个测试通过、2 个跳过；Electron 20 项通过。typecheck、lint、architecture、docs:check、Electron 构建与 diff 空白检查通过。

## Desktop 接入 JojoAppService：捕获运行续跑

- `resumeRun` 按原 runId 续跑 Runtime 捕获的 operation；Worker 不再直接调用 `resumeOperation`，环境绑定和模型选择仍留在 Host。
- 恢复入口先校验 Runtime 会话归属，再合并同一 runId 的并发恢复。已有终态只同步应用结果，不重新执行；已知应用记录的 Session/Lane 冲突直接拒绝。
- 对没有应用索引的旧运行，依据 Runtime execution summary 补齐会话与运行记录。恢复记录的 inputHash 使用显式 `recovered:<runId>` 标记，不能当作原始请求 hash 或重放依据。既有运行记录保留原有元数据。
- 恢复准备失败保留可重试状态；成功后与新运行共用终态记录逻辑。取消信号传入原 operation，返回前等待应用结果提交。
- 本阶段仍使用 Desktop 内存应用索引，未改变 Runtime SQLite 事实源，未采用 Server 启动时主动中断所有遗留运行的策略。持久化索引还需结合删除、恢复和升级语义设计；审批和 Scheduler dispatch 仍待收口。
- 新增测试覆盖终态接管、跨会话拒绝、并发恢复只执行一次、原 runId 保持、取消信号传递与环境准备失败重试。

本阶段验证：全量回归 195 个文件通过、1 个跳过，1185 个测试通过、2 个跳过；Electron 20 项通过，包含 model_pending 时 SIGKILL 后按原执行快照续跑。构建、typecheck、lint、architecture、docs:check 与 diff 空白检查通过。

## 审批收口：共享等待生命周期

- `app-service` 新增 `PendingApprovals`，Desktop Worker 和 ServerApprovalBroker 共用等待登记、取消、单次结算及监听器清理。Desktop 的已取消 signal 不再登记悬空等待；重复 requestId 不会覆盖原等待者，旧结算函数不能误删复用 ID 的新请求。
- Server 保留先持久化、后发布/结算的顺序；取消落库失败通过等待 Promise 传回 Runtime，避免未处理的后台 rejection。等待落库期间保留 requestId，拒绝并发重复请求和存储重绑定；已结束的持久审批不再重新发布，已有记录的 Session/Run/Lane 必须匹配。
- Desktop 的“类似命令/本次对话”授权仍由 Permission Grant Store 处理；Channel 回调、会话停止与删除使用共享组件的单次结算。项目 Hooks 等运行前审批仍受支持。
- 这一阶段统一的是等待生命周期，不代表 Desktop 已使用 Server 的审批持久化模型或全部改走 `JojoAppService.resolveApproval`。运行前审批缺少 runId，其契约与持久化归属仍需继续收口。
- 定向测试覆盖预先取消、发布时取消、重复 ID、旧回调、监听器清理、取消落库失败、发布异常、落库期间重复请求及持久审批终态拒绝重发。

本阶段验证（2026-10-06）：全量回归 196 个文件通过、1 个跳过，1192 个测试通过、2 个跳过；Electron 20 项通过。构建、typecheck、lint、architecture、docs:check 与 diff 空白检查通过。上次中断运行的临时日志已失效，此处计数来自本次重新执行。

## Scheduler Agent 执行接入共享应用服务

- JojoAppService 新增 `startRunHandle`，复用运行状态机并提供 result/cancel 句柄。结果 Promise 等待应用终态写入后才完成；Host 不需要直接持有 Runtime 的运行句柄。
- AgentScheduleDispatcher 支持注入启动用例。Desktop 与 Headless Server 的组合入口都注入 App Service，保留原 executionId、scheduler trigger、scheduleId 和 scheduleRunId；不让 scheduler 包依赖应用服务实现。
- Scheduler 继续负责 lane 创建、重复 dispatch 的 Runtime 查询、环境绑定释放和投递。独立使用 Dispatcher 时保留原 Runtime 启动路径；内置两端的 Agent Target 已使用应用入口。Team Member、Workflow Target 的执行适配仍待后续统一。
- 应用结果 Promise 拒绝时发布明确失败状态并释放环境，避免仅吞掉异常后长期保留 running。
- 参数化测试验证 Runtime 兼容路径与应用路径的稳定身份、专用 lane、来源、完成状态记录和重复 dispatch 不重复执行。Desktop 应用索引仍在内存中，Server 使用已配置的状态存储，本阶段未宣称统一两端持久化模型。

本阶段验证：全量回归 196 个文件通过、1 个跳过，1193 个测试通过、2 个跳过；Electron 20 项通过。构建、typecheck、lint、architecture、docs:check 与 diff 空白检查通过。

## Desktop 持久化应用运行索引

- Desktop 为共享 JojoAppService 配置 SQLite 状态适配器，文件为 `runtime/application.sqlite`。新运行和 Scheduler Agent 的应用状态、原始请求 hash 与来源元数据可跨进程保留。旧 Runtime 运行仍可在续跑时按已有恢复用例接管。
- 恢复协调器以 `ApplicationRecoveryCoordinator` 为中立名称，保留 `ServerRecoveryCoordinator` 兼容导出。Desktop 选择保留未终结 Runtime operation；已完成操作同步到应用终态，未提交到 Runtime 的应用记录标记 interrupted。Server 默认仍执行原先的重启中断策略。
- 应用状态 schema 升至 3，增加永久删除表和数据库插入触发器。删除会话事务性清理元数据、运行结果副本和审批记录，禁止其他连接或迟到任务重建同一 Session ID。
- Main 在文件 tombstone 和 Runtime 删除后清理应用索引。启动时基于文件 tombstone 对 Runtime/应用索引中的会话补做永久删除，再进行恢复协调，处理跨文件/数据库删除中断；这不是跨数据库原子事务。
- 会话正文查询仍由 Runtime 提供；应用索引中的运行结果是可重建的派生记录。Desktop 审批仍使用 Host 适配器，本阶段未把运行前审批或 UI 会话标题改接持久化应用模型。
- 新测试覆盖 v2→v3 保留数据、删除级联、多连接与重开防复活、保留待续跑 ownership，以及未提交运行的中断。Electron 恢复测试检查原 runId 的应用终态，删除测试检查索引结果清理与永久标记。

本阶段验证：全量回归 196 个文件通过、1 个跳过，1195 个测试通过、2 个跳过；Electron 完整回归 20 项通过。随后新增文件 tombstone 已提交、数据库未清理的中断删除测试，连同旧会话迁移定向 E2E 共 2 项通过，验证启动补偿清理。构建、typecheck、lint、architecture、docs:check 与 diff 空白检查通过。

## 核心 Product Composition

- `runtime-composition` 新增 `createProductRuntime`，统一创建 Runtime、执行 Host 修复回调、按明确策略恢复对账、装配 JojoAppService，并提供关闭入口。Desktop 与 Headless Server 均接入该工厂，底层 `createJojoRuntime` 保留供独立 Runtime 使用。
- Desktop 显式选择 preserve 策略，在恢复前处理文件 tombstone；Server 显式选择 interrupt 策略。恢复对账完成后才向 Host 返回 Runtime 和 App Service。
- 组合层管理应用状态存储生命周期，初始化失败时尝试清理已创建 Runtime 与状态存储并保留原始错误。四项测试覆盖两种 Host 的共享应用用例、重复关闭，以及 capability 初始化/Host 修复失败的资源释放。
- `runtime-composition → app-service` 是新的生产依赖，包图检查通过。Browser、Secret、Channel/Scheduler/Memory 等 Feature 的配置与部分装配仍在 Host；本阶段统一核心生命周期，不宣称完整 Feature Composition 和跨 Host conformance 已完成。

本阶段验证：全量回归 197 个文件通过、1 个跳过，1199 个测试通过、2 个跳过；Electron 完整回归 21 项通过。恢复失败资源清理测试发现并修复 Server 外层重复关闭状态存储，相关 9 项定向测试和修复后的全量回归均通过。构建、typecheck、lint、architecture、docs:check 与 diff 空白检查通过。

## 跨 Host 应用契约测试基础

- 提取可复用的 `describeApplicationHostContract`，对 Desktop 的共享 Product 入口与实际 `createHeadlessServer` 入口运行相同断言。两端均使用 SQLite Runtime 与应用索引；Server 在打开持久化存储前获取目录所有权。
- 八项测试覆盖会话元数据与完成结果跨重启保留、Transcript 分页无重复、过期 revision 拒绝更新、实际运行中的 Provider 取消并持久化终态、权限 deny 不执行工具。测试使用 Scripted Provider 和本地临时目录，无真实 API Key 或公网依赖。
- 新增 `pnpm test:conformance`，组合跨 Host 八项用例与现有十二项 Operation/Transport 校验用例。文件符合现有 Vitest 收集规则，CI 的 `pnpm test` 自动包含，无需重复增加 CI 执行步骤。
- Desktop 测试在普通 Node 中验证实际共享 Product 及持久化适配，不等于 Electron IPC/Renderer 端到端测试。审批、Scheduler、删除及运行中崩溃的完整跨 Host 契约仍待扩展；已有 Electron 和恢复专项测试继续独立承担对应验证。

本阶段验证：`pnpm test:conformance` 20 项通过；typecheck、lint、7 项架构 Guard fixture、仓库架构检查、docs:check 与 diff 空白检查通过。本轮只增加测试及命令，没有修改生产执行逻辑，未重复运行全量与 Electron；上阶段全量和 Electron 结果见上文。

## 跨 Host Scheduler Agent 契约

- 共享测试夹具接入实际 Desktop Scheduler 装配入口与 Headless Server 内置 Scheduler，两端使用各自持久化 Schedule Store；同时保留原有会话/运行契约测试。
- 新增四项用例：两端分别验证 Agent 定时任务完成及取消，核对专用 lane、原 executionId、scheduler trigger、应用终态，以及重启后 Scheduler/应用索引的终态一致且 Provider 不重复执行。
- Desktop 的 Team/Workflow dispatcher 依赖收窄为实际使用的 manager 方法，运行逻辑不变。测试夹具对非 Agent Target 注入明确报错的适配器，不把它们计入通过范围；Desktop 环境准备使用已绑定的测试 Provider，不覆盖真实 Worker 的工具/密钥装配。
- 本轮没有覆盖定时触发时钟、投递副作用、运行中进程崩溃或审批恢复；已有对应专项测试继续保留，不能以这里的普通重启断言替代崩溃验证。

本阶段验证：`pnpm test:conformance` 24 项通过（12 项跨 Host、12 项 Operation/Transport）；typecheck、lint、architecture、docs:check 与 diff 空白检查通过。生产变更仅收窄 TypeScript 依赖接口，未重复执行全量和 Electron。

## 审批应用接口解耦

- 新增 `ApplicationApprovalBroker` 接口，统一 Runtime 请求与应用层列表、会话归属查询、决策、事件订阅和关闭时中断。`JojoAppServiceOptions` 接受该接口，不再要求具体的 `ServerApprovalBroker`；需要应用审批表的适配器可在接入时绑定存储。
- `getApprovalSessionId` 委托适配器查询，避免应用层绕过 Host 的审批事实源。Server 实现仍从持久化审批记录查询，因此审批结束、Broker 重建后，已有权限检查与幂等决策仍能获取会话归属。
- 新增独立 Host 适配器测试，覆盖应用审批表没有对应记录时的归属查询、缺失错误、会话过滤、快照、决策主体传递、事件转发及关闭；新增 Server 审批结束后重建 Broker 的归属回归。
- 本阶段只完成接口边界。Desktop Worker 尚未实现该接口：运行前 Hook 授权没有 `runId`，现有 `PendingApprovalSnapshot` 要求运行归属；需先明确运行前审批契约，并保留 Desktop 授权范围、Channel 决策与失效通知语义，不能伪造运行 ID 直接接入。

验证：app-service 与 Product Composition 定向测试 27 项通过；Server Core、HTTP、跨 Host 与 Transport conformance 回归 43 项通过；typecheck、lint、7 个架构 fixture、仓库架构检查、docs:check 与 diff 检查通过。本阶段未重跑全量测试及 Electron E2E。


## Desktop 审批接入应用服务

- 新增 `DesktopApprovalBroker`，同时服务 Runtime 和 `JojoAppService`。运行中审批保留真实 session/lane/run 归属；运行前 Hook 授权使用显式 `scope: session` 快照，不伪造运行 ID。共享 Schema 保留原运行级快照格式，并拒绝混合两类归属。
- Desktop Product 注入同一个 Broker，UI 和 Channel 决策通过 `JojoAppService.resolveApproval`；UI 继续按原有 Permission Grant Store 规则处理类似请求、本次对话及锁定权限，Channel 仍只允许单次决策。Channel 回调改为等待应用决策，异步返回未找到不会被当作成功。
- 会话停止、取消、Worker 关闭和 AbortSignal 都清理对应等待；审批事件驱动 Channel 发布与失效通知。监听器异常隔离，快照复制防止外部修改，延迟 Abort 不会清除后来复用相同 ID 的审批。
- Server Channel Bridge 只发布带运行归属的审批；Desktop 专用 Bridge 按活动会话路由运行前授权。本轮未将两套 Channel Bridge 合并。
- Desktop 待审批状态仍保存在 Worker 内存，续跑时重新请求授权；没有接入 Server 的审批持久化表。已结束审批的查询、重复决策及进程崩溃恢复策略仍有 Host 差异，后续需继续统一；不代表整份架构方案完成。

验证：全量回归 199 个文件通过、1 个跳过，1216 项测试通过、2 项跳过；完整 Electron E2E 21 项通过（含允许写入、拒绝无副作用及权限设置）；随后补充异步 Channel 决策失败断言，该文件 3 项通过。typecheck、lint、7 个架构 fixture、仓库架构检查、docs:check、Electron 构建及 diff 检查通过。运行前 Hook 的新归属契约由单元测试覆盖，尚未新增专门的 Hook Electron 场景。

## 审批跨 Host 与崩溃恢复验证

- 修正跨 Host 测试工厂：Desktop Product 现在注入真实 `DesktopApprovalBroker`，此前该工厂使用默认 Server Broker，无法证明 Desktop 审批接入行为。
- 共享审批契约增加允许、拒绝、取消与等待期间正常重启四种场景，两端共新增 8 项测试。验证未决审批查询、真实运行归属、会话过滤、允许只执行一次、拒绝无工具副作用、取消/关闭后不再接受旧审批，以及应用运行终态。
- Electron 新增待审批时 SIGKILL 的允许/拒绝两条恢复路径。保留原 run/tool call/input，但 Runtime 续跑会重新检查权限并生成新的审批 ID；测试确认旧 ID 的允许操作不能绕过新审批，重新允许后写入成功，拒绝后文件不存在，原应用运行索引最终完成。
- 最初测试假定恢复沿用审批 ID，被实际运行与 Runner 的权限重检逻辑否定，已修正为新 ID 契约。Runtime SQLite 中的 operation 是恢复依据，不能把旧审批记录直接当作续跑授权；本阶段未新增审批数据库或更改生产恢复策略。审批终态审计与统一持久化接口仍待实现。

验证：`pnpm test:conformance` 32 项通过；Electron execution-recovery 3 项通过（包括原有 model_pending 恢复）；typecheck、lint、7 个架构 fixture、仓库架构检查、docs:check 与 diff 检查通过。本阶段仅调整测试与记录，未重复全量回归及完整 Electron 套件。

## 会话级审批持久化与 v4 迁移

- `ApprovalOwnership` 将持久化审批区分为运行级和会话级。运行级继续要求有效且一致的 Session/Run/Lane；会话级不创建虚假 Run，数据库约束要求 Run/Lane 为空。
- 共享持久化 Broker 新增 `requestSessionApproval`，复用先落库再发布、先提交决策再解除等待的流程。决策、处理人及终态可在重建 Broker 后读取，同决定重试保持幂等，冲突决定拒绝；工具输入与预览 patch 不写入审批记录。
- 应用状态 schema 从 3 升到 4；事务内重建旧审批表、复制已有记录与终态，再更新版本。新增真实 v3 迁移与损坏外键回滚测试，验证失败时旧审批表、记录和版本均保留。两类审批随会话永久删除清理。
- 内存与 SQLite 存储同时校验审批 ID 重试的 Session/Run/Lane/scope，避免同 hash 跨归属复用；SQLite 增加与内存一致的运行归属检查。Compatibility Manifest 和生成文档同步更新。
- 本轮实现统一持久化接口和 Broker 能力，尚未替换 Desktop 的内存 Broker。Team/Workflow 后台运行尚不保证存在应用运行索引，需要先统一其归属，再全量接入持久化审批；不通过放宽 Run 外键或创建虚假 Run 绕过此边界。

验证：全量回归 199 个文件通过、1 个跳过，1227 项通过、2 项跳过；完整 Electron E2E 23 项通过。随后新增损坏外键迁移回滚用例，存储专项 8 项通过。typecheck、lint、架构检查、docs:check、Electron 构建和 diff 检查通过。


## Desktop 编排 Agent 运行索引收口

- Desktop 共用的 Orchestrated Agent Runner 接入 `JojoAppService.startRunHandle`，覆盖 Team 成员、Workflow Agent 步骤和子代理。真实 Runtime Session/Lane 创建后，应用层先建立 Session 与 Run 索引，再开始执行，返回时已保存终态。
- `StartRunOptions` 增加内部 Team/Workflow 上下文透传，保留成员、任务、Workflow、步骤身份；Runtime trigger 与应用运行 origin 都记录实际编排种类，不统一归为 API 请求。预算、指令、取消信号和环境绑定继续沿原路径传递。
- Runner 支持显式注入应用服务；Desktop Worker 已注入同一 Product 的服务。独立 Runner 的兼容模式保留直接 Runtime 执行。
- 新测试覆盖三类 Actor 的应用索引、真实运行归属、Runtime 上下文、审批记录引用及完成后的环境清理；失败路径确认应用终态和绑定释放。
- 本阶段统一的是 Agent 执行入口，未重写编排状态机。Workflow 的直接工具步骤没有 Agent Run，仍使用原工具审计。Desktop 审批 Broker 尚待切换为持久化实现；现在三类后台 Agent 已具备真实应用 Run 索引，不必为审批伪造 Run。

验证：全量回归 199 个文件通过、1 个跳过，1232 项通过、2 项跳过；随后补充应用 origin 分类，app-service 与编排定向测试 31 项通过，typecheck 和 Electron 构建通过。lint、架构、docs:check 与 diff 检查通过。
最终构建上的完整 Electron E2E 23 项通过。


## Desktop 持久化审批切换

- Desktop Broker 删除独立的内存审批状态机，继承共享持久化实现并绑定 `runtime/application.sqlite`。Host 薄适配只负责运行前授权所需的 Session 元数据准备；运行级审批引用已有应用 Run，保留外键约束。
- 共享 Broker 增加 pending 快照查询与按会话中断；取消、关闭与 Abort 在持久化中断后结算等待并发布事件。结算前检查当前 pending 身份，避免并发完成重复发布；事件快照复制，观察者不能改写其他观察者的数据。
- Desktop UI 与 Channel 继续通过 App Service 决策。类似请求/对话范围授权移至决定提交成功后更新；数据库失败不会提前授予后续范围权限。会话停止等待审批中断提交，普通取消路径捕获并报告存储失败。
- 重建 Broker 后仍可查询审批会话归属；相同决定幂等重试、相反决定拒绝，已中断审批不能重新允许或以同 ID 重新发布。Desktop 重启对账将旧 pending 记录中断，Runtime 续跑产生新的请求 ID。
- 新增/调整测试覆盖运行前与运行级归属、取消隔离、终态审计、重复决定与旧 ID 拒绝。Electron 崩溃恢复测试直接检查 SQLite：旧审批 interrupted，新审批 pending 且属于原 Run，最终决定及处理人成功保存。

验证：全量回归 199 个文件通过、1 个跳过，1232 项通过、2 项跳过；typecheck、lint、架构、docs:check、Electron 构建与 diff 检查通过。完整 Electron E2E 23 项通过，包含崩溃后旧审批中断、新审批落库及允许/拒绝副作用断言。


## Desktop 会话标题事实源切换

- 新增 `DesktopSessionMetadataStore` 供 Main 与 Worker 共用，继承 JSONL 兼容能力并将标题查询、改名和新建会话标题接到应用 SQLite。手动改名与自动命名不再追加 JSONL title 记录，应用服务修改标题后 Desktop 直接读取同一记录。
- 应用状态 schema 升至 5，增加按 Session 级联删除的元数据导入标记。旧标题与标记在同一事务内导入，既有应用标题优先；完成导入后清空标题或修改旧 JSONL 都不会重新覆盖应用值。
- 首次导入保留旧会话时间；在线改名使用应用元数据更新时间。删除 tombstone 与应用数据库永久删除约束继续阻止恢复已删除 Session。
- 项目目录、项目绑定仍由 JSONL 兼容层维护；此阶段只切换标题事实源，Main 通过存储适配器访问元数据，尚未把全部元数据操作迁入 Worker 应用服务。
- 新增单元测试覆盖 Main/Worker/应用层共享标题、JSONL 不再写入、清空不重导入、已有标题优先和删除保护；新增 Electron 重启场景验证过时 JSONL 标题无法覆盖 SQLite。

验证：全量回归 200 个文件通过、1 个跳过，1234 项通过、2 项跳过；完整 Electron E2E 24 项通过，包含新标题迁移与重启场景；typecheck、lint、架构、docs:check、构建及 diff 检查通过。


## Desktop 项目元数据事实源切换

- 应用状态 schema 升至 6，增加按 Session 级联删除的项目元数据表，保存 workingDirectory、projectBound 和 ProjectIdentity。旧项目元数据仅在首次缺少记录时导入，后续读取不会覆盖新绑定。
- Main 的绑定操作改为写应用 SQLite，不再追加 JSONL project 记录；Worker 的普通读取与首次旧正文迁移都合并数据库中的最新项目元数据，避免首次运行使用过时目录。
- 项目数据通过共享 SessionMeta 的子 Schema 验证，保留未绑定状态与可选项目身份。应用标题清空后 Desktop 返回默认标题，满足非空 SessionMeta 契约，不恢复旧标题。
- 新增单元测试覆盖跨适配器读取、项目绑定不双写 JSONL、首次正文迁移读取新目录、重建适配器及永久删除保护；新增 Electron 首次运行与重启验证。
- 本阶段未删除全部 JSONL：会话发现、新建兼容记录、旧正文导入和文件删除屏障仍使用它。Main 仍通过存储适配器处理元数据，尚未将所有操作迁入 Worker 的 App Service。

Electron 首轮验证发现空会话在浏览历史时提前创建 Runtime Session，导致之后绑定项目仍沿用通用目录。已将无正文且尚无 Runtime Session 的查看路径改为延迟创建，执行、Channel、Scheduler 与投递路径仍显式准备 Runtime；并发准备等待结束后重新检查执行所需状态。此调整保留已有 Runtime Session 的执行域与恢复约束，不改写已存在操作的执行快照。
同时修复删除与启动的竞态：会话进入停止/删除流程后，如果仍处于环境准备阶段，禁止再注册控制器并启动运行，避免删除等待一个未收到取消信号的慢任务。已有“运行中删除且并发发送”Electron 场景承担此回归。

验证：全量回归 200 个文件通过、1 个跳过，1235 项通过、2 项跳过；随后增加启动前停止检查，最终构建的完整 Electron E2E 25 项通过，包含项目目录首次执行、重启保留及删除并发场景；typecheck、lint、架构、docs:check、构建和 diff 检查通过。


## Desktop 会话发现读取切换

- SQLite 适配器新增完整 Desktop 元数据查询和列表，合并应用 Session 与项目元数据；排序使用应用更新时间。
- Desktop 单条读取优先数据库，缺少记录时才尝试旧 JSONL 导入；列表每个适配器实例首次扫描旧文件以兼容未导入会话，随后从 SQLite 返回结果。Main 能发现 Worker 新增的已持久化会话，无需重新扫描文件。
- 已完成导入的会话不再依赖 JSONL 文件存在即可列出、读取、改名；文件 tombstone 继续过滤尚未完成数据库清理的删除，数据库永久删除冲突也不会使旧文件复活。
- 单元测试覆盖文件移走后的列表和改名、不同适配器新增会话可见、删除过程中旧数据库记录不可见，以及恢复旧文件后仍不显示。新增 Electron 场景覆盖正文已迁移后移走 JSONL、重启列出会话、打开原正文与改名。
- 本阶段没有主动删除用户旧文件，也没有取消新建时的 JSONL 兼容记录。旧正文未完成迁移时仍要求原文件，不能用空正文掩盖缺失源数据。

验证：全量回归 200 个文件通过、1 个跳过，1236 项通过、2 项跳过；完整 Electron E2E 26 项通过，包含旧 JSONL 缺失后的重启、会话发现、打开正文与改名；typecheck、lint、架构、docs:check、构建及 diff 检查通过。


## Desktop 元数据应用入口与 Main/Worker 拆分

- 新增中立 `SessionMetadataService` 和严格元数据操作/结果 Schema，统一列表、读取、创建、改名、项目绑定与删除。应用服务负责默认工作目录、项目解析、列表标题派生、删除并发屏障及持久化清理顺序；存储端保留既有 SQLite 权威源和 JSONL 兼容迁移。
- Main 不再构造元数据存储，也不再直接删除应用 SQLite；通过 `SessionMetadataClient` 关联请求与响应，处理发送失败、超时、无效响应、退出和重启。Worker 内部在线元数据操作使用同一服务。
- 删除先停止会话任务，再写文件 tombstone、清理 Runtime 和应用索引；重复删除合并，删除期间的改名/绑定被拒绝，停止失败可重试。Main 保留 renderer 来源校验及会话生命周期屏障。
- Main 入口仅启动 Host；bootstrap 装配窗口、Worker 与功能模块。IPC 拆分为 session、transcript、execution、settings、attachments、extensions、memory、browser、channel、scheduler、team、secrets、MCP、hooks；密钥持久化独立为 secrets adapter。
- Worker 入口仅启动 Host；bootstrap 负责环境与服务装配，`ipc-controller` 处理协议校验和分发，`session-controller` 承接元数据应用操作，`turn-controller` 管理会话准备、执行与停止；E2E provider 也已独立。保留原有 renderer IPC 名称及安全校验。
- 新增 9 项服务/客户端测试，覆盖默认目录、项目校验、删除顺序与竞争、停止失败重试、请求关联、超时、无效回复及 Worker 重启。

本阶段验证：typecheck、lint、架构检查（7 个 fixture）、docs:check、diff 检查及 Electron 构建通过；完整回归 202 个文件通过、1 个跳过，1245 项测试通过、2 项跳过；Electron 26 项全部通过。最后加强的删除/绑定竞争用例及客户端定向回归共 9 项通过。

## 跨 Host 验证与发布候选流程

- 共享应用契约新增 Provider 失败/重启后重新运行、重复 Run ID 防重复执行、跨 Session 查询/取消隔离，以及 Channel/Workflow/Subagent/Team 触发来源的持久化验证。分别在 Desktop Product 与真实 Headless Host 上执行，读取重启后的持久化应用索引核对来源。
- 新增 Release candidates 工作流：版本 Gate、完整回归、Linux x64 / Windows x64 / macOS arm64 原生 make、跨 Host 契约、可选手动签名与标签强制签名、macOS codesign/spctl/stapler、Windows Authenticode、Syft SPDX 2.3、产物 SHA-256/commit/兼容格式清单。CI 也运行发布脚本测试。
- Forge 接入签名/公证环境参数，补全 Windows/Debian 安装包必需的名称和描述、Debian 可执行文件路径。凭据缺失时签名构建直接失败。
- artifacts.mjs 生成并复核完整候选目录，拒绝篡改、缺失、多余文件、路径越界和覆盖已有目录。snapshot.mjs 提供离线备份、验证和恢复到新目录，逐文件流式 hash 验证，不覆盖当前用户数据。
- [发布与回滚操作手册](release-runbook.md) 明确凭据、干净系统安装、N-1 升级、草稿资产复验和回滚流程。当前自动化止于 Actions 候选产物，实际签名及三平台安装验收未在本机完成，源码/锁文件 SBOM 不等同于全量二进制 SBOM。

本轮验证：跨 Host/Transport 契约 44 项通过；完整回归 1257 项通过、2 项跳过（202 个文件通过、1 个跳过）；发布脚本 4 项通过；本机 macOS arm64 未签名 Forge ZIP make 成功。typecheck、lint、架构检查、docs:check、工作流 YAML 解析及 diff 检查通过。三平台 Actions 工作流、凭据签名、公证与真实 N-1 安装升级尚未远程执行。

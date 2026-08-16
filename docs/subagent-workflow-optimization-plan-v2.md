# Jojo Agent 子 Agent 与 Workflow 后续优化方案

> 文档日期：2026-08-16  
> 适用仓库：`zxt6991-source/jojo-agent`  
> 基线分支：`main`  
> 目标：在现有只读 SubAgent 基础上，逐步补齐 Workflow、可恢复执行、自定义 Agent、隔离写入与可视化编排能力，同时保持 Jojo 当前“强约束、可审计、桌面优先”的产品方向。

---

## 1. 当前状态判断

Jojo 当前已经完成了第一版子 Agent 基础设施：

- `packages/orchestration/src/subagent/manager.ts`
- `packages/orchestration/src/subagent/scheduler.ts`
- `packages/orchestration/src/subagent/tools.ts`
- `packages/orchestration/src/subagent/types.ts`
- `AgentExecutionScheduler`
- `SubAgentManager`
- `sub_agent_start`
- `sub_agent_wait`
- `sub_agent_status`
- `sub_agent_cancel`
- 独立 Context
- 独立 Usage
- Abort / Timeout
- 单层递归限制
- `explore` 只读 Profile
- Orchestration Event 通道

当前 Workflow 已经具备数据模型基础：

- `WorkflowDefinition`
- `WorkflowStep`
- `WorkflowStepState`
- `WorkflowRunState`
- DAG 环检测
- `dependsOn`
- `continueOnError`
- `timeoutMs`
- `maxConcurrency`
- `outputStepId`

但尚缺完整执行链路：

```text
WorkflowDefinition
        │
        ▼
WorkflowManager
        │
        ▼
WorkflowEngine
        │
        ├── DAG Scheduler
        ├── Prompt Builder
        ├── Step Executor
        ├── Persistence
        └── Resume
```

因此下一阶段的重点不应该继续扩展大量外围功能，而应优先把 **Workflow Runtime 做完整**。

---

# 2. 总体演进目标

建议最终形成如下结构：

```text
Main Agent
    │
    ├── Normal Tools
    │
    ├── SubAgent Tools
    │      ├── start
    │      ├── wait
    │      ├── status
    │      ├── send
    │      └── cancel
    │
    └── Workflow Tools
           ├── start
           ├── wait
           ├── status
           ├── cancel
           ├── resume
           └── save/load
                    │
                    ▼
              WorkflowManager
                    │
                    ▼
               WorkflowEngine
                    │
              DAG Scheduler
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Agent A    Agent B    Agent C
          └─────────┼─────────┘
                    ▼
                Synthesis
```

长期定位建议：

> Jojo 不必复制 Octo 的 Ruby Workflow，而应继续发展成一个 **声明式 DAG + 桌面可视化 + 强安全边界 + 可恢复执行** 的 Agent Workflow Runtime。

---

# 3. 优先级总览

| 优先级 | 能力 | 建议阶段 |
|---|---|---|
| P0 | WorkflowEngine | Phase 5.1 |
| P0 | WorkflowManager | Phase 5.1 |
| P0 | DAG 调度 | Phase 5.1 |
| P0 | Workflow Tool | Phase 5.1 |
| P0 | Workflow UI | Phase 5.2 |
| P1 | Workflow 持久化 | Phase 5.3 |
| P1 | Resume / Journal | Phase 5.3 |
| P1 | 自定义 Agent Profile | Phase 5.4 |
| P1 | `sub_agent_send` | Phase 5.4 |
| P1 | 子 Agent 模型覆盖 | Phase 5.4 |
| P2 | Worktree 隔离 | Phase 5.5 |
| P2 | 可写 SubAgent | Phase 5.5 |
| P2 | Workflow 模板保存 | Phase 5.6 |
| P2 | 可视化 Workflow Builder | Phase 6 |
| P3 | 条件节点 / Map 节点 | Phase 6 |
| P3 | 分布式执行 | 后续 |

---

# 4. Phase 5.1：首先补齐 Workflow Runtime

这是当前最高优先级。

建议新增：

```text
packages/orchestration/src/workflow/
├── engine.ts
├── manager.ts
├── scheduler.ts
├── tools.ts
├── prompt-builder.ts
├── validation.ts
└── types.ts
```

## 4.1 WorkflowEngine

职责只负责：

> 给定一个已经验证过的 WorkflowDefinition，执行 DAG。

建议接口：

```ts
export interface WorkflowEngine {
  run(
    request: WorkflowExecutionRequest,
    signal: AbortSignal,
    onEvent: (event: OrchestrationEvent) => void
  ): Promise<WorkflowExecutionResult>;
}
```

不要让 `WorkflowEngine` 负责：

- JSON 文件读取；
- Electron IPC；
- Session Storage；
- UI 状态；
- Provider 配置读取。

这些应该通过接口注入。

---

## 4.2 Workflow DAG 调度

建议采用确定性 DAG 调度。

状态：

```text
pending
   │
   ├── dependencies completed
   ▼
queued
   │
   ▼
running
   │
   ├── completed
   ├── failed
   ├── timed_out
   └── cancelled
```

依赖失败时：

```text
A failed
 │
 └── B dependsOn A
       │
       └── blocked
```

基础调度伪代码：

```ts
while (hasUnfinishedSteps()) {
  throwIfAborted(signal);

  markBlockedSteps();

  const ready = getReadySteps();

  while (
    ready.length > 0 &&
    running.size < definition.maxConcurrency
  ) {
    startStep(ready.shift()!);
  }

  if (running.size === 0) {
    break;
  }

  await Promise.race(running.values());
}
```

必须保证：

```text
实际并发 =
min(
  workflow.maxConcurrency,
  globalAgentScheduler.maxConcurrent
)
```

不要为 Workflow 新建另一套独立模型并发池。

继续共用：

```ts
AgentExecutionScheduler
```

这样手动 SubAgent 和 Workflow Agent Step 才不会一起把 Provider 打爆。

---

# 5. Phase 5.1：Workflow Step 第一版只支持 Agent Step

不要第一版就设计几十种 Step。

推荐只支持：

```ts
type WorkflowStep =
  | WorkflowAgentStep;
```

即：

```yaml
steps:
  - id: inspect-agent-core
    type: agent
    profile: explore
    task: 分析 packages/agent-core

  - id: inspect-storage
    type: agent
    profile: explore
    task: 分析 packages/storage

  - id: summary
    type: agent
    profile: synthesize
    dependsOn:
      - inspect-agent-core
      - inspect-storage
    task: 汇总两个模块之间的关系
```

这已经能够表达大量真实场景：

```text
并行代码分析
并行 PR Review
模块架构分析
测试结果汇总
多来源调研
安全审查
性能审查
最终总结
```

不要急着支持：

```text
if
while
foreach
JavaScript
eval
shell step
browser step
MCP step
```

这些可以后面再扩展。

---

# 6. Phase 5.1：完善 synthesize Profile

当前 Contract 已经预留：

```ts
'explore' | 'synthesize'
```

但模型可直接启动的 SubAgent 第一版只允许 `explore`。

建议保持这一点。

`synthesize` 不应该暴露给普通：

```text
sub_agent_start
```

而应该只给 Workflow Engine 内部使用。

建议工具：

```text
synthesize
    Tools = []
```

系统提示：

```text
You are a synthesis agent.

Only use the dependency results supplied in the prompt.

Do not invent evidence.
Do not perform external search.
Clearly distinguish:
- consensus
- conflicts
- incomplete inputs
- failed upstream steps
```

这样可以保证最终汇总节点是确定性的。

---

# 7. Phase 5.1：依赖结果注入必须限流

假设：

```text
Agent A 输出 50 KB
Agent B 输出 80 KB
Agent C 输出 60 KB
```

直接全部塞给 summary，会浪费大量 Context。

建议：

```text
单 Step 最终结果最大：16 KB
单依赖注入最大：12 KB
总依赖注入最大：48 KB
```

超过：

```text
[Dependency output truncated]
```

Prompt：

```text
Task:
分析整体架构风险。

Dependency Results:

=== inspect-agent-core ===
...

=== inspect-storage ===
...

=== inspect-desktop ===
...
```

不要使用隐式字符串拼接。

建议新建：

```text
workflow/prompt-builder.ts
```

---

# 8. Phase 5.1：Workflow Tool API

建议提供：

```text
workflow_start
workflow_wait
workflow_status
workflow_cancel
```

第一版不要马上做 `resume`。

## workflow_start

输入：

```json
{
  "definition": {
    "schemaVersion": 1,
    "name": "analyze-project",
    "maxConcurrency": 3,
    "steps": []
  }
}
```

返回：

```json
{
  "id": "wf_xxx",
  "state": "running"
}
```

立即返回。

---

## workflow_wait

```json
{
  "id": "wf_xxx",
  "timeoutMs": 60000
}
```

---

## workflow_status

```json
{
  "id": "wf_xxx"
}
```

---

## workflow_cancel

取消必须向下传播：

```text
Workflow AbortController
     │
     ├── Step A AbortController
     ├── Step B AbortController
     └── Step C AbortController
```

禁止只把 Workflow 状态改为：

```text
cancelled
```

而后台 Agent 仍在跑。

---

# 9. Phase 5.2：补齐 Workflow UI

当前 Orchestration Event 通道已经存在，因此 UI 很适合继续扩展。

推荐新增：

```text
WorkflowCard
```

而不是把 Workflow 当普通 Tool 行显示。

示例：

```text
分析项目架构

● Running

✓ agent-core        12.4s
✓ storage            8.2s
● desktop            5.1s
○ summary

2 / 4 completed
```

失败时：

```text
✗ storage

Error:
web_fetch timeout
```

blocked：

```text
○ summary
Blocked by: storage
```

建议支持：

- 展开/收起；
- 每 Step 状态；
- 每 Step Usage；
- Step 输出；
- Step Error；
- Workflow 总 Usage；
- Cancel；
- Resume（后续）。

---

# 10. Phase 5.3：Workflow 持久化与 Journal

这是第二个非常值得借鉴 Octo 的能力。

不要只在内存保存 Workflow。

建议：

```text
data/
  workflows/
    runs/
      wf_xxx.json
    journals/
      wf_xxx.jsonl
```

## Journal 建议格式

```json
{
  "type": "workflow.started",
  "runId": "wf_xxx",
  "createdAt": "..."
}
```

```json
{
  "type": "step.started",
  "runId": "wf_xxx",
  "stepId": "inspect-core",
  "attempt": 1
}
```

```json
{
  "type": "step.completed",
  "runId": "wf_xxx",
  "stepId": "inspect-core",
  "output": "...",
  "usage": {}
}
```

```json
{
  "type": "workflow.completed",
  "runId": "wf_xxx"
}
```

必须采用 append-only。

原因：

- 崩溃恢复简单；
- 不容易损坏整个运行记录；
- 便于审计；
- 和现有 JSONL Session Storage 风格一致。

---

# 11. Phase 5.3：实现 Resume

建议：

```text
workflow_resume
```

恢复条件：

```text
definitionHash 一致
workspace 一致
provider/model 配置兼容
```

恢复算法：

```text
读取 Journal
   │
   ├── completed Step → replay
   ├── failed Step → 根据策略重新执行
   ├── interrupted Step → 重新执行
   └── pending Step → 正常调度
```

不要恢复正在执行中的 LLM Stream。

崩溃前正在运行的 Step 应恢复为：

```text
interrupted
```

然后重新执行。

建议记录：

```ts
definitionHash
workspaceFingerprint
providerId
model
```

避免拿错误 Workflow 续跑。

---

# 12. Phase 5.4：自定义 SubAgent Profile

这一块非常值得借鉴 Octo。

建议支持：

```text
~/.jojo/agents/
项目/.jojo/agents/
```

例如：

```text
security-review.md
```

```yaml
---
description: Security-oriented source code reviewer
readOnly: true
tools:
  - read_file
  - grep
  - glob
model: inherit
maxIterations: 10
---

重点检查：

- 命令注入
- 路径穿越
- SSRF
- 明文密钥
- 权限绕过
```

建议加载顺序：

```text
built-in
<
user
<
project
```

同名时项目级优先。

不要允许自定义 Agent 获得：

```text
sub_agent_*
workflow_*
```

防止递归。

---

# 13. Phase 5.4：支持单个 SubAgent 模型覆盖

当前子 Agent 继承父模型。

后续建议：

```json
{
  "task": "...",
  "profile": "explore",
  "model": "gpt-5-mini"
}
```

使用场景：

```text
主 Agent：高端模型
分析 Agent：便宜模型
最终 Synthesis：高端模型
```

典型：

```text
Main          GPT-5
├── Explore   GPT-5 mini
├── Explore   GPT-5 mini
├── Explore   GPT-5 mini
└── Summary   GPT-5
```

这样多 Agent 才有明显成本优势。

限制：

```text
只能选择当前 Provider 已配置模型
```

不要允许 Agent 自己填写任意 API Endpoint。

---

# 14. Phase 5.4：增加 sub_agent_send

当前：

```text
start
wait
status
cancel
```

下一步可以增加：

```text
sub_agent_send
```

用途：

```text
Agent A
   │
   ├── 第一次：分析 auth
   │
   └── 第二次：继续检查 jwt.go
```

而不是每次新建一个 Agent。

这要求保存 Child Context。

建议：

```ts
type LiveSubAgent = {
  ...
  context?: Message[];
}
```

但要控制：

```text
max retained messages
max context tokens
idle expiration
```

例如：

```text
最大保留：20 分钟
最大 Agent：16
最大 Context：64K Tokens
```

如果 Agent 已过期：

```text
subagent_expired
```

---

# 15. Phase 5.5：加入 Worktree Isolation

只有完成 Worktree Isolation 后，才建议开放可写 SubAgent。

不要让多个 Agent 直接操作同一个 Workspace。

建议：

```text
Main Workspace
    │
    ├── Worktree A
    ├── Worktree B
    └── Worktree C
```

Agent Request：

```ts
isolation?: 'none' | 'worktree'
```

创建：

```bash
git worktree add \
  -b jojo-agent/<run-id>/<step-id> \
  <temp-dir> \
  HEAD
```

执行完成：

### 无修改

```text
删除 worktree
删除 branch
```

### 有修改

```text
git add
git commit
保留 branch
返回：
- branch
- worktree
- diffstat
```

第一版不要自动 merge。

让主 Agent 或用户审查后决定。

---

# 16. Phase 5.5：开放 general Profile

只有 Worktree 完成后再支持：

```text
general
```

工具：

```text
read_file
list_files
grep
glob
write_file
edit_file
terminal
```

但建议仍然不默认支持：

```text
browser
MCP
sub_agent
workflow
```

Profile：

```text
explore   read-only
general   workspace-write
review    read-only
synthesize no tools
```

---

# 17. Phase 5.6：Workflow 保存与模板

建议：

```text
~/.jojo/workflows/
项目/.jojo/workflows/
```

格式直接使用 YAML：

```yaml
schemaVersion: 1
name: architecture-review
description: 分析项目架构

inputs:
  target:
    type: string
    required: true

steps:
  - id: explore
    type: agent
    profile: explore
    task: |
      分析 {{inputs.target}}

  - id: summary
    type: agent
    profile: synthesize
    dependsOn:
      - explore
    task: 总结结果
```

第一版模板变量只允许：

```text
{{inputs.xxx}}
```

不要开放任意表达式。

否则很快变成另一门脚本语言。

---

# 18. Phase 6：新增有限控制流，而不是完整脚本

DAG 第一版成熟以后，可以增加两类节点。

## Condition Step

```yaml
- id: check
  type: condition
  expression:
    step: test
    field: state
    equals: failed
```

不要允许：

```text
eval("...")
```

---

## Map Step

用于：

```text
遍历文件列表
遍历模块
遍历 Issue
```

例如：

```yaml
- id: review-files
  type: map
  source:
    step: discover-files
  itemLimit: 20
  agent:
    profile: explore
    task: 审查文件 {{item}}
```

内部仍然展开成 DAG Step。

这样保持：

```text
可观察
可限流
可恢复
可审计
```

---

# 19. Usage 与成本统计建议

当前 SubAgent 已有独立 Usage，这个方向应该继续坚持。

推荐：

```text
Session Usage
├── Parent
├── Manual SubAgents
└── Workflows
     ├── Step A
     ├── Step B
     └── Step C
```

计算：

```text
Session Total =
Parent Usage
+ Manual SubAgent Usage
+ Workflow Step Usage
```

UI 建议显示：

```text
Input       42,380
Output       7,920
Cache Read  18,400
```

未来可加入：

```text
estimatedCost
```

但成本表必须由 Provider 配置驱动，不要硬编码模型单价。

---

# 20. Timeout 分层

目前 SubAgent 已经有 Timeout。

Workflow 建议明确三层：

```text
Session Turn Timeout
       │
Workflow Timeout
       │
Step Timeout
```

例如：

```text
Workflow      10 min
Step          2 min
Provider call 60 sec
```

优先级：

```text
最早触发的 Abort 生效
```

并准确记录：

```text
stopReason:
- workflow_timeout
- step_timeout
- cancelled
- provider_timeout
```

不要全部显示：

```text
failed
```

---

# 21. 错误模型建议

建议统一错误代码。

SubAgent：

```text
subagent_not_found
subagent_limit_reached
subagent_timeout
subagent_cancelled
nested_subagent_forbidden
provider_unavailable
```

Workflow：

```text
workflow_invalid_definition
workflow_not_found
workflow_limit_reached
workflow_timeout
workflow_cancelled
workflow_resume_mismatch
workflow_step_failed
workflow_deadlock
```

UI 和 Agent 不要通过解析英文字符串判断错误。

推荐：

```ts
type OrchestrationError = {
  code: string;
  message: string;
  details?: unknown;
};
```

---

# 22. 事件系统优化

当前：

```text
subagent.changed
workflow.changed
workflow.log
```

方向正确。

建议补：

```text
workflow.step.started
workflow.step.completed
workflow.step.failed
```

或者继续只保留：

```text
workflow.changed
```

但内部 Snapshot 必须包含版本号：

```ts
revision: number
```

避免 Renderer 接收到乱序 Event 时覆盖新状态。

建议：

```text
revision++
```

Renderer：

```ts
if (incoming.revision <= current.revision) {
    ignore();
}
```

---

# 23. Orchestration 持久化与 Session 的关系

不建议把全部 Workflow 内部 Agent 消息写进父 Session。

父 Session 保持：

```text
User
Assistant
workflow_start
workflow_result
Assistant Summary
```

Workflow 内部细节：

```text
Workflow Journal
```

这样不会出现：

```text
父会话 20 条消息
+
Workflow 8 个 Agent × 30 条消息
=
260 条内部记录
```

最终 Context 会非常难管理。

---

# 24. 安全策略

Jojo 当前最大优势之一就是安全模型清晰。

这个优势不要因为追多 Agent 功能丢掉。

建议一直保持：

```text
Parent Agent
    │
    ├── Interactive Permission
    │
SubAgent
    │
    ├── NonInteractive Permission
    │
Workflow Agent
    │
    └── NonInteractive Permission
```

后台 Agent 不允许弹审批。

如果需要审批：

```text
返回 requires_parent_action
```

然后交给 Main Agent。

---

# 25. MCP / Browser 与 Workflow 的处理

第一版 Workflow 不建议直接支持：

```text
MCP Step
Browser Step
```

以后建议通过：

```text
Agent Step
   │
   └── Restricted Tool Set
```

例如：

```yaml
- id: lookup-github
  type: agent
  profile: general
  tools:
    - mcp__github__search
```

但必须等：

```text
工具权限元数据
副作用分类
Tool capability schema
```

成熟后再做。

---

# 26. Tool Capability 模型

长期建议为工具增加：

```ts
type ToolCapabilities = {
  readOnly: boolean;
  network: boolean;
  filesystem: boolean;
  process: boolean;
  browser: boolean;
  requiresApproval: boolean;
};
```

而不是靠：

```ts
tool.name.startsWith(...)
```

判断权限。

例如：

```ts
{
  name: 'grep',
  capabilities: {
    readOnly: true,
    filesystem: true,
    network: false,
    process: false,
    browser: false,
    requiresApproval: false
  }
}
```

这样自定义 Agent Profile 可以安全声明：

```text
readOnly = true
```

系统自动筛选工具。

---

# 27. 测试策略

## SubAgent

至少覆盖：

```text
3 个并行 Agent
超过并发进入队列
取消 queued
取消 running
timeout
provider error
maxIterations incomplete
父 Turn abort
Session cleanup
禁止递归
```

---

## Workflow

必须覆盖：

```text
A -> B -> C
A/B/C -> D
依赖失败 blocked
continueOnError
timeout
cancel
DAG cycle
重复 Step ID
不存在依赖
outputStepId
部分结果
全局 Scheduler 限流
```

---

## Resume

必须覆盖：

```text
执行 A 完成
执行 B 时进程崩溃
重新启动
A replay
B rerun
C 正常执行
```

还要测试：

```text
definition 修改后拒绝 resume
workspace 修改策略
journal 尾部半条 JSON
重复 event
```

---

# 28. 建议新增的 E2E 场景

## 场景一：项目分析

```text
用户：
分析这个项目的：
1. Agent Core
2. Storage
3. Browser
最后总结架构风险。
```

预期：

```text
3 个 SubAgent 并行
Summary Agent 汇总
```

---

## 场景二：Workflow

```yaml
A: agent-core
B: storage
C: desktop

D:
  dependsOn: [A, B, C]
```

验证：

```text
A/B/C 并行
D 必须等待全部完成
```

---

## 场景三：崩溃恢复

```text
A completed
B running
进程退出
```

重启：

```text
A replay
B interrupted -> rerun
```

---

## 场景四：并行修改

```text
Agent A 修改 foo.ts
Agent B 修改 bar.ts
```

验证：

```text
不同 Worktree
不同 Branch
主 Workspace 不变
```

---

# 29. 推荐代码目录最终结构

```text
packages/
  orchestration/
    src/
      subagent/
        manager.ts
        scheduler.ts
        tools.ts
        profiles.ts
        registry.ts
        types.ts

      workflow/
        engine.ts
        manager.ts
        scheduler.ts
        parser.ts
        validation.ts
        prompt-builder.ts
        journal.ts
        resume.ts
        tools.ts
        types.ts

      capabilities/
        tool-capabilities.ts

      abort.ts
      usage.ts
      permission-gate.ts
      index.ts
```

Desktop：

```text
apps/desktop/src/worker/
  orchestration-runtime.ts
  workflow-runtime.ts
```

Renderer：

```text
apps/desktop/src/renderer/
  orchestration/
    SubAgentCard.tsx
    WorkflowCard.tsx
    WorkflowStep.tsx
```

---

# 30. 推荐实施顺序

## 第一批

```text
1. WorkflowEngine
2. WorkflowManager
3. workflow_start/wait/status/cancel
4. Agent Step
5. DAG Scheduler
6. synthesize
```

目标：

> 先让 Workflow 真正跑起来。

---

## 第二批

```text
7. Workflow UI
8. Workflow Usage
9. Timeout / Error 完善
10. Journal
11. Resume
```

目标：

> 让 Workflow 可观察、可诊断、可恢复。

---

## 第三批

```text
12. Custom Agent Profile
13. model override
14. sub_agent_send
15. Profile Registry
```

目标：

> 把 SubAgent 从固定 explore 升级为可配置 Agent。

---

## 第四批

```text
16. Worktree
17. general Agent
18. 并行写入
19. Branch/Diff 审查
```

目标：

> 安全开放多 Agent 修改代码。

---

## 第五批

```text
20. Saved Workflow
21. Inputs
22. Workflow Templates
23. Condition
24. Map
```

目标：

> 从 Agent 功能升级为真正可复用的 Workflow 产品。

---

# 31. 不建议现在做的事情

当前阶段不建议：

### 1. 复制 Octo 的 Ruby Workflow

会显著增加：

```text
解释器
Sandbox
Fiber Scheduler
语言 Binding
脚本安全
Debug
Resume 映射
```

Jojo 当前没有这个必要。

---

### 2. 直接支持无限层 Agent

推荐继续保持：

```text
Main
 └── Child
```

不要：

```text
Main
 └── Child
      └── Grandchild
           └── ...
```

---

### 3. 立即允许多个 Agent 操作同一个工作区

没有 Worktree 前，坚持只读。

---

### 4. Workflow 直接执行 Shell

应该：

```text
Workflow
   │
   └── Agent Step
          │
          └── terminal
```

而不是：

```text
Workflow Shell Step
```

这样所有副作用仍经过 Agent Permission 模型。

---

### 5. 同时维护两套 Scheduler

统一：

```text
AgentExecutionScheduler
```

这一点当前设计已经很好，应该继续保持。

---

# 32. 与 Octo 的差异化方向

Octo 更适合：

```text
Programmable Agent Runtime
Ruby Workflow DSL
动态编排
复杂自动化
```

Jojo 更适合发展成：

```text
Desktop Agent
+
Declarative DAG
+
Visual Workflow
+
Strict Permission
+
Replay / Resume
+
Human Review
```

因此最终不要追求：

> 功能和 Octo 一模一样。

而应该形成：

```text
Octo
  灵活性优先

Jojo
  可控性
  可观察性
  可审计性
  桌面交互
  安全边界
  Workflow 可视化
```

---

# 33. 最终推荐路线

最推荐的主线：

```text
当前
│
├── SubAgent MVP ✅
│
▼
Workflow DAG Runtime
│
▼
Workflow UI
│
▼
Journal / Resume
│
▼
Custom Agent
│
▼
Persistent SubAgent / Send
│
▼
Worktree
│
▼
Writable Multi-Agent
│
▼
Saved Workflow
│
▼
Condition / Map
│
▼
Visual Workflow Builder
```

其中最重要的三个节点是：

```text
1. Workflow Engine
2. Journal / Resume
3. Worktree Isolation
```

这三项完成以后，Jojo 的多 Agent 能力会从：

```text
“可以并行分析”
```

升级到：

```text
“可以稳定、可恢复、可审计地执行复杂多 Agent 工程任务”
```

这比单纯增加更多 Agent Tool 更有价值。

---

# 34. 建议下一版本目标

> 实现状态更新（2026-08-16）：`[x]` 表示当前代码与自动化测试已验证完成；`[ ]` 表示尚未完成或仍缺少该条要求的专项验证。

建议下一个版本直接定义为：

```text
Phase 5.1
Workflow Runtime MVP
```

验收标准：

- [x] 可以通过 JSON/YAML 定义一个 Workflow；
- [x] 支持至少 32 个 Step；
- [x] 支持 `dependsOn`；
- [x] 支持 DAG 校验；
- [x] 支持三个并行 Agent；
- [x] 支持 `explore`；
- [x] 支持内部 `synthesize`；
- [x] 支持 Step Timeout；
- [x] 支持 Workflow Timeout；
- [x] 支持 Cancel；
- [x] 支持 `continueOnError`；
- [x] 支持 blocked 状态；
- [x] 支持 Usage 聚合；
- [x] 支持 `workflow_start`；
- [x] 支持 `workflow_wait`；
- [x] 支持 `workflow_status`；
- [x] 支持 `workflow_cancel`；
- [x] UI 可以查看每个 Step 状态；
- [x] Workflow 失败能准确指出具体 Step。

Phase 5.1 完成后，再进入：

```text
Phase 5.2
Workflow Persistence & Resume
```

而不是继续增加零散 Tool。


---

# 35. 逐步骤验收标准

本节对应第 30 节“推荐实施顺序”中的 **1～24 个实施步骤**。

统一验收原则：

```text
功能正确
+
异常可控
+
状态可观察
+
资源可回收
+
自动化测试覆盖
```

每项能力只有同时满足以下四类条件后才标记为“完成”：

- 功能验收：正常路径稳定工作；
- 边界验收：超时、取消、失败、非法输入均有明确行为；
- 可观察性验收：状态、错误、Usage、日志至少有一条稳定读取路径；
- 测试验收：核心行为有自动化测试，而不是只靠人工点测。

---

## 35.1 Step 1：WorkflowEngine

### 目标

实现 Workflow 核心执行器。

### 验收标准

- [x] 可接收已验证的 `WorkflowDefinition` 并启动完整运行；
- [x] Engine 不直接依赖 Electron Renderer、IPC 或具体 UI；
- [x] Agent Runner 通过依赖注入调用；
- [x] 支持传入 `AbortSignal`；
- [x] 父级 Abort 后不再启动新的 Step；
- [x] 已运行 Step 能收到取消信号；
- [x] 返回结构化 `WorkflowExecutionResult`（当前实现类型名为 `WorkflowRunSnapshot`）；
- [x] Result 至少包含 `runId/state/steps/startedAt/finishedAt/usage/incomplete`（当前字段名为 `id`）；
- [x] 单个 Step 抛异常不会导致进程级崩溃；
- [x] Workflow 完成、失败、取消后所有运行 Promise 可回收；
- [x] 无永久 pending Promise；
- [x] 有单 Step 成功、多 Step 成功、Runner 抛错、Abort 测试。

### 完成定义

`WorkflowEngine` 可以脱离 UI 独立通过测试运行。

---

## 35.2 Step 2：WorkflowManager

### 目标

管理 Workflow Run 生命周期。

### 验收标准

- [x] 创建唯一 `runId`；
- [x] `runId` 与 SubAgent ID 命名空间明确区分；
- [x] 支持 `start/get/list/wait/cancel/cancelSession`；
- [x] `start()` 不等待整个 Workflow 完成；
- [x] 同一 Session 可存在多个 Run；
- [x] 有最大 Workflow 数限制；
- [x] 超限返回 `workflow_limit_reached`；
- [x] 已完成 Run 有 retention 策略；
- [x] retention 超限能淘汰旧 Run；
- [x] cancel 不存在 ID 返回明确错误；
- [x] 重复 cancel 幂等；
- [x] terminal 状态至少包含 completed/failed/cancelled/timed_out/interrupted；
- [x] terminal Run 不会自动重新进入 running；仅 `interrupted/failed/timed_out/cancelled` 可通过显式 `workflow_resume` 进入新 attempt；
- [x] Manager 清理后不残留 AbortController；
- [x] 并发 start/get/cancel 有自动化测试。

---

## 35.3 Step 3：Workflow Tools

### 目标

实现 `workflow_start / workflow_wait / workflow_status / workflow_cancel`。

### workflow_start 验收

- [x] 接受合法 Workflow Definition；
- [x] 非法 Definition 在执行前拒绝；
- [x] 返回 `id` 和 `state`；
- [x] 正常情况立即返回；
- [x] 主 Agent 可读取返回值；
- [x] 错误使用结构化 Error Code。

### workflow_wait 验收

- [x] 可等待指定 Workflow；
- [x] 支持 `timeoutMs`；
- [x] wait 超时不等于取消 Workflow；
- [x] 父 Agent Abort 时 wait 可退出；
- [x] Workflow 已结束时立即返回。

### workflow_status 验收

- [x] 可获取 Run 总状态；
- [x] 可获取 Step 状态；
- [x] 可获取当前运行 Step；
- [x] 可获取 Usage；
- [x] 可获取 Error；
- [x] 不存在 ID 返回 `workflow_not_found`。

### workflow_cancel 验收

- [x] 可取消 queued/running Workflow；
- [x] Cancel 向所有运行 Step 传播；
- [x] Cancel 后不再启动新 Step；
- [x] 重复 cancel 不产生未处理异常。

### 完成定义

主 Agent 能完整执行：

```text
start → status → wait → cancel
```

---

## 35.4 Step 4：Agent Step

### 验收标准

- [x] `type: agent` 正确解析；
- [ ] `id/type/profile/task` 必填；
- [x] 空 `task` 被拒绝；
- [x] Profile 不存在时执行前失败；
- [x] 调用现有 Leaf Agent Runner；
- [x] Child 使用独立 Context；
- [x] 不继承父会话历史；
- [x] Step Result 保存到 Workflow Snapshot；
- [x] Step Error 结构化记录；
- [x] Step Usage 单独统计；
- [x] 支持 Step `timeoutMs`；
- [x] 支持 `continueOnError`；
- [x] 结束后释放资源；
- [x] Workflow Agent Step 不允许调用 `sub_agent_*`；
- [x] Workflow Agent Step 不允许调用 `workflow_*`。

---

## 35.5 Step 5：DAG Scheduler

### 验收标准

- [x] 无依赖 Step 可立即进入 ready；
- [x] 有依赖 Step 只有依赖满足后运行；
- [x] A/B/C 无依赖时可以并行；
- [x] D 依赖 A/B/C 时必须等待全部满足；
- [x] 重复 Step ID 在运行前拒绝；
- [x] 未知依赖在运行前拒绝；
- [x] self dependency 被拒绝；
- [x] cycle 被拒绝；
- [x] 依赖失败时下游默认进入 `blocked`；
- [x] `continueOnError` 语义有明确测试；
- [x] blocked 节点不会调用 Agent Runner；
- [x] Scheduler 不存在 busy-loop；
- [x] 无 ready 且无 running 时能安全终止；
- [x] 实际并发不超过 `workflow.maxConcurrency`；
- [x] 实际并发不超过全局 `AgentExecutionScheduler`；
- [x] 全局 Scheduler 满时 Workflow Step 正确排队；
- [x] queued Step 在 cancel 后不会执行。

### 必须通过的拓扑

```text
A -> B -> C
```

```text
A ─┐
B ─┼─> D
C ─┘
```

```text
A failed
└── B blocked
```

```text
A -> B -> C -> A
```

最后一个必须在运行前识别为 cycle。

---

## 35.6 Step 6：synthesize Profile

### 验收标准

- [x] `synthesize` 不暴露给普通 `sub_agent_start`；
- [x] Workflow 内部可调用；
- [x] 默认 Tools 为空；
- [x] 不可访问文件/Web/Terminal/MCP/Browser；
- [x] 只依据依赖结果总结；
- [x] Prompt 标明每个依赖结果来源；
- [x] Prompt 标明 failed/blocked/incomplete 输入；
- [x] 单依赖结果有长度上限；
- [x] 总依赖注入有长度上限；
- [x] 截断时加入明确标记；
- [x] 某个依赖无输出时 Prompt Builder 不崩溃；
- [x] Summary Agent 失败时准确记录 Step Error。

---

# 36. Phase 5.1 Exit Gate

- [x] WorkflowEngine 完成；
- [x] WorkflowManager 完成；
- [x] Workflow Tools 完成；
- [x] Agent Step 完成；
- [x] DAG Scheduler 完成；
- [x] synthesize 完成；
- [x] Workflow Timeout 完成；
- [x] Step Timeout 完成；
- [x] blocked 状态完成；
- [x] Usage 至少有内部聚合结构；
- [ ] `A/B/C -> D` E2E 通过；
- [ ] cancel E2E 通过；
- [ ] timeout E2E 通过；
- [ ] failed dependency E2E 通过；
- [ ] 无明显资源泄漏；
- [ ] CI 中 Workflow 自动化测试通过。

Phase 5.1 完成定义：

> Workflow 已从 Schema 变成可以真实运行、并行、等待依赖、失败传播和取消的 DAG Runtime。

---

## 37. Step 7：Workflow UI

### 验收标准

- [x] Renderer 能接收到 Workflow Event；
- [x] 每个 Run 使用独立 WorkflowCard；
- [x] 展示 Workflow 名称、Run ID、总状态、总进度、开始时间；
- [x] 每个 Step 展示 ID、状态、耗时、Usage；
- [x] running 有明确动态状态；
- [x] completed 可查看输出；
- [x] failed 可查看错误；
- [x] blocked 显示阻塞原因；
- [x] timed_out 与 failed 有视觉区分；
- [x] cancelled 与 failed 有视觉区分；
- [x] UI 可执行 Cancel；
- [x] 旧 Event 不覆盖新状态；
- [x] 多 Workflow 同时运行不串数据；
- [x] 大量 Step 时无明显卡顿（Schema 上限 32，折叠时不渲染明细，Step 行使用 memo，已覆盖 32 Step 渲染测试）；
- [x] 长输出默认折叠；
- [x] 模型输出 HTML 不可直接注入执行。

---

## 38. Step 8：Workflow Usage

### 验收标准

- [x] 每个 Step 有独立 Usage；
- [x] Workflow 汇总所有 Step Usage；
- [x] 不重复计算；
- [x] Main Agent Usage 与 Workflow Usage 分离；
- [x] Manual SubAgent 与 Workflow Step 不重复；
- [x] 至少统计 inputTokens/outputTokens；
- [x] Provider 提供 Cache Usage 时可保存；
- [x] failed/timed_out/cancelled Step 已产生的 Usage 仍统计；
- [x] UI 可查看 Workflow 总 Usage；
- [x] Usage 聚合有单元测试。

校验：

```text
Workflow Total = Σ Step Usage
```

```text
Session Total = Parent + Manual SubAgents + Workflow Total
```

---

## 39. Step 9：Timeout / Error

### 验收标准

- [x] Workflow Timeout 生效；
- [x] Step Timeout 生效；
- [x] Provider Timeout 可映射；
- [x] Timeout 后 AbortSignal 正确传播；
- [x] Error Code 不依赖 message 文本解析；
- [x] 支持 `workflow_timeout`；
- [x] 支持 `workflow_cancelled`；
- [x] 支持 `workflow_step_failed`；
- [x] 支持 `workflow_not_found`；
- [x] 支持 `workflow_invalid_definition`；
- [x] 支持 `workflow_deadlock`；
- [x] Step 可区分 timeout/cancelled/provider_error/max_iterations/invalid_profile；
- [x] UI 根据 Error Code 区分错误；
- [x] 多层 Timeout 同时触发时最终 stopReason 唯一且确定。

---

## 40. Step 10：Journal

### 验收标准

- [x] 每个 Workflow 有独立 Journal；
- [x] 使用 append-only JSONL；
- [x] 至少记录 workflow.started；
- [x] 至少记录 step.started；
- [x] 至少记录 step.completed；
- [x] 至少记录 step.failed；
- [x] 至少记录 workflow.completed；
- [x] 至少记录 workflow.failed；
- [x] 至少记录 workflow.cancelled；
- [x] 每条记录包含 timestamp/runId/type；
- [x] Step Event 包含 stepId；
- [x] completed Step 可保存 Result；
- [x] Usage 可保存；
- [x] Journal 写失败不会静默丢失；
- [x] 尾部半条 JSON 不影响前面完整记录读取；
- [x] 有文件大小/轮转策略（当前为单 Journal 10 MB 硬上限）；
- [x] 不默认记录敏感完整 System Prompt。

---

## 41. Step 11：Resume

### 验收标准

- [x] 支持 `workflow_resume`；
- [x] completed Step 不重复执行；
- [x] pending Step 正常继续；
- [x] 崩溃前 running Step 恢复为 interrupted；
- [x] interrupted Step 可重新执行；
- [x] definitionHash 不一致时拒绝 Resume；
- [x] 已有 Usage 不丢失；
- [x] replay completed Step 不重复计算 Usage；
- [x] rerun Step 新 Usage 正确累加；
- [x] 重复 Journal Event 不造成重复执行；
- [x] 半截 Journal 可恢复到最后完整 Event；
- [x] Resume 后依赖关系仍正确；
- [x] Resume 后 blocked 状态仍正确；
- [x] mismatch 返回 `workflow_resume_mismatch`。

### 必须通过的崩溃恢复测试

```text
A completed
B running
process crash
restart
```

预期：

```text
A replay
B interrupted -> rerun
C pending -> run
```

---

# 42. Phase 5.2 / 5.3 Exit Gate

- [x] Workflow UI 可观察；
- [x] Usage 完整；
- [x] Timeout/Error 分类稳定；
- [x] Journal 可用；
- [x] Resume 可用；
- [ ] 崩溃恢复 E2E 通过；
- [x] 旧 Event 不覆盖新状态；
- [x] Workflow 从启动到恢复有完整自动化测试（使用真实 JSONL Store 和新的 Manager 实例模拟重启）。

完成定义：

```text
可运行 + 可观察 + 可持久化 + 可恢复
```

---

## 43. Step 12：Custom Agent Profile

### 验收标准

- [ ] 支持 `~/.jojo/agents`；
- [ ] 支持项目 `.jojo/agents`；
- [ ] Markdown Frontmatter 可解析；
- [ ] `description` 必填；
- [ ] 单个非法 Profile 不影响其他合法 Profile；
- [ ] Project Profile 覆盖 User 同名 Profile；
- [ ] Built-in/User/Project 覆盖规则明确；
- [ ] `readOnly=true` 自动过滤写工具；
- [ ] `tools` 白名单有效；
- [ ] `disallowedTools` 黑名单有效；
- [ ] 无论配置如何都不能获得 `sub_agent_*`；
- [ ] 无论配置如何都不能获得 `workflow_*`；
- [ ] Profile Prompt 与 Task 组合规则固定；
- [ ] 支持 Reload 或明确无需重启重扫；
- [ ] 文件名映射稳定 Agent Type；
- [ ] Profile Parser 有单元测试。

---

## 44. Step 13：Model Override

### 验收标准

- [ ] `sub_agent_start` 可选 model；
- [ ] Workflow Agent Step 可选 model；
- [ ] 不指定时继承默认策略；
- [ ] 指定不存在模型时执行前报错；
- [ ] 只能选已配置 Provider/Model；
- [ ] 不允许传任意 API URL；
- [ ] Snapshot 记录实际模型；
- [ ] Usage 按实际模型统计；
- [ ] Resume 模型策略明确；
- [ ] UI 能显示实际模型；
- [ ] 不同模型 Child Context 不串线；
- [ ] 至少两个 mock model 的自动化测试通过。

---

## 45. Step 14：sub_agent_send

### 验收标准

- [ ] 可向存在且可交互 Child Agent 发送新任务；
- [ ] 新消息复用 Child Context；
- [ ] 不复用父 Context；
- [ ] Agent busy 时行为明确：排队或返回 busy；
- [ ] cancelled Agent 不允许 send；
- [ ] expired Agent 返回 `subagent_expired`；
- [ ] 多次 send 保持顺序；
- [ ] Usage 正确累计；
- [ ] Tool Event 可观察；
- [ ] Child Context 有 Token 上限；
- [ ] 超上限有压缩/拒绝策略；
- [ ] idle retention 到期释放内存；
- [ ] send 不可绕过嵌套 SubAgent 限制。

---

## 46. Step 15：Profile Registry

### 验收标准

- [ ] 支持 built-in/user/project 三层来源；
- [ ] 同名覆盖规则固定；
- [ ] `get(profileName)` 结果稳定；
- [ ] `list()` 展示来源；
- [ ] 非法配置隔离；
- [ ] 支持 Reload；
- [ ] Reload 不破坏正在运行 Agent；
- [ ] 新 Agent 使用最新 Profile；
- [ ] Registry 不负责具体 Agent 执行；
- [ ] 同名覆盖、非法配置、删除文件、reload 测试通过。

---

# 47. Phase 5.4 Exit Gate

- [ ] Custom Profile 可用；
- [ ] Model Override 可用；
- [ ] sub_agent_send 可用；
- [ ] Profile Registry 可用；
- [ ] 不破坏现有 explore；
- [ ] 自定义 Profile 不能绕过递归限制；
- [ ] 自定义 Profile 不能绕过工具权限；
- [ ] Child Context 有资源回收策略。

---

## 48. Step 16：Worktree Isolation

### 验收标准

- [ ] `isolation: worktree` 可创建独立 worktree；
- [ ] 每个 Agent/Step 目录唯一；
- [ ] 每个写 Agent 分支唯一；
- [ ] Branch 命名不冲突；
- [ ] 主 Workspace 不被修改；
- [ ] Agent cwd 指向自己的 worktree；
- [ ] Agent 不能写出 worktree 根目录；
- [ ] 无修改时自动清理 worktree 和临时 branch；
- [ ] 有修改时保留 branch；
- [ ] 有修改时返回 worktree path；
- [ ] 有修改时返回 branch；
- [ ] 有修改时返回 diffstat；
- [ ] Agent 失败有清理策略；
- [ ] Workflow cancel 有清理策略；
- [ ] 创建失败返回明确 Error；
- [ ] 非 Git Repository 行为明确；
- [ ] 防路径穿越；
- [ ] 并行创建多个 worktree E2E 通过。

---

## 49. Step 17：general Profile

### 验收标准

- [ ] general 默认要求隔离环境或有明确安全配置；
- [ ] 支持 read_file/list_files/grep/glob；
- [ ] 支持 write_file/edit_file/terminal；
- [ ] 默认不允许 sub_agent；
- [ ] 默认不允许 workflow；
- [ ] 高风险工具仍经过 Capability 约束；
- [ ] Agent 不能写出 Worktree；
- [ ] Agent 不能修改主 Workspace；
- [ ] 完成后返回修改摘要；
- [ ] 失败时已产生修改可审查；
- [ ] general 有独立 System Prompt；
- [ ] Prompt 明确当前 branch/worktree；
- [ ] 写文件、改文件、跑测试、越界拒绝 E2E 通过。

---

## 50. Step 18：并行写入

### 验收标准

- [ ] 两 Agent 修改不同文件互不覆盖；
- [ ] 两 Agent 修改同一文件也因不同 Worktree 不发生直接 FS 冲突；
- [ ] 每个 Agent 独立 branch；
- [ ] Main Workspace 始终不变；
- [ ] Workflow 可并行运行多个 general Step；
- [ ] 全局 Scheduler 仍限制并发；
- [ ] 一个 Agent 失败不影响其他 Worktree；
- [ ] cancel 单 Step 只影响对应 Worktree；
- [ ] Workflow cancel 能按策略清理全部未保留 Worktree；
- [ ] Branch/Diff 信息回传主 Agent；
- [ ] 3 个以上并行写 Agent E2E 通过。

---

## 51. Step 19：Branch / Diff Review

### 验收标准

- [ ] 每个写 Agent 返回 branch/worktree/changed files/diffstat；
- [ ] 可查看完整 diff；
- [ ] UI 区分无修改/有修改；
- [ ] 不自动 merge；
- [ ] 用户明确批准前不 merge；
- [ ] 主 Agent 可读取 diff 并总结；
- [ ] 大 Diff 有截断或分页；
- [ ] 二进制文件有明确处理；
- [ ] 敏感文件展示策略明确；
- [ ] Worktree 被外部删除后状态能正确反馈；
- [ ] Cleanup 不删除用户已有 branch。

---

# 52. Phase 5.5 Exit Gate

- [ ] Worktree Isolation 稳定；
- [ ] general 可用；
- [ ] 两个以上写 Agent 可并行；
- [ ] 主 Workspace 不污染；
- [ ] Branch/Diff 可审查；
- [ ] 默认不自动 merge；
- [ ] Cancel/Failure/Cleanup 测试完整；
- [ ] 路径逃逸安全测试通过。

完成定义：

```text
安全的 Writable Multi-Agent
```

---

## 53. Step 20：Saved Workflow

### 验收标准

- [ ] 支持 `~/.jojo/workflows`；
- [ ] 支持项目 `.jojo/workflows`；
- [ ] Workflow 可保存；
- [ ] Workflow 可加载；
- [ ] Workflow 可列出；
- [ ] 同名覆盖优先级明确；
- [ ] 单个非法 Workflow 不影响其他文件；
- [ ] 保存前执行 Schema Validation；
- [ ] 保存路径防路径穿越；
- [ ] 文件名和 Workflow Name 映射规则明确；
- [ ] 修改文件后可 Reload；
- [ ] Tool 或 GUI 至少一种方式可运行 Saved Workflow；
- [ ] `schemaVersion` 保留。

---

## 54. Step 21：Workflow Inputs

### 验收标准

- [ ] Workflow 可声明 Inputs；
- [ ] 至少支持 string/number/boolean；
- [ ] required 缺失时运行前报错；
- [ ] default 生效；
- [ ] 类型不匹配时运行前报错；
- [ ] 第一版只支持 `{{inputs.xxx}}`；
- [ ] 不支持任意 JS/TS 表达式；
- [ ] 不使用 `eval`；
- [ ] Input 可插值到 Agent Task；
- [ ] 未知变量报错；
- [ ] Input 值长度有限制；
- [ ] 敏感 Input 不默认写公开日志；
- [ ] Resume 对 Inputs 一致性有验证。

---

## 55. Step 22：Workflow Templates

### 验收标准

- [ ] 至少有 3 个内置模板；
- [ ] 建议包含 parallel-understand；
- [ ] 建议包含 architecture-review；
- [ ] 建议包含 code-review；
- [ ] Built-in 与 User Template 分离；
- [ ] 用户同名覆盖规则明确；
- [ ] Template 可展示 description；
- [ ] Template 可声明 Inputs；
- [ ] 运行前 Schema Validation；
- [ ] 修改模板无需改代码即可使用；
- [ ] Template 不能获得额外权限；
- [ ] 删除用户模板不影响 Built-in；
- [ ] 模板文件损坏有明确错误。

---

## 56. Step 23：Condition Step

### 验收标准

- [ ] 支持 `type: condition`；
- [ ] Condition 使用声明式语法；
- [ ] 禁止 eval；
- [ ] 禁止 Function；
- [ ] 禁止任意 JS expression；
- [ ] 第一版至少支持 equals/notEquals/exists；
- [ ] 可读取指定 Step 的结构化字段；
- [ ] 不能任意读取运行环境；
- [ ] true/false 行为确定；
- [ ] 未走分支状态明确，例如 skipped；
- [ ] Resume 后 Condition 重放/重算策略明确；
- [ ] 输入不存在时结构化报错；
- [ ] DAG Cycle Validation 仍有效；
- [ ] Condition 有单元测试。

---

## 57. Step 24：Map Step

### 验收标准

- [ ] 支持 `type: map`；
- [ ] Source 必须来自明确上游输出；
- [ ] Source 必须为数组/列表；
- [ ] 支持 `itemLimit`；
- [ ] 超 `itemLimit` 行为明确；
- [ ] 每个 Item 展开成可观察独立子 Step；
- [ ] 每个子 Step ID 唯一；
- [ ] 子 Step 受 Global Scheduler 限流；
- [ ] Map 不绕过 Workflow `maxConcurrency`；
- [ ] 单 Item 失败不导致 Scheduler 崩溃；
- [ ] continueOnError 语义明确；
- [ ] Cancel 可取消全部 Map Child；
- [ ] Resume 时 completed Item 不重跑；
- [ ] Map 输出顺序规则固定；
- [ ] Item 数量和内存均有硬上限；
- [ ] 0/1/20 Items、Item failure、Cancel 测试通过。

---

# 58. Phase 5.6 / Phase 6 Exit Gate

- [ ] Saved Workflow 可复用；
- [ ] Inputs 可参数化；
- [ ] Built-in Template 可用；
- [ ] Condition 声明式且无 eval；
- [ ] Map 有严格展开上限；
- [ ] Map/Condition 支持 Resume；
- [ ] 新 Step Type 不绕过 Permission/Scheduler；
- [ ] Workflow Definition 仍可静态验证；
- [ ] GUI 可展示新 Step 类型。

完成定义：

```text
声明式 + 参数化 + 可复用 + 可分支 + 可批量 + 可恢复
```

---

# 59. 全项目最终验收矩阵

| 能力 | 必须验证 | 通过条件 |
|---|---|---|
| SubAgent | 并发、取消、超时、递归限制 | 无资源泄漏、状态正确 |
| Workflow DAG | 依赖、并行、blocked | 调度顺序正确 |
| Workflow Tool | start/wait/status/cancel | 生命周期完整 |
| UI | Step/Run 状态 | 实时且无乱序覆盖 |
| Usage | Step/Workflow/Session | 无重复统计 |
| Journal | JSONL append-only | 崩溃后可读取 |
| Resume | interrupted 恢复 | completed 不重跑 |
| Custom Agent | User/Project Profile | 权限不可绕过 |
| Model Override | 不同 Agent 不同模型 | 配置和 Usage 正确 |
| Persistent Child | send/context | 上下文隔离且可回收 |
| Worktree | 独立目录/分支 | Main Workspace 不变 |
| Writable Agent | 写代码/跑测试 | 不越界 |
| Parallel Write | 多 Agent 并行 | 无直接文件冲突 |
| Saved Workflow | 保存/加载 | Schema 稳定 |
| Inputs | 参数化 | 无 eval |
| Condition | 条件分支 | 可静态验证 |
| Map | 批量展开 | 有严格限流 |

---

# 60. Release Gate

## Gate A：功能

- [ ] Happy Path；
- [ ] Error Path；
- [ ] Cancel；
- [ ] Timeout。

## Gate B：安全

- [ ] 无递归绕过；
- [ ] 无权限绕过；
- [ ] 无路径逃逸；
- [ ] 无无限并发；
- [ ] 无 `eval` 类动态执行。

## Gate C：稳定性

- [ ] 无 Promise 泄漏；
- [ ] 无 AbortController 泄漏；
- [ ] 无死锁；
- [ ] 无 Busy Loop；
- [ ] Retention 有上限。

## Gate D：可观察性

- [ ] 状态可查询；
- [ ] 错误可分类；
- [ ] Usage 可统计；
- [ ] UI 或日志至少一条可定位路径。

## Gate E：测试

- [ ] Unit Test；
- [ ] Integration Test；
- [ ] 至少一个 E2E；
- [ ] Regression 不破坏现有 SubAgent。

只有：

```text
A + B + C + D + E
```

全部通过，功能才能标记为 `Done`，而不是仅 `Implemented`。

---

# 61. 推荐 Milestone 拆分

## Milestone：Workflow Runtime MVP

- [x] #1 WorkflowEngine
- [x] #2 WorkflowManager
- [x] #3 Workflow Tools
- [x] #4 Agent Step
- [x] #5 DAG Scheduler
- [x] #6 Synthesize Profile

Exit Gate：`Phase 5.1`

## Milestone：Workflow Reliability

- [x] #7 Workflow UI
- [x] #8 Usage
- [x] #9 Error / Timeout
- [x] #10 Journal
- [x] #11 Resume

Exit Gate：`Phase 5.2 / 5.3`

## Milestone：Extensible SubAgent

- [ ] #12 Custom Agent Profile
- [ ] #13 Model Override
- [ ] #14 sub_agent_send
- [ ] #15 Profile Registry

Exit Gate：`Phase 5.4`

## Milestone：Writable Multi-Agent

- [ ] #16 Worktree Isolation
- [ ] #17 general Profile
- [ ] #18 Parallel Write
- [ ] #19 Branch / Diff Review

Exit Gate：`Phase 5.5`

## Milestone：Reusable Workflow

- [ ] #20 Saved Workflow
- [ ] #21 Workflow Inputs
- [ ] #22 Workflow Templates
- [ ] #23 Condition Step
- [ ] #24 Map Step

Exit Gate：`Phase 5.6 / Phase 6`

---

# 62. 最终 Definition of Done

- [x] 主 Agent 可以启动多个只读 SubAgent；
- [x] SubAgent 可独立运行、查询、等待、取消；
- [x] Workflow 可执行声明式 DAG；
- [x] Workflow 支持真实并发；
- [x] Workflow 支持依赖失败传播；
- [x] Workflow 支持 Timeout / Cancel；
- [ ] Workflow 可由 UI 完整观察；
- [x] Workflow 可以 Journal；
- [x] Workflow 可以 Resume；
- [ ] 用户可以定义自己的 Agent Profile；
- [ ] 子 Agent 可以选择指定模型；
- [ ] 长生命周期 Child 可以继续对话；
- [ ] 可写 Agent 使用独立 Worktree；
- [ ] 多个写 Agent 可以并行工作；
- [ ] 修改结果可通过 Branch / Diff 审查；
- [ ] Workflow 可保存和复用；
- [ ] Workflow 可接收 Inputs；
- [ ] Condition / Map 不依赖动态代码执行；
- [x] 所有执行受统一 Scheduler 限流；
- [x] 所有 Agent 都不能无限递归；
- [x] 所有副作用受 Tool Capability / Permission 模型约束；
- [x] 崩溃不会导致已完成 Workflow 状态全部丢失；
- [ ] 所有关键路径存在自动化测试。

达到以上条件以后，才建议从：

```text
SubAgent + Workflow Beta
```

升级为：

```text
Stable Multi-Agent Orchestration
```

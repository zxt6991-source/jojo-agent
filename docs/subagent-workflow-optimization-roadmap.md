# jojo-agent 子 Agent 与 Workflow 后续优化方案

> 基于 `zxt6991-source/jojo-agent` 当前 `main` 分支实现整理  
> 对标参考：`open-octo/octo-agent`  
> 目标：保留 jojo-agent 的声明式 DAG 优势，同时补齐专业化 Sub-Agent、可恢复会话、隔离执行、结构化输出与可复用工作流能力。

---

## 1. 结论先行

后续不建议把 jojo-agent 的 Workflow 改造成 Octo 那种 Ruby / Script 驱动模式。

jojo-agent 当前最有价值的方向是：

```text
Declarative DAG
    +
Typed Contract
    +
Deterministic Scheduler
    +
Persistent Journal
    +
Rich Sub-Agent Runtime
```

也就是：

```text
                   Main Agent
                        │
                Workflow Definition
                        │
                   DAG Validator
                        │
                  Workflow Engine
                        │
              Dependency Scheduler
                        │
       ┌────────────────┼────────────────┐
       │                │                │
   Agent Step        Tool Step       Control Step
       │
       ├─ profile
       ├─ model
       ├─ tools
       ├─ readOnly
       ├─ outputSchema
       ├─ retry
       └─ isolation
```

核心原则：

1. **保留声明式 DAG，不引入 Ruby/JS 任意脚本作为主工作流格式。**
2. **学习 Octo 的 Sub-Agent Runtime，而不是复制 Octo 的 Workflow DSL。**
3. **所有权限、工具、模型、隔离必须由 Runtime 强制执行，不能只靠 Prompt。**
4. **Workflow 的依赖数据应逐步从“自然语言拼 Prompt”升级为“结构化输入引用”。**
5. **先增强 Agent 能力，再扩 Workflow Step 类型。**
6. **所有新增功能必须兼容当前 `schemaVersion: 1`。**

---

# 2. 当前实现基线

当前 orchestration 目录已经具备一个不错的最小闭环：

```text
packages/orchestration/src/
├── subagent/
│   ├── manager.ts
│   ├── scheduler.ts
│   ├── tools.ts
│   └── types.ts
│
└── workflow/
    ├── engine.ts
    ├── manager.ts
    ├── persistence.ts
    ├── prompt-builder.ts
    ├── tools.ts
    └── types.ts
```

当前已经有：

### Sub-Agent

```text
sub_agent_start
sub_agent_wait
sub_agent_status
sub_agent_cancel
```

状态：

```text
queued
running
completed
failed
cancelled
timed_out
```

并且有统一的：

```text
AgentExecutionScheduler
```

负责限制并发和排队。

### Workflow

当前已经支持真正的 DAG：

```yaml
steps:
  - id: inspect
    type: agent
    task: inspect project

  - id: kernel
    type: agent
    dependsOn: [inspect]
    task: inspect kernel

  - id: summary
    type: agent
    dependsOn: [kernel]
    task: summarize
```

已有能力：

- `dependsOn`
- DAG 环检测
- 未知依赖检测
- `continueOnError`
- step timeout
- workflow timeout
- `maxConcurrency`
- blocked 状态
- deadlock 检测
- journal
- restore
- resume
- completed step 不重复执行

因此不需要重写 Workflow Engine。

后续应该以“增量扩展”为主。

---

# 3. 总体 Roadmap

建议拆成 4 个阶段。

| 阶段 | 重点 | 优先级 |
|---|---|---|
| Phase 0 | Sub-Agent Runtime 补齐 | P0 |
| Phase 1 | Workflow V2 能力增强 | P1 |
| Phase 2 | Coding Isolation + 可复用工作流 | P1/P2 |
| Phase 3 | UI / Observability / 高级编排 | P2 |

推荐顺序：

```text
Profile
   ↓
Tool Policy
   ↓
Agent Continue
   ↓
Structured Output
   ↓
Workflow Step Agent Options
   ↓
Typed Step Inputs
   ↓
Retry Policy
   ↓
Worktree Isolation
   ↓
Tool Step
   ↓
Condition / foreach / matrix
   ↓
Saved Workflow
   ↓
UI DAG Visualization
```

---

# 4. Phase 0：补齐 Sub-Agent Runtime

这是最高优先级。

目前 jojo 的 Workflow Engine 已经比 Sub-Agent Runtime 更成熟。

## 4.0 实现状态（2026-08-16）

- [x] `SubAgentProfile` Contract 已从封闭枚举升级为受格式约束的开放字符串；
- [x] Built-in Profile Registry 已包含 `explore/general/synthesize/code-review`；
- [x] 未注册 Profile 返回稳定的 `invalid_profile`；
- [x] Tool Policy 已支持 Profile/Request 两层 `allow/deny/readOnly`，并执行“请求只能收紧权限”；
- [x] `readOnly` 在 Runtime 层移除 `write_file/edit_file/delete_file/terminal`；
- [x] `sub_agent_start` 已支持 profile、model、maxIterations、timeout、tools 和 readOnly 参数；
- [x] Profile 的 model/maxIterations/timeout 默认值会进入实际 `LeafAgentRunRequest`；
- [ ] User/Project 自定义 Profile 加载；
- [x] Agent Continue / Send / Close：支持 `idle/closed`、稳定 busy/closed error code 与上下文续接；
- [x] Agent Round History：每轮保存 input/output/timestamps/usage/stopReason；
- [x] Structured Output：Sub-Agent 与 Workflow Agent Step 均支持 `outputSchema`；成功快照保存 `structuredResult/schemaValid`；非法 JSON、非法 Schema 或校验不匹配会以稳定错误码失败并阻断下游；Schema/结果均设置大小、深度、节点数与数组长度边界。

---

## 4.1 P0-1：Agent Profile Registry

### 当前问题

目前 Contract 虽然有：

```ts
type SubAgentProfile =
  | 'explore'
  | 'synthesize';
```

但是 profile 还只是一个枚举值。

它应该升级为真正的 Runtime Profile：

```text
Profile
 ├─ systemPrompt
 ├─ model
 ├─ allowedTools
 ├─ deniedTools
 ├─ readOnly
 ├─ maxIterations
 ├─ timeout
 └─ outputSchema
```

### 建议内置 Profile

第一阶段先做：

```text
explore
general
synthesize
code-review
```

定义：

| Profile | 用途 | 写权限 |
|---|---|---|
| explore | 搜索、分析、理解代码 | 否 |
| general | 通用执行任务 | 是 |
| synthesize | 汇总多个结果 | 否 |
| code-review | diff / review | 否 |

### 建议新增

```text
packages/orchestration/src/subagent/profile-registry.ts
```

示例：

```ts
export type AgentProfileDefinition = {
  name: string;
  description: string;
  systemPrompt?: string;

  readOnly: boolean;

  allowedTools?: string[];
  deniedTools?: string[];

  model?: string;
  maxIterations?: number;
  timeoutMs?: number;
};

export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfileDefinition>();

  register(profile: AgentProfileDefinition): void {
    this.profiles.set(profile.name, profile);
  }

  get(name: string): AgentProfileDefinition {
    const profile = this.profiles.get(name);

    if (!profile) {
      throw new Error(`invalid_profile: ${name}`);
    }

    return profile;
  }
}
```

### 第二阶段支持项目自定义

例如：

```text
.jojo/agents/security.md
.jojo/agents/kernel-review.md
```

格式可采用：

```markdown
---
name: security
description: Security review agent
readOnly: true
allowedTools:
  - read_file
  - grep
  - glob
model: inherit
---

Review the code for:
- injection
- secret leakage
- unsafe shell execution
```

### 不建议

不要一开始就实现复杂插件化加载。

第一版：

```text
Builtin Registry
```

跑通以后再加入：

```text
User Profile
Project Profile
```

优先级：

**P0**

---

# 5. P0-2：真正的 Agent Tool Policy

这是比 Profile 名称本身更重要的能力。

### 当前问题

如果 Agent 是否“只读”主要靠 Prompt 告诉模型：

```text
Do not edit files.
```

是不够可靠的。

Runtime 必须实际删除写工具。

目标：

```text
Agent Profile
       │
       ↓
 Tool Policy Resolver
       │
       ↓
Effective Tool Set
       │
       ↓
 LeafAgentRunner
```

### 建议结构

```ts
export type AgentToolPolicy = {
  readOnly?: boolean;
  allow?: string[];
  deny?: string[];
};
```

解析顺序建议：

```text
全局工具集
  ↓
Profile allow / deny
  ↓
Request allow / deny
  ↓
readOnly filter
  ↓
最终工具集
```

其中：

```text
deny 优先级最高
```

例如：

```yaml
profile: general

tools:
  allow:
    - read_file
    - grep
    - terminal

  deny:
    - write_file
```

最终执行时：

```text
write_file
```

根本不注册给这个 Agent。

---

# 6. P0-3：扩展 LeafAgentRunRequest

当前请求结构主要类似：

```ts
type LeafAgentRunRequest = {
  id: string;
  sessionId: string;
  workingDirectory: string;
  task: string;
  profile: SubAgentProfile;
  providerId: string;
  model: string;
  maxIterations: number;
  timeoutMs: number;
};
```

建议逐步升级为：

```ts
export type LeafAgentRunRequest = {
  id: string;

  sessionId: string;
  workingDirectory: string;

  task: string;

  profile: string;

  providerId: string;
  model: string;

  maxIterations: number;
  timeoutMs: number;

  tools?: {
    allow?: string[];
    deny?: string[];
  };

  readOnly?: boolean;

  outputSchema?: unknown;

  isolation?: {
    type: 'none' | 'worktree';
  };

  continuationId?: string;
};
```

注意：

```text
profile
```

不要继续使用封闭 enum。

否则以后每加一个自定义 Agent 都要升级 Contract。

建议改成：

```ts
z.string().min(1)
```

真正有效性由：

```text
AgentProfileRegistry
```

校验。

---

# 7. P0-4：Agent Continue / Send

这是 Sub-Agent 目前最大的能力缺口之一。

---

## 7.1 目标行为

目前：

```text
start
  ↓
run
  ↓
completed
```

建议升级为：

```text
start
  ↓
running
  ↓
idle
  │
  ├── send
  │     ↓
  │   running
  │     ↓
  └──── idle
        │
      close
```

也就是 Agent 结束一次回答以后，不立即视为永久死亡。

---

## 7.2 建议状态机

建议不要让 `completed` 同时表示：

```text
本轮回答结束
```

和：

```text
Agent 永久结束
```

否则语义容易混乱。

建议：

```text
queued
running
idle
failed
cancelled
timed_out
closed
```

含义：

```text
idle
```

表示：

> 当前没有任务，但上下文仍然存在，可以继续 send。

```text
closed
```

表示：

> 会话真正不可继续。

---

## 7.3 Runner 接口调整

建议：

```ts
export type LeafAgentRunResult = {
  result: string;
  stopReason: string;

  continuationId?: string;

  usage: UsageTotals;

  incomplete: boolean;
};
```

并扩展：

```ts
export interface LeafAgentRunner {
  run(...): Promise<LeafAgentRunResult>;

  continue?(
    continuationId: string,
    task: string,
    signal: AbortSignal,
    onEvent: (event: AgentEvent) => void
  ): Promise<LeafAgentRunResult>;

  close?(continuationId: string): Promise<void>;
}
```

如果底层 Provider 本身没有 Session Resume 能力，则可以先由 jojo 保存：

```text
message history
```

然后重新构造上下文。

---

## 7.4 新工具

新增：

```text
sub_agent_send
sub_agent_close
```

已有：

```text
sub_agent_status
sub_agent_cancel
```

保持不变。

推荐 API：

```json
{
  "id": "sa_xxx",
  "message": "继续检查 network.c 中的错误处理"
}
```

### 需要处理 Busy 状态

如果 Agent 正在运行，再 send：

第一版建议：

```text
busy → reject
```

返回：

```text
subagent_busy
```

不要第一版就做 message queue。

后续再加：

```text
pendingMessage
```

---

# 8. P0-5：Structured Output

这是 Workflow 可靠性提升最大的单项之一。

当前 Agent Step 输出本质上仍然是：

```text
string
```

后面的 step 再把它拼进 Prompt。

对于复杂工作流会出现：

```text
自由文本
  ↓
模型解释
  ↓
自由文本
  ↓
模型再次解释
```

容易产生字段丢失和格式漂移。

---

## 8.1 增加 outputSchema

Sub-Agent：

```yaml
outputSchema:
  type: object
  properties:
    files:
      type: array
      items:
        type: string
    summary:
      type: string
  required:
    - files
    - summary
```

Agent 完成后：

```text
LLM Result
  ↓
JSON Parse
  ↓
JSON Schema Validate
  ↓
Store Structured Output
```

建议 Snapshot：

```ts
type SubAgentSnapshot = {
  ...
  result?: string;

  structuredResult?: unknown;

  schemaValid?: boolean;
};
```

Workflow Step 同理：

```ts
type WorkflowStepSnapshot = {
  ...
  output?: string;
  structuredOutput?: unknown;
};
```

---

# 9. Phase 1：Workflow V2

在 Sub-Agent Runtime 稳定以后，再升级 Workflow。

---

# 10. P1-1：Agent Step 增加运行参数

当前：

```yaml
- id: kernel
  type: agent
  profile: explore
  task: Analyze kernel
```

建议 V2：

```yaml
- id: kernel
  type: agent

  profile: kernel-review

  model: inherit

  task: Analyze kernel

  readOnly: true

  tools:
    allow:
      - read_file
      - grep
      - glob

  timeoutMs: 120000

  retry:
    maxAttempts: 2
    backoffMs: 1000

  outputSchema:
    type: object
    properties:
      files:
        type: array
        items:
          type: string

      findings:
        type: array
        items:
          type: string

    required:
      - files
      - findings
```

注意：

```text
Workflow Step Options
```

最终不能绕过：

```text
Profile Tool Policy
```

应该取更严格的一边。

---

# 11. P1-2：不要继续把所有依赖结果直接拼 Prompt

当前逻辑大体是：

```text
Task
+
Dependency Results
+
所有依赖输出
```

这在 DAG 小的时候很好用。

DAG 变大以后会有三个问题：

1. Token 快速膨胀
2. Step 无法精确声明自己需要哪个字段
3. 上游自然语言输出容易污染下游 Prompt

建议引入：

# Typed Inputs

例如：

```yaml
- id: summary
  type: agent

  dependsOn:
    - kernel
    - yocto

  inputs:
    kernelFindings:
      from: kernel
      path: $.findings

    yoctoFiles:
      from: yocto
      path: $.files

  task: Generate final analysis
```

构造 Prompt：

```text
Task:
Generate final analysis

Inputs:

kernelFindings:
[...]

yoctoFiles:
[...]
```

而不是无脑把两个 Agent 的整段输出全部拼进去。

---

# 12. P1-3：Step Data Reference

建议支持统一引用语法：

```text
$steps.inspect.output
$steps.kernel.structuredOutput.files
$workflow.args.target
```

例如：

```yaml
inputs:
  target:
    valueFrom: $workflow.args.target

  files:
    valueFrom: $steps.inspect.structuredOutput.files
```

第一版不建议支持任意 JS Expression。

可以只做：

```text
dot path
```

或者：

```text
JSON Pointer
```

例如：

```text
/steps/inspect/structuredOutput/files
```

越简单越好。

---

# 13. P1-4：Retry Policy

目前：

```text
resume
```

可以重新跑失败 step。

但是运行过程中没有明确的自动 retry policy。

建议：

```yaml
retry:
  maxAttempts: 3

  backoffMs: 1000

  retryOn:
    - provider_timeout
    - provider_error
```

不要默认重试：

```text
invalid_profile
workflow_deadlock
schema_validation_failed
permission_denied
```

推荐：

```ts
type RetryPolicy = {
  maxAttempts: number;
  backoffMs?: number;
  retryOn?: WorkflowStepErrorCode[];
};
```

状态：

```text
running
   ↓
failed
   ↓
retryable?
   │
   ├─ yes → pending(attempt + 1)
   │
   └─ no  → failed
```

---

# 14. P1-5：Workflow Args

支持：

```yaml
schemaVersion: 2

name: analyze-repo

inputs:
  target:
    type: string
    required: true

  deep:
    type: boolean
    default: false
```

启动：

```json
{
  "name": "analyze-repo",
  "args": {
    "target": "packages/orchestration",
    "deep": true
  }
}
```

这样 Workflow 才真正具有复用价值。

---

# 15. P1-6：Tool Step

这是最应该增加的第二种 Step。

现在：

```text
Workflow
  ↓
Agent
```

所有事情都必须经过 LLM。

但很多事情根本不需要 Agent：

```text
grep
git status
read_file
HTTP API
固定函数
```

建议：

```yaml
- id: git-status
  type: tool

  tool: terminal

  input:
    command: git status --short
```

Engine：

```text
AgentStepExecutor
ToolStepExecutor
```

不要继续把执行逻辑直接塞进巨大的：

```text
executeStep()
```

建议抽象：

```ts
interface WorkflowStepExecutor<TStep> {
  execute(
    step: TStep,
    context: WorkflowStepExecutionContext
  ): Promise<WorkflowStepExecutionResult>;
}
```

然后：

```text
AgentStepExecutor
ToolStepExecutor
```

后面再扩：

```text
ConditionStepExecutor
HumanStepExecutor
SubWorkflowStepExecutor
```

---

# 16. Phase 2：Worktree Isolation

对于 Coding Agent，这是很高价值的功能。

---

## 16.1 目标

并行：

```text
Agent A 修改 auth
Agent B 修改 network
Agent C 修改 storage
```

不能全部直接写：

```text
main working directory
```

否则产生：

```text
文件覆盖
git index 冲突
生成文件互相影响
测试结果混杂
```

---

## 16.2 Workflow 配置

```yaml
- id: fix-auth
  type: agent

  profile: general

  isolation:
    type: worktree

  task: Fix auth issues
```

运行：

```text
main repository
      │
      ├── worktree wf_x/fix-auth
      ├── worktree wf_x/fix-network
      └── worktree wf_x/fix-storage
```

---

## 16.3 建议新增

```text
packages/orchestration/src/isolation/
├── types.ts
├── manager.ts
└── git-worktree.ts
```

接口：

```ts
export interface ExecutionIsolation {
  prepare(request: IsolationPrepareRequest): Promise<IsolationContext>;

  finish(
    context: IsolationContext,
    result: IsolationFinishRequest
  ): Promise<IsolationResult>;

  cleanup(context: IsolationContext): Promise<void>;
}
```

返回：

```ts
type IsolationResult = {
  workingDirectory: string;

  branch?: string;
  commit?: string;

  changedFiles?: string[];
  diffStat?: string;

  hasChanges: boolean;
};
```

---

## 16.4 默认策略

没有修改：

```text
自动删除 worktree
```

有修改：

```text
保留 branch
+
返回 branch name
+
返回 diff stat
```

第一版不要自动 merge。

Merge 必须由：

```text
用户
或者后续明确的 Agent Step
```

执行。

---

# 17. P1/P2：Condition Step

目标：

```text
Analyze
   ↓
Condition
   ├── kernel project → Kernel Agent
   └── app project    → App Agent
```

不建议使用：

```text
eval()
new Function()
JavaScript
```

建议实现非常小的表达式模型。

例如：

```yaml
- id: project-type
  type: condition

  expression:
    equals:
      left:
        ref: $steps.inspect.structuredOutput.type

      right: kernel

  branches:
    true:
      - kernel-analysis

    false:
      - app-analysis
```

但这会改变当前纯 `dependsOn` DAG 语义。

因此建议放到：

**P2**

而不是第一阶段。

---

# 18. P2：foreach / matrix

这是 jojo 保持声明式，同时获得 Octo `parallel()` 能力的关键。

例如：

```yaml
- id: inspect-files
  type: foreach

  items:
    from: scan
    path: $.files

  concurrency: 4

  agent:
    profile: code-review
    task: |
      Review file:
      {{ item }}
```

相当于：

```text
files[]
  │
  ├─ Agent(file1)
  ├─ Agent(file2)
  ├─ Agent(file3)
  └─ Agent(file4)
```

完成后：

```text
results[]
```

### 重要设计

不要运行时真的修改主 DAG Definition。

建议内部生成：

```text
Virtual Step Instances
```

例如：

```text
inspect-files[0]
inspect-files[1]
inspect-files[2]
```

Snapshot 可以展示这些动态实例。

---

# 19. P2：Pipeline

在 foreach 基础上增加：

```yaml
- id: migrate
  type: pipeline

  items:
    from: scan
    path: $.files

  concurrency: 4

  stages:

    - id: analyze
      type: agent
      profile: explore

    - id: modify
      type: agent
      profile: general
      isolation:
        type: worktree

    - id: review
      type: agent
      profile: code-review
```

运行行为：

```text
file A:
analyze → modify → review

file B:
       analyze → modify → review

file C:
              analyze → modify → review
```

而不是：

```text
全部 analyze
↓
全部 modify
↓
全部 review
```

这样就能获得和 Octo `pipeline()` 类似的执行效率，同时仍然保持声明式。

---

# 20. P2：Saved Workflow Registry

建议：

```text
~/.jojo/workflows/
```

用户级。

项目级：

```text
.jojo/workflows/
```

优先级：

```text
project
>
user
>
builtin
```

例如：

```text
.jojo/workflows/
├── code-review.yaml
├── repo-understand.yaml
└── fix-ci.yaml
```

调用：

```text
workflow_start
```

可以逐步支持：

```json
{
  "name": "repo-understand",
  "args": {
    "target": "packages/orchestration"
  }
}
```

而不是每次都让模型重新生成整段 Definition。

---

# 21. P2：Sub-Workflow Step

支持：

```yaml
- id: security
  type: workflow

  workflow: security-review

  args:
    target:
      valueFrom: $workflow.args.target
```

这样大型流程可以组合：

```text
Main Workflow
   │
   ├─ Code Review Workflow
   ├─ Security Workflow
   └─ Test Workflow
```

但要限制递归。

建议：

```text
maxWorkflowDepth = 3
```

Sub-Agent 仍然建议保持：

```text
禁止 Sub-Agent 创建 Sub-Agent
```

两者不要混淆。

---

# 22. P2：预算系统

现在有 token usage。

后续可以升级：

```yaml
budget:
  maxInputTokens: 200000
  maxOutputTokens: 50000
  maxCostUsd: 2.0
```

Step 级：

```yaml
budget:
  maxOutputTokens: 8000
```

Scheduler 在启动下一 Step 前检查：

```text
budget remaining
```

不足：

```text
blocked
errorCode = workflow_budget_exceeded
```

不要等 Provider 返回超额才结束。

---

# 23. P2：Concurrency Group

现在主要是：

```text
Workflow maxConcurrency
```

建议增加：

```yaml
resources:
  group: write-repository
  maxConcurrency: 1
```

这样：

```text
read-only Agent
```

可以并发。

但是：

```text
会修改同一个 working tree 的 Agent
```

自动串行。

例如：

```yaml
- id: edit-a
  resources:
    group: main-worktree-writer

- id: edit-b
  resources:
    group: main-worktree-writer
```

如果使用 worktree：

```text
group 不同
```

就允许并行。

---

# 24. P2：Observability

jojo 的声明式 DAG 天然适合 UI。

推荐 UI：

```text
                    ┌──────────┐
                    │ inspect  │
                    │completed │
                    │  2.4k tok│
                    └────┬─────┘
                         │
             ┌───────────┴───────────┐
             │                       │
       ┌─────▼─────┐           ┌─────▼─────┐
       │  kernel   │           │   yocto   │
       │ running   │           │ completed │
       │  1.8k tok │           │  3.1k tok │
       └─────┬─────┘           └─────┬─────┘
             │                       │
             └───────────┬───────────┘
                         │
                   ┌─────▼─────┐
                   │  summary  │
                   │  pending  │
                   └───────────┘
```

每个节点显示：

```text
state
attempt
profile
model
duration
tokens
cost
stopReason
errorCode
worktree
```

点击节点：

```text
Input
Output
Structured Output
Logs
Tool Calls
Usage
```

---

# 25. 建议重构 Workflow Engine

不是推翻，而是把当前：

```text
engine.ts
```

逐渐拆成：

```text
workflow/
├── engine.ts
├── scheduler.ts
│
├── executors/
│   ├── types.ts
│   ├── agent-step.ts
│   ├── tool-step.ts
│   ├── condition-step.ts
│   └── foreach-step.ts
│
├── data/
│   ├── references.ts
│   └── inputs.ts
│
├── retry.ts
├── persistence.ts
├── prompt-builder.ts
└── manager.ts
```

`engine.ts` 最终只负责：

```text
状态机
依赖判断
调度
取消
timeout
retry
```

具体 step 怎么执行，由：

```text
StepExecutor
```

负责。

---

# 26. 推荐 WorkflowDefinition V2

建议最终大致发展为：

```yaml
schemaVersion: 2

name: repo-analysis

description: Analyze repository architecture

inputs:

  target:
    type: string
    required: true

maxConcurrency: 4

timeoutMs: 900000

budget:
  maxOutputTokens: 50000

steps:

  - id: inspect

    type: agent

    profile: explore

    task: |
      Inspect:
      {{ inputs.target }}

    outputSchema:
      type: object

      properties:

        projectType:
          type: string

        files:
          type: array
          items:
            type: string

      required:
        - projectType
        - files

  - id: architecture

    type: agent

    profile: explore

    dependsOn:
      - inspect

    inputs:

      files:
        valueFrom: $steps.inspect.structuredOutput.files

    task: Analyze architecture

    retry:
      maxAttempts: 2
      retryOn:
        - provider_timeout
        - provider_error

  - id: code-review

    type: foreach

    dependsOn:
      - inspect

    items:
      valueFrom: $steps.inspect.structuredOutput.files

    concurrency: 4

    agent:

      profile: code-review

      readOnly: true

      task: |
        Review:
        {{ item }}

  - id: summary

    type: agent

    profile: synthesize

    dependsOn:
      - architecture
      - code-review

    inputs:

      architecture:
        valueFrom: $steps.architecture.output

      review:
        valueFrom: $steps.code-review.output

    task: Produce final architecture report

outputStepId: summary
```

---

# 27. Sub-Agent Profile 与 Workflow 的关系

推荐严格分层：

```text
Workflow Step
     │
     │ 请求
     ↓
Agent Profile
     │
     │ 默认/限制
     ↓
Policy Resolver
     │
     ↓
Effective Agent Configuration
     │
     ↓
LeafAgentRunner
```

例如：

Profile：

```yaml
name: code-review
readOnly: true
allowedTools:
  - read_file
  - grep
  - terminal
```

Workflow：

```yaml
profile: code-review

tools:
  allow:
    - read_file
    - grep
```

最终：

```text
read_file
grep
```

不能因为 Workflow 要求：

```text
write_file
```

就突破 Profile 的：

```text
readOnly
```

原则：

> Workflow 只能进一步收紧权限，默认不能放宽 Profile 权限。

如果以后需要明确放宽：

```text
requiresApproval: true
```

交给权限系统。

---

# 28. Security Boundary

必须把以下几件事视为安全边界，而不是 Prompt 功能：

## Tool Permission

必须 Runtime Enforcement。

## Working Directory

必须验证：

```text
Agent 不能通过 ../
跳出允许目录
```

## Worktree

必须 canonicalize path。

## Custom Profile

项目里的：

```text
.jojo/agents/*.md
```

不能偷偷扩大用户全局权限。

## Workflow Definition

不能允许：

```text
eval
shell interpolation
arbitrary JS
```

作为控制表达式。

## Structured Output

JSON Schema 必须限制：

```text
schema size
depth
array size
```

避免模型生成巨大对象导致内存问题。

---

# 29. 不建议做的事情

## 29.1 暂时不要实现递归 Sub-Agent

不要：

```text
Main
 ↓
Agent
 ↓
Agent
 ↓
Agent
```

继续保持：

```text
depth <= 1
```

原因：

- 成本不可控
- 调试困难
- 生命周期复杂
- 用户很难知道谁启动了谁
- Workflow 已经负责 deterministic decomposition

正确结构：

```text
Main
 ↓
Workflow
 ↓
多个 Leaf Agent
```

---

## 29.2 不要把 Workflow 换成 Ruby/JS

当前 DAG 是差异化优势。

Octo 的 Script Workflow 强在灵活。

Jojo 应该强在：

```text
可验证
可视化
可恢复
可预测
可审计
```

---

## 29.3 不要第一版同时做所有 Step Type

推荐：

```text
agent
 ↓
tool
 ↓
foreach
 ↓
condition
 ↓
subworkflow
```

而不是一次性实现：

```text
agent/tool/skill/http/human/condition/loop/map/reduce/switch...
```

---

# 30. 推荐 PR 拆分顺序

这是比较适合真实开发的提交顺序。

---

## PR-01：Agent Profile Foundation

内容：

```text
profile-registry
builtin profiles
profile contract string 化
profile validation
```

验收：

- explore 正常运行
- general 正常运行
- invalid profile 返回稳定 error code
- 旧调用兼容

---

## PR-02：Tool Policy

内容：

```text
allowedTools
deniedTools
readOnly
policy resolver
```

验收：

```text
readOnly agent
```

看不到 write/edit 工具。

---

## PR-03：Per-Agent Model / Iteration

内容：

```text
model override
maxIterations override
timeout override
```

验收：

Workflow 内不同 Step 可使用不同 model。

---

## PR-04：Sub-Agent Continue

内容：

```text
continuationId
idle state
sub_agent_send
sub_agent_close
```

验收：

```text
start
→ idle
→ send
→ idle
→ send
→ idle
```

上下文连续。

---

## PR-05：Structured Output

内容：

```text
outputSchema
structuredResult
schema validation
schema error code
```

验收：

非法 JSON 不得以成功状态进入下游。

---

## PR-06：Workflow Agent Options

内容：

把：

```text
model
tools
readOnly
outputSchema
```

加入 Agent Step。

---

## PR-07：Typed Workflow Inputs

内容：

```text
inputs
valueFrom
step data reference
```

逐步减少：

```text
dependency full-output prompt concat
```

---

## PR-08：Retry Policy

内容：

```text
maxAttempts
retryOn
backoffMs
```

---

## PR-09：Worktree Isolation

内容：

```text
isolation manager
git worktree
branch lifecycle
diff stat
```

---

## PR-10：Tool Step

内容：

```text
StepExecutor abstraction
AgentStepExecutor
ToolStepExecutor
```

---

## PR-11：foreach

内容：

```text
Virtual Step Instance
dynamic fan-out
result collection
```

---

## PR-12：Saved Workflows

内容：

```text
.jojo/workflows
~/.jojo/workflows
workflow registry
args
```

---

## PR-13：DAG UI

内容：

```text
node graph
live state
tokens
duration
errors
logs
```

---

# 31. 测试策略

这部分很重要。

不要主要用真实 LLM 做 Workflow Engine Test。

使用：

```text
FakeLeafAgentRunner
```

例如：

```ts
class FakeLeafAgentRunner implements LeafAgentRunner {
  async run(request: LeafAgentRunRequest): Promise<LeafAgentRunResult> {
    return {
      result: `result:${request.id}`,
      stopReason: 'completed',
      usage: emptyUsage(),
      incomplete: false
    };
  }
}
```

然后测试 Engine 的确定性行为。

---

## 31.1 Sub-Agent Test

覆盖：

```text
start
queue
concurrency
timeout
cancel
status
continue
close
retention
```

---

## 31.2 DAG Test

覆盖：

### 线性

```text
A → B → C
```

### fan-out

```text
  ┌→ B
A ┤
  └→ C
```

### fan-in

```text
B ─┐
   ├→ D
C ─┘
```

### failure

```text
A failed
 ↓
B blocked
```

### continueOnError

```text
A failed
 ↓
B continue
```

### cycle

```text
A → B → C → A
```

Definition 阶段直接拒绝。

### retry

```text
attempt 1 fail
attempt 2 success
```

### resume

```text
A completed
B failed

resume

A 不运行
B attempt + 1
```

---

# 32. 建议新增 Error Code

后续最好把错误继续类型化。

例如：

```text
invalid_profile

tool_not_allowed
permission_denied

output_schema_invalid
output_schema_validation_failed

subagent_busy
subagent_closed
subagent_continue_failed

worktree_create_failed
worktree_cleanup_failed

workflow_budget_exceeded

workflow_reference_invalid
workflow_reference_not_found

workflow_retry_exhausted

workflow_step_type_unsupported
```

不要让上层通过：

```text
error.message.includes(...)
```

判断错误类型。

---

# 33. 建议增加 Agent Round

如果支持 Continue，单个 Snapshot 只有：

```text
result
```

就不够了。

建议：

```ts
type SubAgentRound = {
  index: number;

  input: string;

  output?: string;

  startedAt: string;
  finishedAt?: string;

  usage: UsageTotals;

  stopReason?: string;
};
```

Snapshot：

```ts
type SubAgentSnapshot = {
  ...
  rounds: SubAgentRound[];
};
```

UI：

```text
Agent A

Round 1
  inspect repository

Round 2
  inspect network.c

Round 3
  verify previous conclusion
```

比只保存最后一个：

```text
result
```

更容易调试。

---

# 34. Prompt Builder 的演进

现在的 Prompt Builder 可以保留作为：

```text
schemaVersion: 1
```

兼容逻辑。

V2：

```text
buildStepPromptV2()
```

应该只注入 Step 显式声明的：

```text
inputs
```

最终：

```text
V1:
dependency output concat

V2:
typed input resolver
```

等 V2 稳定以后再考虑废弃 V1。

---

# 35. Persistence 演进

现在已经有 journal / restore / resume。

后续不要换掉。

只需要扩：

```text
agent round
structured output
retry attempt
isolation metadata
step instance
workflow args
```

建议所有持久化记录继续：

```text
append-only
```

不要在运行过程中反复修改同一个 JSON 文件。

事件：

```text
workflow.started
step.queued
step.started
step.retrying
step.completed
step.failed

subagent.started
subagent.round.started
subagent.round.completed
subagent.closed

worktree.created
worktree.committed
worktree.cleaned
```

最终 Snapshot 从事件/transition 中恢复。

---

# 36. Scheduler 演进

当前 Scheduler 已经很好用。

建议不要把：

```text
Workflow maxConcurrency
```

和：

```text
全局 Agent maxConcurrency
```

混为一层。

推荐：

```text
Workflow Scheduler
        │
        ↓
Global AgentExecutionScheduler
        │
        ↓
Provider
```

也就是：

```text
Workflow:
最多 4

Global:
最多 8

Provider:
最多 N
```

最终有效并发取最严格限制。

后面可以增加：

```text
Provider-specific Semaphore
```

例如：

```text
OpenAI: 4
Anthropic: 2
Local: 8
```

---

# 37. 推荐最终架构

```text
┌─────────────────────────────────────┐
│             Main Agent              │
└──────────────────┬──────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
 SubAgent Tools         Workflow Tools
        │                     │
        ▼                     ▼
┌───────────────┐     ┌────────────────┐
│SubAgentManager│     │WorkflowManager │
└───────┬───────┘     └───────┬────────┘
        │                     │
        │              ┌──────▼──────┐
        │              │  DAG Engine │
        │              └──────┬──────┘
        │                     │
        │       ┌─────────────┼─────────────┐
        │       │             │             │
        │       ▼             ▼             ▼
        │  AgentExecutor ToolExecutor ForeachExecutor
        │       │
        └───────┼─────────────────────────────┐
                │                             │
        ┌───────▼────────┐             ┌──────▼──────┐
        │Profile Registry│             │Isolation Mgr│
        └───────┬────────┘             └──────┬──────┘
                │                             │
        ┌───────▼────────┐              Git Worktree
        │ Tool Policy    │
        └───────┬────────┘
                │
        ┌───────▼────────┐
        │LeafAgentRunner │
        └───────┬────────┘
                │
        ┌───────▼────────┐
        │ Provider Layer │
        └────────────────┘
```

---

# 38. 和 Octo 的最终差异化

不要追求：

```text
Octo 能做什么
Jojo 就一模一样做什么
```

最终定位建议：

## Octo

```text
Agent-native scripting runtime
```

特点：

```text
Ruby
parallel
pipeline
dynamic control flow
```

## Jojo

建议定位：

```text
Typed Declarative Multi-Agent Workflow Runtime
```

特点：

```text
Typed DAG
Static validation
Visual graph
Persistent execution
Resumability
Structured IO
Permission model
Worktree isolation
```

这样两者不是简单的强弱关系，而是：

```text
Octo:
灵活

Jojo:
确定、可视、可恢复、可审计
```

---

# 39. 最值得先做的 5 件事

如果当前只投入有限开发时间，我建议顺序严格按：

## 1. Agent Profile + Tool Policy

这是后续所有专业 Agent 的基础。

## 2. Agent Continue

让 Agent 从“一次性任务”升级为“可持续 Worker”。

## 3. Structured Output

让 Workflow 数据流真正可靠。

## 4. Workflow Agent Options + Typed Inputs

让 DAG 不再只是“Prompt 串接器”。

## 5. Worktree Isolation

让 Coding Multi-Agent 真正能够安全并行。

完成这五项以后，jojo 的能力会从：

```text
能跑多 Agent
```

升级成：

```text
具备工程化价值的 Multi-Agent Runtime
```

---

# 40. 建议版本规划

## v0.2

```text
Agent Profiles
Tool Policy
Per-Agent Model
Structured Output
```

## v0.3

```text
Agent Continue
Agent Round History
Workflow Agent Options
Typed Inputs
Retry
```

## v0.4

```text
Worktree Isolation
Tool Step
Saved Workflow
Workflow Args
```

## v0.5

```text
foreach
pipeline
Sub-Workflow
Budget
Concurrency Group
```

## v0.6

```text
DAG Visual Editor
Run Timeline
Cost Dashboard
Agent Detail Panel
Workflow Templates
```

---

# 41. 最终目标

最终 jojo-agent 的 Workflow 不应该只是：

```text
Agent A
 ↓
Agent B
 ↓
Agent C
```

而应该达到：

```text
                   Workflow
                       │
                Static Validation
                       │
                 Persistent DAG
                       │
           ┌───────────┼───────────┐
           │           │           │
       Research      Coding      Testing
           │           │           │
       Profile      Worktree      Tool
           │           │           │
           └───────────┼───────────┘
                       │
                Structured Result
                       │
                    Review
                       │
                    Output
```

这条路线能最大程度发挥当前 jojo 已经做好的：

```text
DAG
Scheduler
Journal
Resume
Contracts
```

而不是推倒已有设计重新追随另一个项目。

---

# 42. 推荐立即开始的代码改动

第一轮建议只动下面这些文件：

```text
packages/contracts/src/orchestration.ts

packages/orchestration/src/subagent/
├── manager.ts
├── tools.ts
├── types.ts
├── profile-registry.ts      # new
└── tool-policy.ts           # new
```

第一轮完成目标：

```text
explore
general
synthesize
code-review
```

四个 Profile。

同时：

```text
profile → tools → readOnly → model
```

真正进入：

```text
LeafAgentRunRequest
```

这一阶段**先不要碰 DAG Engine 主逻辑**。

等 Sub-Agent Runtime 稳定以后，再开始 Workflow V2。

这会是风险最低、收益最高的演进路径。

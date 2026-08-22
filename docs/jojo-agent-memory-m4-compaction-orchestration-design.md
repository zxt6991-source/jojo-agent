# Jojo Agent Memory M4：Compaction 与 Orchestration 技术设计

> 文档版本：v1.0  
> 阶段：Memory M4  
> 前置条件：M0–M3 已完成  
> 目标项目：`zxt6991-source/jojo-agent`  
> 上位设计：`jojo-agent-memory-final-design.md` v1.1  
> 状态：可进入实现

---

# 1. 阶段目标

M4 不增加新的“记忆类型”，重点解决长期 Memory 在长 Session、Crash Resume、Sub-Agent、Workflow、Worktree 场景下的**一致性与可复现性**。

M4 需要完成四件事：

1. Compaction 前生成确定性的 Memory Handoff；
2. Compaction 检查 Memory Scope Version，并在必要时刷新 Session Snapshot；
3. Sub-Agent / Workflow 使用明确、冻结、可追踪的 Memory Snapshot；
4. Worktree 只改变文件执行目录，不改变 Project Memory Scope。

最终目标：

```text
长 Session
+ Compaction
+ Crash Resume
+ Sub-Agent
+ Workflow
+ Worktree
        ↓
Memory 仍然：
一致
可恢复
无重复副作用
可解释
可复现
```

---

# 2. 前置条件

M4 假设 M0–M3 已经提供：

```text
ProjectIdentity
MemoryRuntime Port
MemorySnapshotEntry
MemoryRecallEntry
ambientContext
Markdown Store
Global / Project Scope
Session-stable Snapshot
memory_read / search / write / forget / restore
expectedHash / OCC
FTS5
Always / Triggered Rules
```

M4 不重新设计这些能力。

---

# 3. 当前问题

## 3.1 Compaction 与 Memory 生命周期不同

Conversation Compaction 解决：

```text
当前 Session 上下文过长
```

Long-Term Memory 解决：

```text
未来 Session 仍需知道什么
```

二者不能合并为同一个摘要器。

正确关系：

```text
Conversation History
       ↓
Compaction Summary
       ↓
当前 Session Continuation

Long-Term Memory
       ↓
Stable Snapshot
       ↓
跨 Session Durable Context
```

但是它们必须在 Compaction Checkpoint 协同，否则可能丢失：

- 当前未完成任务；
- 本 Session 新确认但尚未进入旧 Snapshot 的 Memory；
- 刚写入 Scratchpad / Daily 的状态；
- Workflow / Sub-Agent 正在继续使用的 Snapshot 版本。

## 3.2 Session-Stable Snapshot 会自然变旧

Session 第一次模型请求时：

```text
Project Scope Version = 21
Snapshot Scope Version = 21
```

Session 内发生 Memory Write：

```text
Project Scope Version = 22
```

按照 M0–M3 的设计，普通 Turn 不立即刷新 System Prefix。

因此：

```text
Snapshot = 21
Current Memory = 22
```

这是允许的。

但当 Compaction 本身已经要重建上下文前缀时，应当利用这个自然检查点刷新 Snapshot。

## 3.3 Workflow 不能在运行中漂移

如果 Workflow Step A、B、C 在不同时间读取“最新 Memory”：

```text
Step A → Snapshot 10
Memory 更新
Step B → Snapshot 11
Memory 更新
Step C → Snapshot 12
```

同一次 Workflow Run 的行为将不可复现。

因此 Workflow 必须：

```text
Workflow Start
      ↓
Freeze memorySnapshotId
      ↓
All Agent Steps reuse it
```

## 3.4 Worktree 不能创建新的 Memory Project

Writable Sub-Agent 可能运行在：

```text
/tmp/jojo-worktrees/xxx
```

这个路径只是执行隔离目录。

Memory Project Identity 必须仍然是：

```text
Parent Session ProjectIdentity
```

---

# 4. 总体架构

```text
                         Main Session
                              │
                              ▼
                    MemorySnapshotEntry
                              │
                     snapshotId / hash
                              │
             ┌────────────────┼─────────────────┐
             │                │                 │
             ▼                ▼                 ▼
        Main Agent        Sub-Agent         Workflow Run
             │                │                 │
             │          inherited scope    frozen snapshot
             │                │                 │
             └────────────────┼─────────────────┘
                              │
                              ▼
                         Compaction
                              │
                  ┌───────────┴───────────┐
                  │                       │
                  ▼                       ▼
          Deterministic Handoff     Scope Version Check
                  │                       │
                  ▼                       ▼
             daily / durable         refresh snapshot?
                  │                       │
                  └───────────┬───────────┘
                              ▼
                    Compaction Summary
```

---

# 5. Compaction 接口扩展

```ts
export type MemoryCompactInput = {
  sessionId: string;
  operationId: string;
  lane: string;

  currentSnapshotId: string;
  projectIdentity?: ProjectIdentity;

  messagesToSummarize: Message[];
  retainedTail: Message[];

  previousCompactionSummary?: string;

  memoryToolEvents: Array<{
    toolCallId: string;
    toolName:
      | 'memory_write'
      | 'memory_forget'
      | 'memory_restore';
    scope: 'global' | 'project';
    entryId?: string;
    result: 'success' | 'failed';
  }>;

  signal: AbortSignal;
};
```

输出：

```ts
export type MemoryCompactResult = {
  handoff?: MemoryHandoff;
  refreshSnapshot: boolean;
  currentScopeVersions: Record<string, number>;
  warnings?: MemoryWarning[];
};
```

Handoff：

```ts
export type MemoryHandoff = {
  id: string;
  sessionId: string;
  operationId: string;

  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
  memoryWrites: MemoryHandoffItem[];

  createdAt: number;
};

export type MemoryHandoffItem = {
  text: string;
  source:
    | 'scratchpad'
    | 'memory_tool'
    | 'compaction'
    | 'runtime';
  sourceEntryId?: string;
};
```

---

# 6. 为什么 Handoff 必须确定性生成

M4 MVP 不为 Handoff 再调用一次 LLM。

原因：

1. Compaction 本身已经可能调用 utility model；
2. Memory Handoff 是运行时一致性机制，不应依赖模型质量；
3. Crash Resume 时需要 Exactly-Once / Idempotent；
4. 同样的 durable state 应得到同样的 Handoff；
5. 避免额外 Token、延迟和 Provider 失败。

因此优先从结构化数据提取：

```text
SCRATCHPAD
+
memory_write / forget / restore tool events
+
已有 Compaction metadata
+
Runtime operation state
```

---

# 7. Handoff 内容边界

Handoff 只保留三类内容：

## 7.1 Open Tasks

例如：

```text
- FTS5 中文 fallback 尚未补 Windows E2E。
- 当前 Workflow 仍等待 review step。
```

来源优先：

```text
SCRATCHPAD
Runtime Operation State
Workflow incomplete state
```

## 7.2 Decisions

只保存本 Session 已明确产生、且未来仍可能需要的决策引用。

如果 Decision 已经通过 `memory_write` 正式写入长期 Memory，Handoff 不复制完整正文，只记录引用：

```text
- 已写入 mem_01ABC：Revision 使用 SHA-256。
```

## 7.3 Memory Writes

记录本 Compaction 区间发生过的 Memory Mutation：

```text
mem_01ABC written
mem_01DEF forgotten
mem_01XYZ restored
```

---

# 8. Handoff 存储

Handoff 有两种载体，职责不同。

## 8.1 Runtime Durable Entry

建议新增：

```ts
export type MemoryHandoffEntry = EntryBase & {
  type: 'memory_handoff';

  handoffId: string;
  compactionOperationId: string;

  openTasks: MemoryHandoffItem[];
  decisions: MemoryHandoffItem[];
  memoryWrites: MemoryHandoffItem[];

  contentHash: string;
};
```

用途：

```text
Exactly-once
Crash Resume
Runtime Timeline
可测试性
```

它属于 Session Runtime，不等于 Long-Term Memory。

## 8.2 Project Daily

若存在 Project Scope，可将简化版追加到：

```text
~/.jojo/memory/projects/<project>/daily/YYYY-MM-DD.md
```

用途：

```text
人类可读
后续 Session 可按需检索
最近 handoff 可进入 Snapshot
```

Daily 写入属于：

```text
Trusted Runtime Internal Write
```

只能写 `daily/`，不能修改 `MEMORY.md rules`、`topics/` 或 `confirmed status`。

---

# 9. Handoff 幂等键

定义：

```text
handoffId =
  hash(
    sessionId
    + compactionOperationId
    + lane
    + compactionOrdinal
  )
```

Runtime Store 在执行前检查：

```text
MemoryHandoffEntry(handoffId) exists?
```

存在则 reuse，不得再次追加 Daily。

推荐 job dedupe key：

```text
memory_handoff:<handoffId>
```

---

# 10. Compaction 时序

```text
Context Manager 决定需要 Compaction
        │
        ▼
PreCompact observational Hooks
        │
        ▼
MemoryRuntime.beforeCompact()
        │
        ├── load current snapshot
        ├── read scope versions
        ├── build deterministic handoff
        └── decide refreshSnapshot
        │
        ▼
Persist MemoryHandoffEntry
        │
        ▼
Append project daily（若需要，幂等）
        │
        ▼
scope version changed?
   ┌────┴─────┐
   │          │
  YES         NO
   │          │
   ▼          │
build new     │
snapshot      │
   │          │
append        │
MemorySnapshotEntry
   │          │
   └────┬─────┘
        ▼
Normal Compaction Summary
        │
        ▼
Retained Tail + New Ambient Snapshot
```

---

# 11. Snapshot Refresh 判定

当前 Snapshot：

```ts
scopeVersions: {
  global: 8,
  project: 21,
}
```

当前 Memory：

```ts
{
  global: 8,
  project: 22,
}
```

则：

```ts
refreshSnapshot = true;
```

规则：

```text
任一参与 Snapshot 的 Scope Version 变化 → refresh
Project Scope 被删除/禁用            → refresh
Global Memory 开关变化              → refresh
仅 FTS index rebuild                → 不 refresh
Candidate pending 变化              → 不 refresh
Recovery retention cleanup          → 不 refresh
```

---

# 12. Snapshot Refresh 必须产生新 Durable Entry

禁止原地修改旧 `MemorySnapshotEntry`。

必须：

```text
Snapshot #1
    ↓
Compaction
    ↓
Snapshot #2
```

例如：

```ts
{
  id: "memory_snapshot:sess_1:2",
  refreshedBy: "compaction",
}
```

这样可以保留 Session 在不同阶段到底看到了哪一版 Memory。

---

# 13. Context Projection

Context Builder 使用：

```text
当前 Lane 上最新有效 MemorySnapshotEntry
```

而不是 Memory Store 最新版本。

伪代码：

```ts
const snapshot = findLatestSnapshotOnLane(entries);

ambientContext.push({
  source: 'memory',
  content: snapshot.content,
  stable: true,
  estimatedTokens: snapshot.estimatedTokens,
});
```

---

# 14. Sub-Agent Memory Policy

| 执行主体 | Ambient Memory | Search/Read | Mutation |
|---|---|---|---|
| Main Agent | Global + Project | Allow | Approval |
| `explore` | Project Rules + Project Index | Allow | Deny |
| `code-review` | Project Rules + Project Index | Allow | Deny |
| `synthesize` | 默认不隐式给完整 Global Memory | 可选 | Deny |
| `general` | Project Rules + Project Index | Allow | Deny |
| Background Agent | 精简 Project | Allow | Hard Deny |

关键原则：

```text
Sub-Agent 不自动获得完整 Global Memory
```

---

# 15. Sub-Agent Snapshot

创建 Child 时记录：

```ts
export type SubAgentMemoryBinding = {
  projectIdentity?: ProjectIdentity;

  parentSnapshotId: string;
  childSnapshotId: string;

  mode:
    | 'project-minimal'
    | 'none';
};
```

推荐不是直接复用完整 Parent Snapshot 文本，而是基于 Parent 已冻结的 Scope Version 生成精简 Child Snapshot。

精简 Snapshot 必须记录：

```text
derivedFromSnapshotId
```

---

# 16. `sub_agent_send` 的 Memory 语义

Continuation 必须继续使用原 `childSnapshotId`。

不能因为主 Session Memory 更新而自动重建 Child Snapshot。

只有显式 restart child 才能创建新 Snapshot。

---

# 17. Workflow Memory Binding

Workflow Run 新增：

```ts
export type WorkflowMemoryBinding = {
  projectIdentity?: ProjectIdentity;

  memorySnapshotId: string;
  contentHash: string;
  scopeVersions: Record<string, number>;

  createdAt: number;
};
```

在 `workflow_start` 时创建。

整个 Workflow Run 所有 Agent Step 使用同一个 Binding。

---

# 18. Workflow Resume

恢复 Workflow 时禁止重新取最新 Memory。

必须读取 Journal 中：

```text
memorySnapshotId
contentHash
scopeVersions
```

如果 Durable Snapshot 丢失：

```text
workflow_memory_snapshot_missing
```

Workflow 进入：

```text
suspended/manual_recovery_required
```

不要静默用最新 Memory 替换。

---

# 19. Workflow Retry / Sub-Workflow / Tool Step

同一个 Step Retry 必须使用相同 `memorySnapshotId`。

Sub-Workflow 默认继承 Parent Memory Binding；M4 不支持跨项目 Scope Override。

Workflow Tool Step 默认无隐式 Memory Snapshot。若需要 Memory 数据，必须显式引用。Mutation Tool Step 在 M4 hard deny。

---

# 20. Worktree Scope

```ts
executionDirectory = "/tmp/jojo-worktrees/abc";
projectIdentity.canonicalPath = "/repo/jojo-agent";
```

Memory 查询使用 `projectIdentity.id`，文件工具使用 `executionDirectory`。

禁止在子 Agent / Workflow Step 中：

```ts
resolveMemoryScope(process.cwd())
```

---

# 21. Memory 与 Scheduler

Memory Snapshot 解析和本地 Memory Search 不占 AgentExecutionScheduler 的 LLM Slot。

未来远程 Semantic Backend 使用独立 Embedding Semaphore，由 M6 定义。

---

# 22. 错误语义

新增：

```text
memory_handoff_failed
memory_handoff_conflict
memory_snapshot_binding_missing
workflow_memory_snapshot_missing
memory_scope_version_invalid
```

降级：

```text
Handoff Daily 写失败
    → warning，Compaction 继续

Snapshot refresh 失败
    → 继续使用旧 Snapshot + warning

Workflow frozen snapshot 丢失
    → Workflow suspend，不静默替换
```

---

# 23. 可观测事件

```text
memory.handoff.started
memory.handoff.completed
memory.handoff.reused
memory.handoff.failed

memory.snapshot.refresh.requested
memory.snapshot.refreshed

memory.subagent.bound
memory.workflow.bound
memory.workflow.binding.restored
```

日志不记录 Memory 正文。

---

# 24. UI

Runtime Timeline：

```text
Compaction
  ├─ Memory Handoff: mhf_xxx
  └─ Snapshot Refresh: 21 → 22
```

WorkflowCard：

```text
Memory Snapshot
  id: ...
  project version: 22
  global version: 8
  frozen: yes
```

Sub-Agent 详情：

```text
Memory Mode: project-minimal
Derived From: snapshot_xxx
```

---

# 25. 代码改动

```text
packages/agent-runtime/
  session/types.ts
    + MemoryHandoffEntry

  context/
    + latest snapshot projection

  harness/runner.ts
    + compaction memory checkpoint

packages/memory/
  compaction/
    handoff.ts
    extractor.ts
    refresh-policy.ts

  orchestration/
    subagent-binding.ts
    workflow-binding.ts

packages/orchestration/
  subagent/
    + memory binding

  workflow/
    journal types
    restore/resume
    step execution context

apps/desktop/
  Worker wiring
  Timeline / WorkflowCard fields
```

---

# 26. 测试

Compaction：

```text
无 Memory Write → 不刷新 Snapshot
Memory Version 变化 → 刷新一次
Crash after handoff before compaction → Resume 不重复 Daily
Crash after snapshot refresh → Resume 复用新 Snapshot
Handoff Daily 失败 → Compaction 继续
```

Sub-Agent：

```text
Child 继承 Parent ProjectIdentity
Child 不按 Worktree path 建新 scope
Child 不获得完整 Global Memory
sub_agent_send 保持相同 childSnapshotId
Child mutation hard deny
```

Workflow：

```text
Workflow Start 冻结 snapshot
所有 Step 同 snapshot
Retry 同 snapshot
Resume 同 snapshot
Memory 更新不影响运行中 Workflow
Snapshot 丢失时 suspend
```

---

# 27. 验收标准

M4 完成必须满足：

1. Compaction 前能生成确定性 Handoff；
2. Handoff Crash Resume 不重复；
3. Scope Version 变化时 Compaction 能刷新 Snapshot；
4. 普通 Turn 不刷新 Snapshot；
5. Sub-Agent 使用稳定 ProjectIdentity；
6. Worktree 不产生新的 Project Memory；
7. `sub_agent_send` 不漂移 Snapshot；
8. Workflow Run 全过程冻结同一 Snapshot；
9. Workflow Resume 使用原 Snapshot；
10. Background Agent 无 Memory Mutation；
11. Memory M4 故障除冻结 Snapshot 丢失外，不拖垮正常任务。

---

# 28. 一句话结论

> **M4 的核心不是“让 Compaction 自动写更多 Memory”，而是把 Memory Snapshot、Compaction Handoff、Sub-Agent 和 Workflow 绑定到 Jojo 的 Durable Runtime，使长任务在压缩、重启、重试和 Worktree 隔离后仍保持同一套可复现的记忆语义。**

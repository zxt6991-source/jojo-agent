# Jojo Agent Memory 最终技术设计

> 文档版本：v1.1  
> 状态：Final / 可进入开发  
> 目标项目：`zxt6991-source/jojo-agent`  
> 适用范围：Jojo Agent 跨 Session 长期记忆系统  
> 参考设计：Pi / pi-memory、Octo Agent，以及 Jojo Agent 当前 Durable Runtime / Hooks / Orchestration 架构

---

# 1. 背景

Jojo Agent 当前已经具备：

- Session 持久化；
- Session Entry Tree；
- Lane / Operation；
- Crash Resume；
- Compaction；
- Context Projection；
- Hooks；
- Permission Gate；
- Sub-Agent；
- Workflow；
- Worktree Isolation；
- SQLite Runtime Store。

这些能力解决的是：

```text
“当前 Session 如何继续？”
```

但没有解决：

```text
“新的 Session 如何知道以前确认过的用户偏好、项目决策、项目约束和踩坑经验？”
```

因此需要增加独立的 Long-Term Memory。

必须明确：

```text
Session History
    ≠
Compaction Summary
    ≠
Long-Term Memory
```

其中：

| 数据 | 作用 |
|---|---|
| Session History | 记录一个 Session 中真实发生过的事情 |
| Compaction Summary | 当前 Session 上下文过长后的连续性压缩 |
| Long-Term Memory | 不同 Session 之间共享的长期信息 |

Long-Term Memory 不保存第二份完整聊天历史。

---

# 2. 总体设计结论

Jojo Memory 采用三层设计：

```text
┌──────────────────────────────────────────────┐
│ Layer 1：Session Context                     │
│                                              │
│ SessionEntry / Lane / Operation / Compaction │
│                                              │
│ 已存在于 agent-runtime                      │
└──────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│ Layer 2：Curated Durable Memory              │
│                                              │
│ Markdown Source of Truth                     │
│ Global Memory + Project Memory               │
│                                              │
│ 新增 packages/memory                         │
└──────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────┐
│ Layer 3：Retrieval Projection                │
│                                              │
│ node:sqlite + FTS5                           │
│ Optional Semantic Retrieval                  │
│                                              │
│ 可删除、可重建                               │
└──────────────────────────────────────────────┘
```

核心原则：

1. Markdown 是 Memory 唯一权威数据源。
2. SQLite、FTS、Embedding 都只是可重建索引。
3. Global + Project 两级作用域。
4. Memory 默认存储在 `~/.jojo/memory/`，不写入项目仓库。
5. 新增独立 `packages/memory`。
6. `agent-runtime` 只定义 `MemoryRuntime` Port。
7. Memory Snapshot 按 Session 冻结。
8. Memory 修改必须走专用 Memory Tool。
9. Mutation 默认需要用户审批。
10. Main Agent 可申请修改 Memory。
11. Sub-Agent / Workflow 默认只读。
12. 不静默自动学习。
13. Forget 是真正删除，而不是追加“旧信息失效”。
14. 删除必须支持 Recovery。
15. MVP 使用 `node:sqlite` FTS5，不引入向量数据库。
16. Memory 故障不得导致正常 Agent Task 失败。

---

# 3. 非目标

第一版不实现：

```text
完整对话向量化
代码仓库全文 embedding
自动保存每轮聊天
自动推断用户画像
模型自动确认长期规则
后台 Agent 自动修改 Memory
跨设备 Cloud Memory
Memory Knowledge Graph
```

Semantic Retrieval 可以后续作为可选能力加入，但不能成为 Memory 的唯一实现。

---

# 4. Memory 与其他能力的边界

## 4.1 Memory 与 Skill

Skill 保存：

```text
如何做一类事情
```

例如：

```text
如何发布 npm package
如何生成 GitHub Release
如何分析 Yocto 编译问题
```

Memory 保存：

```text
这个用户/这个项目以前确定了什么
```

例如：

```text
该项目只能使用 pnpm。
发布之前必须先 build native addon。
用户希望 Go 示例同时解释和 C 的差异。
```

## 4.2 Memory 与项目文档

如果事实已经清晰存在于：

```text
README
docs/
package.json
代码
Git History
```

一般不应该重复存入 Memory。

Memory 更适合保存：

```text
为什么这么设计
踩过什么坑
哪些方案已经被验证失败
用户明确偏好
项目约束
非显然环境信息
```

## 4.3 Memory 与 Hook

Hook：

```text
生命周期自动化机制
```

Memory：

```text
长期知识与规则
```

Hook 可以：

```text
提醒 Agent 考虑是否保存 Memory
触发 Triggered Rule 检查
观察 Memory 事件
```

但 Shell Hook 不得直接获得 Memory Store 写权限。

长期 Memory 是 Runtime 的受信任内置能力。

---

# 5. 包架构

新增：

```text
packages/memory/
```

推荐目录：

```text
packages/memory/
├── src/
│   ├── index.ts
│   ├── runtime.ts
│   ├── identity.ts
│   │
│   ├── store/
│   │   ├── markdown-store.ts
│   │   ├── parser.ts
│   │   └── atomic-writer.ts
│   │
│   ├── snapshot/
│   │   ├── builder.ts
│   │   └── budget.ts
│   │
│   ├── recall/
│   │   ├── trigger-matcher.ts
│   │   └── ranking.ts
│   │
│   ├── recovery/
│   │   └── recovery.ts
│   │
│   ├── security/
│   │   ├── secret-scanner.ts
│   │   ├── path-guard.ts
│   │   └── sanitizer.ts
│   │
│   ├── tools/
│   │   ├── status.ts
│   │   ├── read.ts
│   │   ├── search.ts
│   │   ├── write.ts
│   │   ├── forget.ts
│   │   └── restore.ts
│   │
│   ├── candidates/
│   │   └── extractor.ts
│   │
│   └── hooks/
│       └── save-nudge.ts
│
└── test/
```

---

# 6. 依赖方向

推荐：

```text
                 contracts
                 ↑   ↑   ↑
                 │   │   │
        agent-runtime │ memory
                 ↑    │   ↑
                 │  storage
                 │    ↑
                 └─ desktop worker
                         ↑
                    orchestration
```

约束：

- `agent-runtime` 不依赖 `packages/memory` 实现。
- `packages/memory` 不依赖 Electron。
- `packages/storage` 不反向依赖 `packages/memory`。
- Renderer 不直接访问 Memory 文件。
- `tools-node` 不允许通过普通 file tool 修改 Memory Root。
- Shell Hook 不获取 MemoryStore。

共享的 Memory Types、Memory Catalog Interfaces、Zod Schemas、IPC Contracts 放入 `packages/contracts`。

---

# 7. Memory Scope

Memory 只设计两级作用域：

```text
Global
Project
```

## 7.1 Global Memory

所有 Session 可继承。

适合：

- 用户长期偏好；
- 语言偏好；
- 通用工作习惯；
- 通用 Agent 协作规则；
- 跨项目工具偏好。

## 7.2 Project Memory

仅属于一个项目。

适合：

- 项目架构；
- 长期设计决策；
- 项目固定约束；
- 构建/发布踩坑；
- 环境特殊行为；
- 经过验证的失败方案。

---

# 8. ProjectIdentity

不能直接使用：

```ts
process.cwd()
```

因为 Writable Sub-Agent 会进入临时 Worktree，但它仍然属于原项目。

定义：

```ts
export type ProjectIdentity = {
  id: string;
  displayName: string;
  canonicalPath: string;
};
```

生成方式：

```text
Session selected workingDirectory
        ↓
realpath
        ↓
canonicalPath
        ↓
sha256(platform + NUL + canonicalPath)
        ↓
projectId
```

规则：

1. ProjectIdentity 在 Session 创建时确定。
2. 保存进 Durable Session Metadata。
3. 同时保存进 Session JSONL Meta。
4. Sub-Agent 继承父 Session 的 ProjectIdentity。
5. Workflow 继承启动 Session 的 ProjectIdentity。
6. Worktree 不重新计算 ProjectIdentity。
7. 不要求当前目录是 Git Repository。
8. canonicalPath 无法解析时，仅禁用 Project Memory。
9. Global Memory 仍然可用。
10. 项目目录移动后默认视为新项目。

---

# 9. 文件存储

Memory Root：

```text
~/.jojo/memory/
```

结构：

```text
~/.jojo/memory/
├── global/
│   ├── MEMORY.md
│   ├── SCRATCHPAD.md
│   ├── topics/
│   ├── daily/
│   └── recovery/
│
└── projects/
    └── jojo-agent--prj_xxx/
        ├── scope.json
        ├── MEMORY.md
        ├── SCRATCHPAD.md
        ├── topics/
        ├── daily/
        └── recovery/
```

---

# 10. MEMORY.md 的定位

`MEMORY.md` 不是无限增长的日志。

它应该是：

```text
Index
+
Important Facts
+
Rules
+
Pointers
```

详细内容进入 `topics/`，短期未完成事项进入 `SCRATCHPAD.md`，Compaction / Session Handoff 可以进入 `daily/`。

推荐限制：

```text
MEMORY.md <= 25 KiB
```

或者约：

```text
<= 200～300 行
```

---

# 11. Memory Entry 类型

```ts
export type MemoryKind =
  | 'preference'
  | 'constraint'
  | 'decision'
  | 'fact'
  | 'lesson'
  | 'procedure'
  | 'task'
  | 'rule';
```

这些 Type 用于检索、UI、排序、触发与治理；Markdown 仍然是事实源。

---

# 12. MEMORY.md Metadata

推荐使用 Markdown comment 保存 Metadata：

```markdown
## Always Apply Rules

<!-- jojo-memory
id: mem_01ABC
kind: rule
status: confirmed
createdAt: 2026-08-22T08:30:00Z
sourceSessionId: sess_123
-->
- 项目使用 pnpm，不允许生成 package-lock.json。
```

要求：

- `id` 永不复用；
- 编辑正文不修改 `id`；
- metadata 使用受限 YAML；
- metadata 使用 Zod 校验；
- 单 Entry 解析失败不影响整份 `MEMORY.md`；
- 未知字段保留但不执行。

---

# 13. Rule 的特殊安全语义

Rule 分两种：

```text
Always Rule
Triggered Rule
```

规则必须：

```text
status = confirmed
```

才能真正生效。

`confirmed` 只能由用户操作产生。Agent 不允许自行设置 `status: confirmed`。

---

# 14. Source of Truth 与 SQLite

权威数据：

```text
Markdown
+
Recovery JSON
```

派生数据：

```text
memory.sqlite
```

Desktop 默认：

```text
<electron-userData>/runtime/memory.sqlite
```

具体路径由 `MemoryRootResolver` 注入。

---

# 15. SQLite 设计

使用 Jojo 已经使用的 Node 22 `node:sqlite`，不要新增 `better-sqlite3`。

基础 Schema：

```sql
CREATE TABLE memory_scopes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('global', 'project')),
    canonical_path TEXT,
    display_name TEXT NOT NULL,
    content_version INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY,
    scope_id TEXT NOT NULL
        REFERENCES memory_scopes(id)
        ON DELETE CASCADE,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_session_id TEXT,
    source_operation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_fts
USING fts5(
    entry_id UNINDEXED,
    scope_id UNINDEXED,
    title,
    content,
    tags,
    tokenize = 'trigram'
);
```

---

# 16. SQLite 一致性原则

```text
Markdown → Canonical
SQLite   → Projection
```

写入顺序：

```text
生成新 Markdown
      ↓
写同目录 tmp
      ↓
fsync / close
      ↓
atomic rename
      ↓
更新 SQLite
```

如果 Markdown 成功但 SQLite 更新失败，则把 scope 标记为 dirty，后续 rebuild。

SQLite 可以重建，Markdown 不能丢。

---

# 17. Revision、并发控制与原子写入

这一节定义 Memory Mutation 的并发一致性模型。

Jojo Memory 允许多个 Session、多个窗口、用户手工编辑器以及未来其他前端同时读取 Memory，因此不能假设 Memory 永远只有一个写者。

最终采用：

```text
Optimistic Concurrency Control
+
Content Hash Revision
+
Exact Patch Guard
+
Per-Scope Local Write Queue
+
Atomic File Replace
```

其核心目标是避免：

```text
Lost Update
```

即“后写入者把先写入者已经完成的修改静默覆盖”。

## 17.1 为什么必须做并发控制

假设两个 Session 同时读取：

```text
MEMORY.md revision = abc123
```

内容：

```markdown
## Architecture

- Runtime 不依赖 Electron。
```

Session A 增加：

```markdown
- Memory 使用 Markdown 作为 Source of Truth。
```

A 成功写入后：

```text
revision = def456
```

Session B 仍然基于旧的 `abc123` 修改，并准备加入：

```markdown
- 使用 node:sqlite。
```

如果 B 直接覆盖整个文件，A 的修改会丢失。

因此 Jojo 不采用：

```text
Last Write Wins
```

而采用乐观并发控制。

## 17.2 Revision 定义

每个 Memory Document 都携带 Revision：

```ts
export type MemoryDocument = {
  path: string;
  content: string;
  revision: string;
  updatedAt: number;
};
```

Revision 定义为：

```text
revision = sha256(file bytes)
```

必须对实际写入磁盘的原始文件字节计算 Hash，而不是对解析后的对象重新序列化后计算。

原因：

- Markdown 是 Source of Truth；
- 用户可能直接用 VSCode / vim 修改文件；
- 外部修改不经过 SQLite；
- 内容变化会自然产生新的 Revision；
- 不需要维护额外的数据库版本号作为并发真相。

因此：

```text
content_hash
```

才是文件并发控制的权威版本。

## 17.3 为什么不只使用递增版本号

简单版本号：

```text
1 → 2 → 3
```

无法可靠发现绕过 Jojo 的外部修改。

例如数据库仍记录：

```text
version = 10
```

但用户已经手工编辑 `MEMORY.md`。

如果 Revision 使用内容 SHA-256，则下一次真正写入前重新读取文件即可发现变化。

所以：

```text
Content Hash = 写并发控制
Scope Version = Runtime Snapshot 版本
```

二者不得混用。

## 17.4 Read → Modify → Write 协议

读取：

```ts
const doc = await memory.read(...);
```

返回：

```ts
{
  path: "MEMORY.md",
  content: "...",
  revision: "abc123",
}
```

Agent 基于该内容生成修改后，写入请求必须带：

```ts
expectedHash: "abc123"
```

语义是：

> 这次修改是基于 `abc123` 生成的；只有磁盘当前仍然是 `abc123` 时才允许应用。

Store 执行：

```text
read current file
      ↓
sha256(current bytes)
      ↓
currentHash == expectedHash ?
      ├── yes → apply mutation
      └── no  → memory_conflict
```

## 17.5 文件级 CAS

该机制本质上是文件级 Compare-And-Swap：

```c
if (current == expected) {
    current = new_value;
    return SUCCESS;
}

return CONFLICT;
```

Memory 对应：

```text
if sha256(currentFile) == expectedHash:
    applyPatch()
else:
    return memory_conflict
```

因此每次 Mutation 都必须基于一个明确读版本。

## 17.6 Exact Patch Guard

除了文件级 Revision，还应校验具体修改目标。

推荐 Mutation 优先使用：

```ts
{
  oldText: "...",
  newText: "...",
  expectedHash: "abc123"
}
```

执行前同时检查：

```text
1. currentHash == expectedHash
2. oldText 存在
3. oldText 在目标范围内唯一匹配
```

这形成两层保护：

```text
File Revision Guard
        +
Exact Patch Guard
```

Revision 防止“文件整体已变化仍继续修改”。

Exact Patch 防止“虽然文件版本正确，但具体修改目标与 Agent 预期不一致”。

如果 `oldText`：

- 不存在；
- 出现多次且无法唯一确定；
- metadata block 已变化；

均返回 `memory_conflict` 或更具体的 `memory_patch_conflict`。

MVP 可以统一为 `memory_conflict`，并附 `reason`。

## 17.7 为什么避免整文件覆盖

Memory Tool 不应默认让模型返回完整的新 `MEMORY.md` 并覆盖旧文件。

优先级建议：

```text
Exact Entry Update
    >
Exact Text Patch
    >
Anchor Append
    >
Whole File Replace
```

整文件替换只用于：

- 新建文件；
- Import；
- 用户明确要求覆盖；
- Recovery 确认恢复。

普通 Agent 更新应尽可能针对单个 Entry 或局部文本。

## 17.8 冲突处理

如果：

```text
expectedHash != actualHash
```

返回：

```ts
{
  code: "memory_conflict",
  expectedRevision: "abc123",
  actualRevision: "def456",
}
```

Agent 不得自动忽略冲突。

正确流程：

```text
memory_conflict
      ↓
memory_read latest
      ↓
重新理解最新内容
      ↓
重新生成 patch / diff
      ↓
重新展示审批
      ↓
memory_write(expectedHash = latest)
```

特别注意：

不能：

```text
冲突
 ↓
重新读
 ↓
直接拿旧的 wholeContent 再覆盖
```

因为旧输出仍然是基于旧文档生成的。

必须重新计算 Mutation。

## 17.9 用户手工编辑的处理

如果 Agent 读取：

```text
revision = abc
```

之后用户通过：

```text
VSCode
vim
外部脚本
另一个 Jojo 进程
```

修改了文件，则当前真实 Hash 变为：

```text
revision = def
```

Agent 再提交 `expectedHash = abc` 时必须得到 `memory_conflict`。

因此 Revision 机制天然覆盖：

- 多 Session；
- 多窗口；
- 外部编辑器；
- 外部脚本；
- 多 Jojo 进程。

## 17.10 Approval 后必须再次校验 Revision

Approval 不是锁。

典型时序：

```text
T0 Agent 读取 rev=abc
T1 Agent 生成 Diff
T2 UI 显示 Approval
T3 用户等待 20 秒
T4 另一个 Session 写入 rev=def
T5 用户点击 Approve
```

因此真正执行 Mutation 时必须再次：

```text
read file
  ↓
calculate currentHash
  ↓
compare expectedHash
```

不能只在 Approval UI 打开前检查。

即：

```text
Approval
   ≠
Concurrency Lock
```

Revision 的最终检查必须发生在 Store 真正应用 Mutation 之前。

## 17.11 TOCTOU 控制

为了减少：

```text
Time Of Check
Time Of Use
```

竞争窗口，Revision 校验必须放在靠近实际写入的位置：

```text
Renderer
   ↓
IPC
   ↓
Worker
   ↓
Permission Gate
   ↓
Scope Write Queue
   ↓
MemoryStore
   ↓
read current
   ↓
hash compare
   ↓
apply patch
   ↓
atomic replace
```

不要在 Renderer 校验后就认为安全。

Renderer 中的 revision 仅用于展示和 optimistic concurrency token。

真正安全边界在 Memory Store。

## 17.12 Per-Scope Write Queue

建议每个 Memory Scope 在当前进程维护串行写队列。

例如：

```text
global
project A
project B
```

分别串行。

伪代码：

```ts
await scopeWriteQueue.run(scopeId, async () => {
  // read
  // compare revision
  // apply patch
  // atomic write
  // update index
});
```

目的：

- 避免同一进程多个 Mutation 同时 rename；
- 让 SQLite projection 更新顺序稳定；
- 简化 recovery / dirty state；
- 减少内部 TOCTOU 窗口。

但是：

```text
Write Queue 不能替代 Revision
```

因为 Queue 无法控制：

- 另一个进程；
- VSCode；
- vim；
- 外部脚本。

所以最终采用：

```text
Process-local Write Queue
+
File Hash CAS
+
Atomic Rename
```

## 17.13 Atomic Write

Revision 解决“别人改了我还继续覆盖”。

Atomic Write 解决“我自己写到一半进程崩溃”。

两者是不同问题。

写文件必须：

```text
build new content in memory
      ↓
write target.tmp in same directory
      ↓
fsync / close
      ↓
rename(target.tmp, target)
```

不要直接：

```text
open MEMORY.md
truncate
write
```

否则进程在中间崩溃时可能留下半份 Markdown。

临时文件必须与目标文件处于同一目录，以最大化 rename 原子性保证。

## 17.14 Mutation 完整执行顺序

最终标准流程：

```text
Memory Mutation Request
        │
        ▼
Permission / Safety Validation
        │
        ▼
Per-Scope Write Queue
        │
        ▼
Read Current Markdown
        │
        ▼
SHA256(Current Bytes)
        │
        ▼
Compare expectedHash
   ┌────┴────┐
   │         │
 match     mismatch
   │         │
   ▼         ▼
Exact      memory_conflict
Patch
Check
   │
   ▼
Build New Content
   │
   ▼
Write Temp File
   │
   ▼
fsync / close
   │
   ▼
Atomic Rename
   │
   ▼
Compute New Hash
   │
   ▼
Increment Scope Version
   │
   ▼
Update SQLite Projection
   │
   ├── success → complete
   │
   └── failure → mark scope dirty → rebuild later
```

## 17.15 SQLite 更新失败时的语义

Markdown 写成功后，如果 SQLite 更新失败：

```text
不能回滚 Markdown
```

因为 Markdown 是 Source of Truth。

正确做法：

```text
Markdown success
SQLite failure
      ↓
scope dirty = true
      ↓
memory.index_stale warning
      ↓
rebuild later
```

下次启动、文件 watcher、`memory_status` 或显式 `rebuildIndex()` 都可以恢复索引。

## 17.16 `content_hash` 与 `content_version`

SQLite 中建议同时保留：

```text
content_hash
content_version
```

两者职责不同。

### content_hash

表示：

```text
当前 Markdown 内容的真实版本
```

用于：

- OCC；
- expectedHash；
- 外部编辑检测；
- Dirty 判断。

### content_version

表示：

```text
该 Scope 的逻辑变更代数
```

例如：

```text
Project Scope Version
21 → 22
```

用于：

- Snapshot Staleness；
- Compaction Refresh；
- Runtime 可观测性；
- Workflow Snapshot Version。

因此：

```text
content_hash    → Mutation Concurrency
content_version → Runtime Snapshot Freshness
```

## 17.17 Scope Version 与 Snapshot Staleness

创建 Session Snapshot 时记录：

```ts
scopeVersions: {
  global: 8,
  project: 21,
}
```

Session 运行期间发生 Project Memory Write：

```text
project version: 21 → 22
```

当前 Session 不立即刷新 System Prefix。

到 Compaction 时：

```text
snapshot.projectVersion = 21
current.projectVersion  = 22
```

则：

```text
refreshSnapshot = true
```

并生成新的 Durable：

```text
MemorySnapshotEntry
```

因此 Scope Version 解决：

```text
“当前 Runtime Snapshot 是否已经落后”
```

不是写冲突本身。

## 17.18 推荐接口

读取：

```ts
export type MemoryDocument = {
  path: string;
  content: string;
  revision: string;
  updatedAt: number;
};
```

Mutation：

```ts
export type MemoryPatchRequest = {
  scope: MemoryScope;
  path: string;

  expectedRevision: string;

  patch:
    | {
        type: 'replace';
        oldText: string;
        newText: string;
      }
    | {
        type: 'append';
        anchor?: string;
        content: string;
      };
};
```

返回：

```ts
export type MemoryMutationResult = {
  previousRevision: string;
  revision: string;
  changed: boolean;
  scopeVersion: number;
};
```

冲突：

```ts
throw new MemoryError('memory_conflict', {
  expectedRevision,
  actualRevision,
});
```

## 17.19 实现原则总结

Memory Mutation 可以概括为：

> Jojo Memory 使用文件级 CAS。调用者必须携带读取时获得的 `expectedHash`；真正写入前 Store 在 Scope Write Queue 内重新读取 Markdown 并计算 SHA-256，仅当当前 Hash 与 `expectedHash` 一致时才允许应用 Exact Patch。修改使用同目录临时文件 + `fsync` + atomic rename。若 Revision 不一致则返回 `memory_conflict`，调用者必须基于最新内容重新生成 Diff。SQLite 只在 Markdown 成功后更新，失败时标记索引 dirty 并异步重建。

---

# 18. MemoryRuntime Port

`agent-runtime` 只定义接口：

```ts
export type MemoryScopeRef = {
  globalScopeId: 'global';
  projectScopeId?: string;
};

export type MemorySnapshot = {
  id: string;
  version: number;
  scope: MemoryScopeRef;
  content: string;
  sourceEntryIds: string[];
  estimatedTokens: number;
  contentHash: string;
};

export interface MemoryRuntime {
  snapshot(input: {
    sessionId: string;
    operationId: string;
    projectIdentity?: ProjectIdentity;
    contextWindowTokens: number;
    signal: AbortSignal;
  }): Promise<MemorySnapshot>;

  recallTriggered(input: {
    sessionId: string;
    operationId: string;
    snapshotId: string;
    userText: string;
  }): Promise<MemoryRecall[]>;

  beforeCompact(
    input: MemoryCompactInput
  ): Promise<MemoryCompactResult>;

  onTurnSettled(
    input: MemoryTurnSettledInput
  ): Promise<void>;
}
```

没有启用 Memory 时使用 `NoopMemoryRuntime`。

---

# 19. Durable Memory Snapshot

新增 Runtime Entry：

```ts
export type MemorySnapshotEntry = EntryBase & {
  type: 'memory_snapshot';
  snapshotId: string;
  content: string;
  contentHash: string;
  sourceEntryIds: string[];
  scopeVersions: Record<string, number>;
  estimatedTokens: number;
  refreshedBy:
    | 'session_start'
    | 'compaction'
    | 'manual';
};
```

以及：

```ts
export type MemoryRecallEntry = EntryBase & {
  type: 'memory_recall';
  snapshotId: string;
  ruleIds: string[];
  userMessageId: string;
  content: string;
};
```

目的：

```text
Crash Resume
可复现
幂等
Session Prompt 稳定
Workflow 可重放
```

---

# 20. ambientContext

Memory Snapshot 不应该伪装成 user message。

扩展 Context Builder：

```ts
export type ModelContext = {
  messages: Message[];

  ambientContext: Array<{
    source:
      | 'memory'
      | 'hook'
      | 'skill'
      | 'mcp';

    content: string;
    stable: boolean;
    estimatedTokens: number;
  }>;
};
```

最终模型 Context：

```text
System Safety
       ↓
Confirmed Global Rules
       ↓
Confirmed Project Rules
       ↓
Stable Memory Snapshot
       ↓
Runtime / MCP Instructions
       ↓
Tool Definitions
       ↓
Conversation
```

---

# 21. 指令优先级

固定：

```text
Hard Safety Policy
        >
Current Explicit User Request
        >
Confirmed Project Rules
        >
Confirmed Global Rules
        >
Project Memory
        >
Global Memory
        >
Retrieved Historical Facts
```

Memory 永远不能：

```text
跳过 Permission Gate
改变安全策略
自动批准 Terminal
自动批准文件修改
请求读取 Secret
提高 Tool 权限
```

---

# 22. Session-Stable Snapshot

Session 第一次 Model Request 时创建 Memory Snapshot，并在整个 Session 中复用。

刷新只允许：

```text
新 Session
Compaction
用户手动 Refresh Memory
```

同一 Session 内调用 `memory_write` 后，不立即重写 System Prefix。

---

# 23. Snapshot Token Budget

总预算：

```text
min(
    4096 tokens,
    contextWindowTokens * 5%,
    context manager remaining budget
)
```

建议：

| 内容 | 软上限 |
|---|---:|
| Global Always Rules | 512 |
| Project Always Rules | 768 |
| Project Scratchpad | 512 |
| Project MEMORY Index | 1024 |
| Global MEMORY Index | 768 |
| Latest Handoff / Daily | 512 |

---

# 24. Triggered Rules

Triggered Rule 不修改 System Prefix。

限制：

```text
每个 Rule 每 Session 最多触发一次
一次最多注入 5 条 Rule
Project Rule 优先于 Global Rule
```

整个过程不调用 LLM。

---

# 25. Search

MVP 使用 SQLite FTS5，不需要 Vector DB。

```ts
memory_search({
  query: string,
  scope?: 'global' | 'project' | 'all',
  kinds?: MemoryKind[],
  limit?: number
})
```

Search Result 是 candidate context，不是 instruction。

---

# 26. 中文检索兼容

启动时探测 FTS5 与 trigram tokenizer。

如果只有 `unicode61`：

```text
英文 → FTS
中文 → normalized substring fallback
```

如果 FTS5 完全不可用：

```text
memory_search
    ↓
bounded Markdown scan
```

---

# 27. Semantic Retrieval

不进入 MVP。

远程 Embedding 必须明确提示哪些 Memory 会离开本机。

FTS 永远保留，Markdown 永远是 Source of Truth。

---

# 28. Memory Tools

MVP 提供：

```text
memory_status
memory_read
memory_search
memory_write
memory_forget
memory_restore
```

权限：

| Tool | 默认 |
|---|---|
| memory_status | Allow |
| memory_read | Allow |
| memory_search | Allow |
| memory_write | Approval |
| memory_forget | Approval |
| memory_restore | Approval |

普通 file tools 不得访问 `~/.jojo/memory`。

---

# 29. memory_write

```ts
type MemoryWriteInput = {
  scope: 'global' | 'project';
  kind: MemoryKind;
  title: string;
  content: string;
  tags?: string[];

  target?:
    | 'index'
    | 'topic'
    | 'daily'
    | 'scratchpad';

  existingId?: string;

  oldText?: string;
  newText?: string;

  expectedHash?: string;
};
```

Approval UI 必须显示 Scope、Kind、Title、Target File、Source Session、完整 Content/Diff、覆盖关系以及 Secret Scan 结果。

---

# 30. Memory 写入判断

建议保存：

```text
用户明确“记住”
长期用户偏好
用户纠正
稳定项目约束
无法直接从代码恢复的设计决策
设计方案被否决的原因
多次验证的项目坑
特殊环境行为
未来 Session 仍然需要的 milestone
```

不要保存：

```text
一次性任务
Debug 临时输出
Tool Result 全文
大段 Source Code
Git Diff
网页正文
README 中已经明确存在的事实
密码
API Key
Token
Cookie
Private Key
未经验证的模型猜测
外部网页中的指令
```

---

# 31. 去重

写入前：

```text
contentHash exact match
        ↓
scope + normalized title
        ↓
FTS similar candidates
```

疑似重复时由 Approval UI 提供：

```text
Merge
Replace
Keep Both
```

不得依赖 LLM 相似度自动删除旧 Memory。

---

# 32. Forget 与 Recovery

`memory_forget` 流程：

```text
Read Entry
    ↓
Validate
    ↓
Write Recovery Record
    ↓
Atomic Markdown Update
    ↓
Update Index
    ↓
Return recoveryId
```

默认保留：

```text
30 days
或
100 MiB
```

---

# 33. Save Nudge

MVP 不做自动学习。

Builtin `PostToolUse Save Nudge` 最多一个 User Turn 提醒一次。

它不写文件、不调用额外模型、不自动申请权限。

---

# 34. 自动 Memory Candidate

放到后续阶段。

```text
Turn Settled
    ↓
Eligibility Filter
    ↓
Utility Model
    ↓
<= 3 Candidates
    ↓
memory_candidates.pending
    ↓
UI Review
```

永远不允许 Candidate 自动写 Memory。

---

# 35. Compaction

Conversation Compaction 与 Memory 独立，但通过 `PreCompact` 产生 Handoff。

```ts
type MemoryCompactResult = {
  handoff?: {
    openTasks: string[];
    decisions: string[];
    memoryWrites: string[];
  };

  refreshSnapshot: boolean;
};
```

MVP Handoff 不额外调用模型。

---

# 36. Sub-Agent

原则：

```text
Main Agent
    read + search + approved mutation

Sub-Agent
    read-only
```

Sub-Agent 若发现值得记忆的内容，返回 `memoryCandidates`，由 Main Agent 或 UI 处理。

---

# 37. Workflow

Workflow Start 时解析并固定 `memorySnapshotId + contentHash`。

所有 Agent Step 使用同一 Snapshot，避免执行过程中 Memory 改变导致 Workflow 漂移。

---

# 38. Worktree

Writable Sub-Agent 的 Memory Scope 始终来自 Parent ProjectIdentity，而不是 Worktree Path。

---

# 39. Security Pipeline

```text
Memory Candidate
       ↓
Scope Validation
       ↓
Path Guard
       ↓
Secret Scanner
       ↓
Injection Sanitizer
       ↓
Duplicate Detection
       ↓
Permission Approval
       ↓
Atomic Write
       ↓
Index Update
```

Approval 无法覆盖 Hard Deny。

---

# 40. Secret Scanner

至少检测：

```text
PEM Private Key
Authorization Header
Cookie Header
API Key 常见 Prefix
Token 常见 Prefix
.env password
.env secret
.env token
```

高熵字符串只 Warning，避免误伤 Git SHA、Hash、UUID、Build ID。

---

# 41. Memory Poisoning

所有 Memory 内容都视为 untrusted historical data。

Memory 不具备改变 Permission、Tool Policy、System Rule、Safety Rule 的能力。

---

# 42. File Security

限制：

```text
Entry content <= 16 KiB
Topic file <= 128 KiB
Scope <= 20 MiB
```

Unix：

```text
file 0600
directory 0700
```

所有读写校验 canonical root 与 realpath parent，禁止 symlink escape。

---

# 43. IPC

建议：

```ts
memory.getSnapshot({ sessionId })

memory.list({ projectId?, scope, query?, cursor? })

memory.get({ id })

memory.saveDraft({ ... })

memory.update({ id, expectedHash, ... })

memory.forget({ id, expectedHash })

memory.restore({ recoveryId, expectedHash? })

memory.listCandidates({ projectId? })

memory.resolveCandidate({ id, action, editedPayload? })

memory.rebuildIndex({ scopeId })

memory.export({ scopeId, destination })

memory.importPreview({ path, targetScopeId })

memory.importApply({ previewId, selectedIds })
```

Renderer Mutation 必须包含 `expectedHash`。

---

# 44. UI

Settings 增加 Memory 页面，至少显示：

- Memory Enabled；
- Global / Project Enabled；
- Global / Project Scope；
- Always / Triggered Rules；
- Memory Entries；
- Topics；
- Scratchpad；
- Pending Candidates；
- Recovery；
- Index Status；
- Snapshot ID / Hash / Token Usage；
- Rebuild Index；
- Export / Import。

---

# 45. Chat UI

Memory Search、Write、Triggered Rule、Recovery 使用独立 Card。

Memory 修改不能出现在 Workspace Git Diff 中。

---

# 46. Settings

```ts
export type MemorySettings = {
  enabled: boolean;
  globalEnabled: boolean;
  projectEnabled: boolean;
  snapshotMode: 'session-stable';
  maxSnapshotTokens: number;
  maxContextRatio: number;

  search: {
    enabled: boolean;
    maxResults: number;
  };

  suggestions: {
    enabled: boolean;
    maxPerTurn: number;
  };

  autoRecall: boolean;
  recoveryRetentionDays: number;
  confirmDelete: boolean;
};
```

---

# 47. Error Codes

统一：

```text
memory_scope_unavailable
memory_entry_not_found
memory_parse_failed
memory_conflict
memory_secret_detected
memory_size_exceeded
memory_permission_denied
memory_index_unavailable
memory_index_stale
memory_recovery_expired
memory_snapshot_failed
```

---

# 48. Observability

事件：

```text
memory.snapshot.created
memory.snapshot.reused
memory.rule.recalled
memory.write.requested
memory.write.completed
memory.write.failed
memory.forget.completed
memory.restore.completed
memory.candidate.created
memory.index.rebuilt
memory.handoff.completed
```

日志只允许 ID、Scope、Size、Duration、Hash、Error Code，不记录 Memory Content。

---

# 49. Failure Strategy

Memory 属于 Enhancement，不是 Agent Runtime 的硬依赖。

```text
Snapshot 失败
    → 无 Memory 继续 Agent

FTS 失败
    → Markdown fallback

Index stale
    → Background rebuild

Memory read 失败
    → warning

Memory write 失败
    → Tool Error
```

---

# 50. 实施阶段

## M0：Contracts 与 Runtime 接缝

实现：

```text
ProjectIdentity
Memory Types
MemoryRuntime Port
NoopMemoryRuntime
MemorySnapshotEntry
MemoryRecallEntry
Runtime Session Metadata
deleteSession / GC
ambientContext
token accounting
```

## M1：只读 Memory

实现：

```text
~/.jojo/memory
Markdown Store
Parser
Global Scope
Project Scope
MEMORY.md
topics
SCRATCHPAD
Session-stable Snapshot
memory_status
memory_read
```

## M2：Mutation 与 Recovery

实现：

```text
memory_write
memory_forget
memory_restore
MemoryPermissionGate
Secret Scanner
Path Guard
Atomic Writer
expectedHash
Recovery
Diff Approval UI
Save Nudge
```

并要求 Revision / Exact Patch / Scope Write Queue / Atomic Write 在 M2 一次性完成，不允许分散到后续阶段。

## M3：Search 与 Rule

实现：

```text
memory.sqlite
SQLite Migration
FTS5
Trigram detection
CJK fallback
memory_search
Always Rule
Triggered Rule
MemoryRecallEntry
```

---

# 51. MVP

正式 MVP：

```text
M0 + M1 + M2 + M3
```

即：

```text
Markdown Source of Truth
Global + Project
Stable Snapshot
Explicit Write
Revision / OCC
Atomic Write
Recovery
FTS Search
Always/Triggered Rules
Permission/Security
```

不要为了第一版加入 Embedding、Vector Database、Auto Learning、LLM Rerank、Cloud Memory。

---

# 52. M4：Compaction 与 Orchestration

实现：

```text
MemoryCompactInput
Memory Handoff
Compaction Snapshot Refresh
Sub-Agent Memory Policy
Workflow Frozen Snapshot
Worktree Scope Inheritance
```

---

# 53. M5：Memory Candidate

实现 Turn Settled Candidate Extractor、Candidate Store、Candidate Review UI。

默认仍然不自动写入。

---

# 54. M6：Semantic Retrieval

可选：

```text
Embedding Provider
Local Embedding
Remote Embedding
Vector Index
Hybrid Search
Retrieval Eval
```

只有在 FTS Eval 明确无法满足需求后再实现。

---

# 55. 关键测试

## Store

必须测试：

```text
Atomic Write
Revision Conflict
Exact Patch Conflict
Approval 后 Revision 变化
External Editor 修改
Process-local Queue
Crash between rename/index
Index Rebuild
Schema Migration
Manual Markdown Edit
Partial Parse Failure
```

## Runtime

测试：

```text
Session 只创建一个 Snapshot
第二 Turn 复用 Snapshot
App Restart 后继续复用
Compaction 刷新 Snapshot
Triggered Recall 不重复
Scope Version 变化后 Snapshot Stale Detection
```

## Security

测试：

```text
Path Traversal
Symlink Escape
Secret
Prompt Injection
Background Mutation
Rule Privilege Escalation
Untrusted Import
```

## Orchestration

测试：

```text
Worktree ProjectIdentity
Sub-Agent Read-only
Workflow Same Snapshot
Crash Resume
```

## Retrieval Eval

单独 Eval：

```text
Search Recall@5
Triggered Rule Precision
Triggered Rule Recall
Outdated Memory Behavior
Conflicting Rules
Token Cost
```

---

# 56. 最终架构

```text
                         User
                          │
                          ▼
                  Desktop Renderer
                          │
                    IPC / Approval
                          │
                          ▼
                   Desktop Worker
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
   Agent Runtime      Memory Runtime       Hooks
        │                 │                 │
        │                 │          Save Nudge /
        │                 │          Observation
        │                 │
        ▼                 ▼
 Session Tree       Markdown Store
 Operation          ~/.jojo/memory
 Lane                    │
 Compaction              │
        │                 ├──────► FTS Index
        │                 │          node:sqlite
        │                 │
        │                 └──────► Recovery
        │
        ├──── memory_snapshot
        ├──── memory_recall
        │
        ▼
  Context Builder
        │
        ├── Stable Ambient Memory
        ├── Triggered Recall
        ├── Compaction
        └── Conversation
        │
        ▼
      Model
```

---

# 57. 最终决策表

| 议题 | 最终选择 |
|---|---|
| Memory Package | `packages/memory` |
| Long-Term Source of Truth | Markdown |
| Memory Root | `~/.jojo/memory/` |
| Scope | Global + Project |
| Project Identification | canonical workingDirectory → ProjectIdentity |
| Git Repository Required | 否 |
| Project Memory 默认 Commit | 否 |
| Index | `node:sqlite` FTS5 |
| Vector Search | 非 MVP |
| Prompt Strategy | Session-stable Snapshot |
| Memory Snapshot Persistence | Durable Runtime Entry |
| Dynamic Rule | Durable MemoryRecallEntry |
| Mutation | 专用 Tool + Approval |
| Concurrency | expectedHash + Exact Patch + Scope Queue |
| Atomicity | tmp + fsync + atomic rename |
| File Tool 直接访问 Memory | 禁止 |
| Rule Activation | 用户 Confirmed |
| Delete | Recovery 后真实删除 |
| Main Agent | Read / Search / Approved Write |
| Sub-Agent | Read-only |
| Workflow | Frozen Read-only Snapshot |
| Worktree | 继承 Parent ProjectIdentity |
| Auto Learning | 非 MVP，只允许 Candidate |
| Hooks | Reminder / Observation，不是权威 Store |
| Compaction | 独立，但通过 Handoff 协同 |
| Memory Failure | Graceful Degradation |

---

# 58. 一句话设计原则

> **Jojo Memory 是一套“Markdown 为真源、SQLite 为索引、Session Snapshot 为运行时投影、Permission Gate 为写入边界、Revision/CAS 为并发一致性保证”的跨会话长期记忆系统，而不是聊天记录数据库或向量数据库。**

# Jojo Agent Memory 设置页 UX 优化方案

> 项目：`zxt6991-source/jojo-agent`  
> 分析基线：`main` 分支 commit `45da0babbbe50f04d6f4c1351dbff7ad54e3175c`（2026-09-16）  
> 核心源码：
> - [`apps/desktop/src/renderer/MemorySettings.tsx`](https://github.com/zxt6991-source/jojo-agent/blob/main/apps/desktop/src/renderer/MemorySettings.tsx)
> - [`apps/desktop/src/renderer/memory-settings.test.ts`](https://github.com/zxt6991-source/jojo-agent/blob/main/apps/desktop/src/renderer/memory-settings.test.ts)
> - [`packages/contracts/src/memory.ts`](https://github.com/zxt6991-source/jojo-agent/blob/main/packages/contracts/src/memory.ts)
> - [`packages/contracts/src/memory-semantic.ts`](https://github.com/zxt6991-source/jojo-agent/blob/main/packages/contracts/src/memory-semantic.ts)
> - [`packages/contracts/src/memory-candidate.ts`](https://github.com/zxt6991-source/jojo-agent/blob/main/packages/contracts/src/memory-candidate.ts)
>
> 目标：在**不削弱现有 Memory 能力、安全边界和本地优先架构**的前提下，大幅降低普通用户理解和配置 Memory 的心智负担。

---

## 1. 结论摘要

当前 Memory 页的问题并不是“功能太多”，而是**把产品级决策、实现级参数、运行状态、数据管理、故障诊断同时放在同一个页面、同一个信息层级**。

当前页面直接暴露了 20+ 个开关、下拉框和数值参数，包括：

- Global / Project Memory；
- Memory Suggestions；
- Suggestion Provider / Model；
- 每回合候选数；
- Evidence token 上限；
- Eligibility Score；
- Semantic Search；
- Backend；
- Embedding Provider / Model；
- Search Mode；
- Semantic Candidate 数量；
- Daily / Scratchpad 是否索引；
- Remote Embedding Privacy；
- Snapshot token；
- Context Ratio；
- Auto Recall；
- Memory Search；
- Search Results；
- Delete Confirmation；
- Recovery Retention；
- FTS / Semantic Index 状态；
- Scope version / hash / path / dirty / warnings；
- Index Rebuild。

这些配置大部分对 Memory 的底层实现是合理的，但并不应该成为普通用户第一次打开 Memory 页时必须理解的概念。

### 推荐方向

将当前的“Memory 系统控制台”重构为：

```text
Memory
├── 概览                ← 90% 用户主要使用
│   ├── 启用 Memory
│   ├── 从对话中发现值得记住的信息
│   ├── 使用全局记忆
│   ├── 使用当前项目记忆
│   └── 记忆数量 / 待确认建议
│
├── 管理记忆            ← 管理内容，而不是调参数
│   ├── 全局记忆
│   ├── 当前项目
│   ├── 待确认建议
│   └── 已删除 / 恢复（可选）
│
└── 高级设置            ← 只有高级用户主动展开
    ├── Suggestions
    ├── Search / Semantic
    ├── Context Budget
    ├── Recovery
    └── Diagnostics
```

核心原则是：

> **底层继续复杂，界面默认简单。**

第一阶段甚至不需要修改现有 Memory Runtime、Store、Contracts，只通过 Renderer 的信息架构重组、默认值继承和渐进披露，就可以完成大部分体验优化。

---

# 2. 当前 Memory 页的心智模型问题

## 2.1 用户需要同时理解太多不同层级的概念

当前页面同时要求用户理解至少五套模型：

### A. “记忆是什么”

用户需要理解：

- Global Memory
- Project Memory
- Rule
- Preference
- Decision
- Constraint
- Fact
- Lesson
- Procedure
- Task

这些属于**内容模型**。

### B. “记忆怎么产生”

用户又需要理解：

- Memory Suggestions
- Utility Model
- Provider
- Model
- Eligibility Score
- Evidence Max Tokens
- Max Per Turn

这些属于**候选生成模型**。

### C. “记忆怎么被找到”

用户还需要理解：

- FTS
- Semantic Search
- Hybrid
- RRF
- Embedding
- Vector Backend
- Semantic Candidate

这些属于**检索模型**。

### D. “记忆如何进入上下文”

还存在：

- Snapshot
- maxSnapshotTokens
- maxContextRatio
- autoRecall

这些属于**上下文注入模型**。

### E. “Memory 如何维护”

还有：

- Markdown source of truth
- SQLite projection
- Index dirty
- Rebuild
- Version
- Content Hash
- Recovery Record

这些属于**存储和运维模型**。

对于 Memory 系统开发者，这五层都很清晰；对于使用 Agent 的用户，它们实际上属于内部实现。

---

# 3. 当前页面最主要的 UX 问题

## 3.1 页面按“技术模块”组织，而不是按“用户任务”组织

当前页面大致是：

```text
启用 Memory
Global / Project
Memory Suggestions
Semantic Search
Pending Suggestions
快照与检索
删除与恢复
本地索引状态
保存
```

这基本等同于代码模块结构。

但用户真正会产生的任务通常只有：

```text
1. 我想让 Jojo 记住东西
2. 我想控制它是否从聊天里提炼记忆
3. 我想看看它记住了什么
4. 我想删掉一条记忆
5. Memory 好像没工作，我想修复
```

因此当前 UI 是典型的：

> Implementation-oriented UI，而不是 Task-oriented UI。

---

## 3.2 高频功能和低频高级参数处于同一视觉层级

例如：

```text
启用长期记忆
```

和：

```text
最大候选向量 = 10000
Evidence 最大 tokens = 2048
最低 Eligibility 分数 = 30
```

在产品层级上明显不是同一种配置。

普通用户有能力判断：

> “我要不要让 Jojo 记住我的偏好？”

但很难判断：

> “Eligibility 应该是 20、30 还是 50？”

如果一个配置不存在明确的用户决策依据，就不应该默认暴露。

---

## 3.3 “设置”和“Memory 内容管理”混在一起

当前页面同时承担：

- 功能配置；
- Pending Candidate 审核；
- Scope 浏览；
- Memory 删除；
- Index 运维；
- Semantic Index 重建；
- Privacy 授权。

这导致页面不断变长。

建议明确拆分：

```text
Settings
    控制 Memory 怎么工作

Manage Memories
    控制 Memory 里有什么

Diagnostics
    控制 Memory 出故障时怎么办
```

---

## 3.4 Scope 概念被过度暴露

当前界面大量使用：

```text
Global Memory
Project Memory
Global Scope
Project Scope
Scope Version
Scope Directory
Scope ID
```

对开发者很自然。

对用户可以改成：

```text
所有项目
当前项目
```

用户不需要首先学习 “Scope” 这个抽象名词。

---

## 3.5 Semantic Search 的 UI 已接近独立系统设置页

当前 Semantic Search 同时暴露：

- 是否启用；
- Backend；
- Provider；
- Embedding Model；
- Search Mode；
- 最大候选向量；
- Remote Allowed；
- Daily Memory；
- Scratchpad；
- Indexed；
- Pending；
- Failed；
- Skipped Secret；
- Stale；
- Rebuild Index。

从产品视角，它已经是一个完整的“向量搜索管理控制台”。

但是普通用户真正关心的是：

> “Memory 能不能找到以前记住的东西？”

因此应该把它抽象成：

```text
增强记忆搜索
[自动]
```

只有进入高级设置时，才出现：

```text
Embedding Provider
Embedding Model
Search Mode
Index Scope
```

---

## 3.6 正常状态下展示过多诊断数据

当前 Scope 配置弹窗会直接展示：

- Version
- Dirty
- Warning Count
- Content Hash
- Directory
- Source File
- Entry ID

这些信息对排错有价值，但正常使用时几乎没有价值。

推荐采用：

```text
正常状态：
Memory 工作正常

异常状态：
Memory 索引需要修复
[修复]
[查看详情]
```

而不是一直显示诊断字段。

---

# 4. 新的产品心智模型

建议让用户只理解三个概念。

## 4.1 Memory

解释：

> Jojo 可以跨对话记住你的偏好、项目约束和重要决策。

这是产品概念。

---

## 4.2 所有项目 / 当前项目

替代：

```text
Global Memory
Project Memory
```

建议显示为：

```text
所有项目
例如：默认使用中文、偏好的编程语言、协作习惯

当前项目
例如：项目架构约束、设计决策、TODO、踩坑经验
```

内部依然保留：

```ts
scope: 'global' | 'project'
```

只是 UI 不再要求用户学习 Scope。

---

## 4.3 待确认记忆

替代：

```text
Memory Suggestions
Pending Suggestions
Candidate
Eligibility
```

统一产品语言：

> Jojo 发现了一些可能值得长期记住的信息，在保存前让你确认。

普通用户只需要：

```text
接受
编辑
忽略
```

---

# 5. 推荐的新页面结构

## 5.1 Memory 首页

建议默认页面只保留以下内容。

```text
┌──────────────────────────────────────────────────────┐
│ Memory                                      已开启   │
│ 让 Jojo 在不同对话之间记住重要信息                  │
│                                                      │
│ [●] 启用 Memory                                     │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ 自动发现值得记住的信息                               │
│                                                      │
│ [●] 从对话中发现记忆建议                             │
│                                                      │
│ Jojo 只会生成建议，保存前仍需要你的确认。             │
│                                          待确认 3 条 │
│                                      [查看并处理 →]  │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ Memory 使用范围                                      │
│                                                      │
│ [●] 所有项目                                         │
│     语言、工具、协作偏好                              │
│                                                      │
│ [●] 当前项目                                         │
│     当前项目的约束、决定和经验                        │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│ 已保存的 Memory                                      │
│                                                      │
│ 所有项目                       12 条                  │
│ 当前项目                        8 条                  │
│                                                      │
│                                     [管理 Memory →]  │
└──────────────────────────────────────────────────────┘

Memory 工作正常

[高级设置]
```

整个默认页面只产生 4 个核心决策：

1. Memory 开不开；
2. 是否自动生成建议；
3. 是否使用所有项目记忆；
4. 是否使用当前项目记忆。

---

# 6. “管理 Memory”应从设置页独立出来

建议新增：

```text
Memory > 管理
```

或者在 Memory 页面内部使用：

```text
概览 | 已保存 | 待确认
```

推荐后者。

---

## 6.1 已保存

```text
Memory

[概览] [已保存] [待确认 3]

搜索 Memory...

[所有项目] [当前项目]

默认使用中文回答
偏好
所有项目

回答 Go 问题时解释和 C 的差异
偏好
所有项目

项目使用 pnpm workspace
事实
当前项目

Memory 的 Markdown 文件是唯一真源
决策
当前项目
```

点击条目后：

```text
默认使用中文回答

类型        偏好
作用范围    所有项目
创建时间    2026-09-12

内容
所有回答默认使用中文。

[编辑] [删除]
```

默认不要展示：

```text
entry id
source file
content hash
scope version
```

放到：

```text
更多信息
```

中。

---

# 7. Pending Suggestions 优化

当前 Candidate Card 暴露：

- scope
- kind
- confidence
- rationale
- session id
- createdAt
- rule triggers

这些信息都可以保留，但应重新排序。

推荐：

```text
┌────────────────────────────────────────────────────┐
│ Jojo 建议记住                                      │
│                                                    │
│ 当前项目使用 node:sqlite                           │
│                                                    │
│ 使用 node:sqlite 作为 Memory SQLite 实现。          │
│                                                    │
│ 为什么建议保存？                                   │
│ 这是本次讨论中确认的长期技术决策。                  │
│                                                    │
│ 保存到： 当前项目 ▾                                │
│                                                    │
│ [忽略]                     [编辑] [保存 Memory]    │
└────────────────────────────────────────────────────┘
```

### Confidence

不建议默认显示：

```text
high / medium / low
```

原因：

用户并不知道这个置信度是：

- 信息正确性的置信度；
- 是否长期有价值；
- 是否应该保存；
- 模型抽取置信度；

其中哪一种。

可在“详情”中显示：

```text
建议置信度：高
```

而不是作为卡片最显眼的状态。

---

# 8. Suggestions 设置简化

当前：

```text
Memory Suggestions
├── Enabled
├── Provider
├── Model
├── Max Per Turn
├── Evidence Max Tokens
└── Min Eligibility Score
```

建议默认只展示：

```text
从对话中发现记忆建议   [开]
```

并说明：

> Jojo 会发现可能值得长期保存的信息，但不会自动写入 Memory。

---

## 8.1 Provider / Model 应默认继承 Utility Model

当前代码已经存在：

```ts
utilityModel
```

并且开启 Suggestions 时会尝试：

```ts
utilityModel.providerId
utilityModel.model
```

因此完全可以进一步产品化：

```text
Memory Suggestions
默认使用 Utility Model
```

普通用户无需再次选一遍 Provider / Model。

高级设置增加：

```text
建议生成模型
○ 自动（跟随 Utility Model）
○ 自定义
```

只有选择自定义才展示：

```text
Provider
Model
```

---

## 8.2 以下参数应该完全移出普通设置

```text
maxPerTurn
evidenceMaxTokens
minEligibilityScore
```

它们应该属于：

```text
高级设置 > Suggestions > 调优
```

甚至可以只在 Developer Mode 中显示。

推荐默认值继续由 Contracts 管理：

```ts
maxPerTurn = 3
evidenceMaxTokens = 2048
minEligibilityScore = 30
```

---

# 9. Semantic Search 优化

这是当前 Memory 页心智负担最大的部分。

建议默认页面完全不展示：

```text
Backend
Provider
Embedding Model
Search Mode
Max Semantic Candidates
Daily Index
Scratchpad Index
Indexed
Pending
Failed
Skipped Secret
Stale
```

---

## 9.1 普通用户看到的版本

```text
增强 Memory 搜索                         自动

可以在 Memory 较多时更准确地找到相关内容。
Jojo 会优先使用本地能力；需要发送到远程服务时会单独提示。
```

可提供：

```text
[自动] [关闭]
```

而不是：

```text
fts / semantic / hybrid
```

---

## 9.2 高级用户看到的版本

```text
高级设置
└── Memory Search
    ├── 搜索方式
    │   ├── 自动（推荐）
    │   ├── 仅关键词
    │   └── Semantic + Keyword
    │
    ├── Embedding
    │   ├── 自动
    │   └── 自定义
    │
    └── 索引内容
        ├── 正式 Memory
        ├── Daily
        └── Scratchpad
```

内部映射：

```text
自动
→ semantic.enabled 根据可用 provider / 能力决定
→ searchMode = hybrid

仅关键词
→ semantic.enabled = false
→ FTS

Semantic + Keyword
→ semantic.enabled = true
→ searchMode = hybrid
```

---

# 10. Remote Embedding Privacy 保留显式确认

当前实现这一点是合理的，不建议弱化。

当用户选择远程 Embedding Provider 时：

```text
Memory 内容将发送给远程 Embedding 服务

发送：
✓ 用于建立索引的 Memory 内容
✓ Memory 搜索词

不会发送：
✓ 完整会话
✓ 仓库全文
✓ Secret Chunk

[取消]
[允许使用远程 Embedding]
```

这是一个**事件驱动授权**，不应该作为常驻设置一直占据页面空间。

只有满足：

```ts
semanticProviderRemote === true
```

时才出现。

当前代码已有该逻辑，建议保留。

---

# 11. Snapshot 与 Context Budget 优化

当前暴露：

```text
快照最大 tokens
上下文占比上限
```

这是典型运行时参数。

绝大多数用户无法根据体验判断：

```text
4096 tokens 是否合适？
5% 是否合适？
```

建议普通设置完全隐藏。

放入：

```text
高级设置
└── Context Budget
    ├── Memory 最大 tokens
    └── 最大上下文占比
```

并增加：

```text
恢复推荐值
```

---

# 12. Auto Recall 优化

当前：

```text
自动触发已确认规则
```

这属于 Memory 正常工作的必要组成部分。

如果关闭，会导致：

> “我明明保存了规则，为什么 Jojo 不使用？”

因此建议：

### 默认用户

不显示。

### Advanced

```text
规则自动触发                     [开]
```

除非有明确的用户需求，否则保持：

```ts
autoRecall = true
```

---

# 13. Memory Search 优化

当前：

```text
启用 Memory Search
最多结果
```

同样建议：

### 普通用户

默认开启，不显示。

### Advanced

```text
允许 Agent 主动搜索 Memory      [开]

最大返回结果                     10
```

---

# 14. 删除与恢复优化

当前：

```text
删除前要求确认
保留天数
```

建议：

## 删除确认

不要作为设置。

删除长期记忆本身就是低频、高影响操作。

始终确认：

```text
确定删除这条 Memory？

删除后 30 天内仍可恢复。

[取消]
[删除]
```

也就是说：

```ts
confirmDelete
```

可以暂时继续保留兼容旧配置，但 UI 不再暴露。

后续版本可以考虑废弃该配置。

---

## Recovery Retention

普通用户无需一直看到。

放在：

```text
高级设置 > 数据与恢复
```

显示：

```text
已删除 Memory 保留       30 天
```

---

# 15. 本地索引状态改造成“健康状态”

当前：

```text
root
FTS5 Trigram
scope version
dirty
warning count
content hash
rebuild
```

建议普通 UI 只出现：

```text
Memory 工作正常
```

异常时：

```text
Memory 搜索索引需要修复

不会丢失 Memory 文件，可以安全重新建立索引。

[修复]
[查看详情]
```

---

## 15.1 Diagnostics 页面

点击“查看详情”才出现：

```text
Storage
Root
~/.jojo/memory

Keyword Index
FTS5 Trigram
Healthy

Semantic Index
126 chunks
2 pending
0 failed
3 skipped secrets

Current Project
Version 12
Hash abcdef123456
Index Healthy

[Rebuild Keyword Index]
[Rebuild Semantic Index]
```

这样原来的所有诊断能力仍然保留。

---

# 16. Scope 配置弹窗优化

当前 `MemoryScopeConfigDialog` 同时承担：

- Scope 状态；
- Memory 浏览；
- 删除；
- 技术信息。

建议改造成真正的：

```text
Manage Memories
```

### 普通模式

展示：

```text
名称
内容
类型
作用范围
更新时间
```

### “技术详情”

折叠后展示：

```text
Entry ID
Source File
Content Hash
Scope ID
Scope Version
Directory
```

---

# 17. 推荐页面信息架构

最终建议：

```text
Settings
└── Memory
    ├── Overview
    │   ├── Enable Memory
    │   ├── Discover Suggestions
    │   ├── All Projects
    │   ├── Current Project
    │   └── Memory Summary
    │
    ├── Saved Memories
    │   ├── Search
    │   ├── All Projects
    │   └── Current Project
    │
    ├── Suggestions
    │   └── Review Queue
    │
    └── Advanced
        ├── Suggestions Model
        ├── Search
        ├── Context Budget
        ├── Recovery
        └── Diagnostics
```

如果不希望增加 Settings 左侧子菜单，可以用单页顶部 Tab：

```text
Memory

[概览] [已保存] [待确认 3] [高级]
```

这是更推荐的实现方式，因为改动范围较小。

---

# 18. 推荐默认配置

保持现有底层配置结构。

```ts
{
  enabled: true,
  globalEnabled: true,
  projectEnabled: true,

  suggestions: {
    enabled: false,
    maxPerTurn: 3,
    evidenceMaxTokens: 2048,
    minEligibilityScore: 30
  },

  search: {
    enabled: true,
    maxResults: 10
  },

  semantic: {
    enabled: false,
    mode: 'local-linear',
    searchMode: 'hybrid',
    maxSemanticCandidates: 10000,
    indexDaily: false,
    indexScratchpad: false,
    rerankEnabled: false
  },

  autoRecall: true,

  maxSnapshotTokens: 4096,
  maxContextRatio: 0.05,

  recoveryRetentionDays: 30,
  confirmDelete: true
}
```

关键变化不是默认值本身，而是：

> **默认值由系统承担，而不是让用户承担。**

---

# 19. 当前配置到新 UI 的映射

| 当前字段 | 新 UI | 默认是否可见 |
|---|---|---|
| `enabled` | 启用 Memory | 是 |
| `globalEnabled` | 所有项目 | 是 |
| `projectEnabled` | 当前项目 | 是 |
| `suggestions.enabled` | 从对话中发现记忆建议 | 是 |
| `suggestions.providerId` | 建议模型 Provider | 高级 |
| `suggestions.model` | 建议模型 | 高级 |
| `suggestions.maxPerTurn` | 每回合最多建议 | 开发者 |
| `suggestions.evidenceMaxTokens` | Evidence token budget | 开发者 |
| `suggestions.minEligibilityScore` | Eligibility threshold | 开发者 |
| `semantic.enabled` | 增强 Memory 搜索 | 高级 |
| `semantic.mode` | Vector Backend | 开发者 |
| `semantic.providerId` | Embedding Provider | 高级 |
| `semantic.model` | Embedding Model | 高级 |
| `semantic.remoteAllowed` | 远程 Embedding 授权 | 按需弹出 |
| `semantic.searchMode` | 搜索方式 | 高级 |
| `semantic.maxSemanticCandidates` | Semantic Candidate Limit | 开发者 |
| `semantic.indexDaily` | 索引 Daily | 高级 |
| `semantic.indexScratchpad` | 索引 Scratchpad | 高级 |
| `semantic.rerankEnabled` | Rerank | 开发者 |
| `autoRecall` | 规则自动触发 | 高级 |
| `search.enabled` | Agent 可搜索 Memory | 高级 |
| `search.maxResults` | 最大搜索结果 | 开发者 |
| `maxSnapshotTokens` | Memory Context Budget | 开发者 |
| `maxContextRatio` | Context Ratio | 开发者 |
| `recoveryRetentionDays` | 删除后保留时间 | 高级 |
| `confirmDelete` | 删除确认 | 不再暴露 |

---

# 20. “高级设置”和“开发者设置”应区分

即使都隐藏到一个 Advanced 区域，也建议继续分层。

## 高级设置

高级用户可能真的会做决策：

```text
Suggestions 使用哪个模型
是否启用 Semantic Search
Embedding 使用本地还是远程
是否索引 Daily / Scratchpad
Recovery 保存多久
```

## Developer / Diagnostics

主要是调优或排错：

```text
Eligibility Score
Evidence Tokens
Max Semantic Candidates
Snapshot Tokens
Context Ratio
Search Max Results
Backend
RRF
Content Hash
Index Version
```

可以放一个：

```text
显示开发者选项
```

默认关闭。

---

# 21. 第一版不建议新增“简单模式 / 专家模式”配置

看起来很自然的方案是：

```text
Memory Mode:
○ Simple
○ Advanced
```

但这实际上又给用户增加了一个新概念。

更好的设计是：

> 默认简单 + 高级内容渐进展开。

例如：

```text
高级设置 >
```

即可。

因此第一阶段不建议修改 `MemorySettingsSchema` 增加：

```ts
mode: 'simple' | 'advanced'
```

是否展开 Advanced 应属于 Renderer UI state，而不是 Memory runtime config。

---

# 22. 推荐组件拆分

当前：

```text
MemorySettings.tsx
≈ 27 KB
```

建议拆分。

```text
renderer/memory/
├── MemorySettingsPage.tsx
├── MemoryOverview.tsx
├── MemorySavedList.tsx
├── MemorySuggestions.tsx
├── MemorySuggestionCard.tsx
├── MemoryAdvancedSettings.tsx
├── MemorySearchAdvanced.tsx
├── MemoryDiagnostics.tsx
├── MemoryEntryDialog.tsx
└── memory-settings-model.ts
```

---

## 22.1 MemorySettingsPage

只负责：

```ts
activeTab
draft
saved
save
refresh
```

---

## 22.2 MemoryOverview

负责：

```text
master switch
suggestions switch
global/project
summary
health
```

---

## 22.3 MemorySavedList

负责：

```text
list
scope filter
search
view
delete
```

---

## 22.4 MemorySuggestions

负责：

```text
pending candidate queue
accept
edit
reject
```

---

## 22.5 MemoryAdvancedSettings

负责：

```text
suggestions model
semantic
search
snapshot
recovery
```

---

## 22.6 MemoryDiagnostics

负责：

```text
FTS status
Semantic index status
scope status
version/hash/path
rebuild
```

---

# 23. 推荐增加一个 UI View Model 层

当前 Renderer 直接消费：

```ts
MemorySettings
MemoryStatusSnapshot
```

所以内部实现字段很容易自然泄漏到 UI。

建议增加：

```ts
type MemorySettingsViewModel = {
  enabled: boolean;

  discovery: {
    enabled: boolean;
    pendingCount: number;
  };

  scopes: {
    globalEnabled: boolean;
    globalCount: number;
    projectAvailable: boolean;
    projectEnabled: boolean;
    projectCount: number;
  };

  health: {
    level: 'healthy' | 'warning' | 'error';
    message: string;
    repairable: boolean;
  };

  advanced: {
    semanticEnabled: boolean;
    remoteEmbedding: boolean;
  };
};
```

然后：

```ts
function buildMemorySettingsViewModel(
  settings: MemorySettings,
  status: MemoryStatusSnapshot | null
): MemorySettingsViewModel
```

好处：

1. UI 不再绑定 Storage / Search 实现细节；
2. 将来换 FTS / Vector Backend 不需要重做普通 UI；
3. 可集中定义“什么状态才需要提醒用户”。

---

# 24. Health 状态建议

可以从现有字段派生：

```ts
function getMemoryHealth(status: MemoryStatusSnapshot | null) {
  if (!status) {
    return {
      level: 'unknown',
      message: '尚未检查 Memory 状态'
    };
  }

  const dirty = status.scopes.some(scope => scope.dirty);
  const parseWarning = status.scopes.some(scope => scope.warningCount > 0);
  const semanticFailure = (status.semantic?.failed ?? 0) > 0;

  if (dirty || parseWarning || semanticFailure) {
    return {
      level: 'warning',
      message: 'Memory 需要检查'
    };
  }

  return {
    level: 'healthy',
    message: 'Memory 工作正常'
  };
}
```

这样 Overview 无需展示六七个内部指标。

---

# 25. 保存行为优化

当前页面底部：

```text
有尚未保存的修改
[保存 Memory 设置]
```

由于页面很长，用户修改顶部开关后需要滚到最下面保存。

建议二选一。

## 方案 A：设置即时保存

适合：

```text
enabled
globalEnabled
projectEnabled
suggestions.enabled
```

操作即保存。

这是体验最好的方案。

## 方案 B：Sticky Save Bar

如果保持 draft / saved 模式：

```text
────────────────────────────────────────
有未保存修改        [放弃] [保存]
```

固定在窗口底部。

第一阶段建议使用 B，避免改变现有配置持久化语义。

---

# 26. 首次使用流程

用户第一次进入 Memory：

```text
Memory

Jojo 可以跨对话记住重要信息，例如：
• 你偏好的工作方式
• 当前项目的重要约束
• 已确认的技术决策

[启用 Memory]
```

启用后：

```text
Memory 已开启

✓ 使用所有项目记忆
✓ 使用当前项目记忆

从聊天中发现值得保存的信息？
[开启记忆建议]
```

不要第一次进入就展示：

```text
Embedding
FTS
Vector
Context Ratio
```

---

# 27. Candidate 首次出现时的引导

第一次产生候选：

```text
Jojo 发现了一条可能值得长期保存的信息。

“当前项目使用 node:sqlite。”

保存后，未来相关对话可以继续使用它。

[忽略]
[查看并保存]
```

用户从使用过程中自然学会 Memory，而不是先阅读设置说明。

---

# 28. 空状态设计

## 没有 Memory

```text
还没有保存的 Memory

你可以直接告诉 Jojo：
“记住这个项目使用 pnpm。”

或者开启“从对话中发现记忆建议”。
```

---

## 没有 Pending Suggestions

```text
没有待确认建议

当 Jojo 发现可能值得长期保留的信息时，会出现在这里。
```

---

## 没有 Project

当前没有工作目录：

```text
当前没有项目

选择一个项目后，可以单独保存该项目的约束、决策和经验。
```

而不是：

```text
Project Scope unavailable
```

---

# 29. 文案统一

当前界面中英文混用较多：

```text
Memory Suggestions
Pending Suggestions
Semantic Search
Provider
Model
Backend
Search Mode
Scope
Content Hash
Skipped Secret
Stale
```

建议普通模式中文产品化：

| 当前 | 建议 |
|---|---|
| Memory Suggestions | 记忆建议 |
| Pending Suggestions | 待确认 |
| Global Memory | 所有项目 |
| Project Memory | 当前项目 |
| Semantic Search | 增强记忆搜索 |
| Search Mode | 搜索方式 |
| Provider | 服务 |
| Embedding Model | Embedding 模型 |
| Scope | 作用范围 |
| Stale | 需要更新 |
| Skipped Secret | 已跳过敏感内容 |
| Rebuild Index | 修复索引 |

Advanced / Diagnostics 中可以保留技术术语。

---

# 30. 不建议做的事情

## 30.1 不要直接删 Semantic Search

它在 Memory 数量增长以后是有价值的。

问题不是功能存在，而是默认暴露。

---

## 30.2 不要把所有功能做成“一个智能开关”

例如：

```text
Smart Memory [On]
```

然后完全没有可管理入口。

这会导致用户失去：

- 可解释性；
- 可审计性；
- 可删除性；
- 隐私控制。

正确方向是：

> 默认自动，但始终可查看、可编辑、可删除。

---

## 30.3 不要自动接受所有 Suggestions

当前实现明确：

> Suggestions 不会自动写入正式 Memory。

这是很好的安全边界。

建议继续保持：

```text
模型建议
→ 用户确认
→ confirmed memory
```

特别是：

```text
rule
```

更应该逐条确认。

---

## 30.4 不要隐藏远程 Embedding 授权

这属于数据流向变化，应保持显式 consent。

---

# 31. 实施路线

## P0：只改 Renderer，快速降低心智负担

目标：

> 不改 Runtime，不改 Memory Store，不改 Contracts。

### 改动

1. Memory 页增加：
   ```text
   Overview
   Saved
   Suggestions
   Advanced
   ```

2. Overview 只显示：
   ```text
   enabled
   suggestions.enabled
   globalEnabled
   projectEnabled
   counts
   health
   ```

3. Advanced 移入：
   ```text
   Provider / Model
   Semantic
   Search
   Snapshot
   Recovery
   ```

4. Diagnostics 移入：
   ```text
   Root
   FTS
   Hash
   Version
   Dirty
   Rebuild
   ```

5. `MemoryScopeConfigDialog` 重构为 Memory Entry Manager。

### 风险

低。

现有 IPC 和运行时接口基本不需要变化。

---

# 32. P1：体验逻辑优化

### 1. Utility Model 自动继承

Suggestions 默认：

```text
Automatic
```

而不是要求重复选模型。

---

### 2. Semantic 自动配置

增加 Renderer 层派生状态：

```text
Auto
Keyword Only
Enhanced
```

映射到底层：

```text
semantic.enabled
semantic.searchMode
```

---

### 3. Health abstraction

Renderer 不再直接展示：

```text
dirty
failed
stale
warnings
```

而是映射：

```text
Healthy
Needs Attention
Error
```

---

### 4. Sticky Save

减少长页保存操作成本。

---

# 33. P2：进一步产品化

## Memory Search

允许用户直接在 Saved 页面搜索。

现有 Runtime 已具备：

```text
memory_search
FTS
Semantic
Hybrid
```

设置页的数据管理界面也应该复用这个能力。

---

## Memory 编辑

当前 Scope Dialog 主要支持删除。

后续建议支持：

```text
编辑标题
编辑内容
修改作用范围
修改类型
```

---

## Recovery UI

增加：

```text
最近删除
```

用户不必通过：

```text
memory_restore
```

工具调用才能恢复。

---

# 34. 测试调整建议

现有：

```text
apps/desktop/src/renderer/memory-settings.test.ts
```

当前测试主要验证：

```text
Semantic Search
SQLite Linear Cosine
Skipped Secret
Rebuild Semantic Index
```

是否直接出现在页面。

重构后应改为验证产品行为。

---

## Overview tests

```text
显示 Memory 主开关
显示“所有项目”
显示“当前项目”
显示待确认数量
正常状态不展示 Content Hash
正常状态不展示 SQLite Linear Cosine
正常状态不展示 Evidence Max Tokens
```

---

## Advanced tests

```text
打开高级设置后显示：
Provider
Embedding Model
Search Mode
Recovery Retention
```

---

## Privacy tests

保持：

```text
选择 Remote Embedding Provider
→ 必须出现显式隐私确认
```

---

## Diagnostics tests

```text
status dirty
→ Overview 显示“需要修复”
→ Diagnostics 显示 Rebuild Index
```

---

# 35. 验收标准

此次优化不应该只以“页面变短”为标准。

建议验收：

## 普通用户

首次进入 Memory 页，不阅读文档也能回答：

```text
Memory 是什么？
现在开没开？
Jojo 会不会自动把东西保存进去？
它记住了什么？
怎么删？
```

---

## UI 复杂度

默认页面：

```text
≤ 5 个主要交互项
```

而不是当前的 20+。

---

## 高级能力

进入高级设置后，现有功能不能丢：

```text
Suggestions model
Semantic
Remote privacy
Context budget
Recovery
Index rebuild
```

---

## 安全边界

保持：

```text
Candidate 不自动写入 confirmed Memory
Rule 仍需明确确认
Remote Embedding 仍需明确授权
Forget 仍经过权限边界
Markdown 仍为权威数据源
```

---

# 36. 推荐最终产品文案

## 页面标题

```text
Memory
```

副标题：

```text
让 Jojo 在不同对话之间记住你的偏好、项目约束和重要决策。
```

---

## Suggestions

```text
发现值得记住的信息
```

说明：

```text
Jojo 会从对话中发现可能值得长期保留的信息，并在保存前让你确认。
```

---

## Global

```text
所有项目
```

说明：

```text
在所有项目中使用你的语言、工具和协作偏好。
```

---

## Project

```text
当前项目
```

说明：

```text
记住当前项目的约束、设计决策、经验和未完成事项。
```

---

## Health

正常：

```text
Memory 工作正常
```

异常：

```text
Memory 搜索需要修复
```

---

# 37. 推荐的新页面示意图

```text
┌────────────────────────────────────────────────────────────┐
│ Memory                                           已开启    │
│ 让 Jojo 在不同对话之间记住偏好、项目约束和重要决策。       │
│                                                            │
│ 启用 Memory                                      ●         │
├────────────────────────────────────────────────────────────┤
│ 发现值得记住的信息                                          │
│                                                            │
│ 从对话中发现 Memory 建议                         ●         │
│ 保存前始终需要你的确认。                           待确认 3 │
│                                              查看建议  →    │
├────────────────────────────────────────────────────────────┤
│ 使用范围                                                    │
│                                                            │
│ ● 所有项目                                                  │
│   语言、工具和协作偏好                                      │
│                                                            │
│ ● 当前项目                                                  │
│   当前项目的约束、决策和经验                                │
├────────────────────────────────────────────────────────────┤
│ 已保存                                                      │
│                                                            │
│ 所有项目                                      12 条         │
│ 当前项目                                       8 条         │
│                                              管理 Memory →  │
├────────────────────────────────────────────────────────────┤
│ ✓ Memory 工作正常                                           │
│                                                            │
│ 高级设置  >                                                 │
└────────────────────────────────────────────────────────────┘
```

---

# 38. 推荐的 Advanced 页面

```text
高级设置

记忆建议
  建议生成模型
  [自动：使用 Utility Model]

增强搜索
  [关闭 / 自动 / 自定义]

  自定义：
    Provider
    Embedding Model
    Search Mode

Memory 上下文
  Memory token 上限
  Context 最大占比

数据与恢复
  已删除 Memory 保留 30 天

Developer Options
  每回合最大候选
  Evidence Max Tokens
  Eligibility Score
  Semantic Candidate Limit
  Daily / Scratchpad Index
  Search Result Limit

Diagnostics
  FTS5 Trigram
  Semantic Index
  Scope Version
  Hash
  Path
  [Rebuild]
```

---

# 39. 最关键的产品原则

Jojo Agent 的 Memory Runtime 可以继续保持现在的完整能力：

```text
Markdown source of truth
FTS
Semantic Search
Candidate Governance
Snapshot
Rule Recall
Recovery
Index Rebuild
Global / Project Scope
```

但产品 UI 不应该要求用户理解这些东西以后才能正常使用 Memory。

推荐遵循：

```text
普通用户：
我希望 Jojo 记住重要信息。

高级用户：
我希望控制 Jojo 怎么记、怎么搜。

开发者：
我希望控制索引、token、threshold 和 backend。
```

三个角色不应该看到完全相同的默认界面。

---

# 40. 最终建议

优先实施 P0：

```text
MemorySettings.tsx
        ↓
Overview / Saved / Suggestions / Advanced
```

并遵守以下边界：

1. **默认页最多保留 4～5 个核心决策。**
2. **Memory 内容管理从参数设置中分离。**
3. **Provider / Embedding / FTS / Token / Threshold 默认隐藏。**
4. **诊断信息只在异常或用户主动展开时出现。**
5. **不削弱 Candidate 人工确认和 Remote Embedding 隐私确认。**
6. **第一阶段不修改 Runtime 和 Contracts，先完成 Renderer 信息架构重构。**

这样可以在很小的架构风险下，显著降低 Memory 的使用门槛，同时不牺牲 Jojo Agent 目前已经具备的高级 Memory 能力。

# jojo-agent Memory 系统设计

> 版本：v0.1 · 2026-08-22  
> 状态：设计草稿，对应 roadmap Phase 6  
> 参考来源：[earendil-works/pi](https://github.com/earendil-works/pi) · [open-octo/octo-agent](https://github.com/open-octo/octo-agent) · [jojo-agent 0.1.0 实现快照](https://github.com/zxt6991-source/jojo-agent)

---

## 1. 背景与动机

jojo-agent 当前（v0.1.0）已完成 Phase 1–4：对话循环、文件修改、MCP/Skills、CDP 浏览器控制。roadmap Phase 6 明确将"记忆"列为下一个大方向，但尚未有任何实现（`⬜ 长期记忆和向量数据库`）。

本文从工程角度回答三个问题：

1. **记什么**：记忆的分类、作用域和生命周期；
2. **怎么存**：存储格式、路径约定和版本策略；
3. **怎么用**：注入系统提示、Agent 工具、检索管道和 UI。

设计以"本地优先、人类可读、渐进增强"为核心原则，确保第一版不引入数据库依赖即可落地。

---

## 2. 参考设计分析

### 2.1 pi（earendil-works/pi）

pi 的记忆能力分两个层次：

**会话持久化（Session Persistence）**

- 每次会话自动保存到 `~/.pi/agent/sessions/`，按工作目录分组；
- 支持 `-c` 恢复最近会话、`--fork` 创建分支；
- 会话过长时执行 Compaction（上下文压缩），压缩结果成为下一轮起点。

**项目/账号级记忆（pi-chat 扩展）**

```
~/.pi/agent/chat/
└── accounts/<account>/
    ├── shared/
    │   └── memory.md          # 账号全局记忆，注入每次会话
    └── channels/<channel>/
        └── workspace/
            └── memory.md      # 频道/项目级记忆
```

- 两份 `memory.md` 在每次 Turn 开始时注入系统提示；
- Agent 可以写入这两个文件来持久化信息；
- 文件是纯 Markdown，可以 git commit、cat、grep。

**pi-mind 插件（shog-lab/pi-mind）**

- 知识存放在 `.pi-mind/knowledge/<date>-<slug>.md`；
- 混合检索：SQLite FTS5 关键词搜索 + 可选 Ollama 向量搜索；
- Agent 通过 `remember this:` 命令显式写入，检索时说明来源文件。

**pi 设计要点提炼**

| 要素 | 实现 |
|------|------|
| 格式 | 纯 Markdown 文件，人类可读可编辑 |
| 作用域 | 账号级 vs 项目级，泾渭分明 |
| 写入 | 显式（Agent 调用工具写文件） |
| 检索 | 文件直接注入 or FTS5 关键词搜索 |
| 扩展 | 向量搜索作为可选后端 |

### 2.2 octo-agent（open-octo/octo-agent）

octo 提供了更完整的系统提示分层机制，同时有自动提炼能力：

**系统提示层（后者覆盖前者）**

```
~/.octo/soul.md          # Agent 人格与行为基线
~/.octo/user.md          # 用户画像，每次会话注入
~/.octo/octorules.md     # 全局规则与偏好
.octorules               # 项目约定，octo init 生成，随项目 commit
--system "..."           # 单次临时覆盖
```

- 支持 `@include path/to/fragment.md` 组合分片；
- `octo init` 自动为当前仓库分析并生成 `.octorules`。

**跨会话记忆存储**

```
~/.octo/memories/        # 自动提炼的持久化记忆碎片
```

- 每次会话结束或上下文压缩时，自动提炼并写入 `memories/`；
- Agent 可通过工具显式追加/查询记忆；
- Web UI 提供 Memories 面板，可查看和删除。

**MCP Tool Search（大工具集延迟加载）**

- 所有工具的名称和单行描述始终在系统提示中列出；
- 仅当 Agent 调用 `mcp_describe` 时才加载完整 Schema；
- 这一模式同样适用于记忆检索：索引常驻，全文按需加载。

**octo 设计要点提炼**

| 要素 | 实现 |
|------|------|
| 格式 | Markdown 文件（rules/user）+ 结构化记忆碎片（memories/） |
| 分层 | soul → user → rules → project → 临时，后者权重更高 |
| 写入 | 自动提炼（会话后）+ 显式工具调用 |
| 注入 | 全量（规则/用户画像）+ 按需（知识碎片摘要） |
| UI | Web UI Memories 面板 |

### 2.3 对 jojo-agent 的启示

| 维度 | pi 的长处 | octo 的长处 | jojo-agent 应取 |
|------|-----------|-------------|-----------------|
| 格式 | 纯 Markdown，可 git commit | 同 | 纯 Markdown，无数据库依赖 |
| 作用域 | 账号 vs 项目二分 | 人格/用户/规则/项目四层 | 三层：全局 / 规则 / 项目，平衡复杂度与实用性 |
| 写入 | 显式 Agent 写文件 | 显式 + 会话后自动提炼 | 显式优先，自动提炼作为可选增强 |
| 检索 | FTS5（pi-mind） | 按摘要索引列举 | 摘要常驻 + 按需全文加载，FTS5 作 Phase 6.2 |
| 注入 | 文件直接注入 | 分层注入 | 分层注入，保持 Token 可控 |

---

## 3. 设计目标与原则

### 目标

1. **跨会话持久**：用户偏好、项目约定、学到的知识在会话重启后仍然有效；
2. **人类可读**：所有记忆以纯 Markdown 保存，用户可以直接 cat、grep、git commit；
3. **Token 可控**：系统提示膨胀有上限，超过阈值时检索替代全量注入；
4. **零强制依赖**：Phase 6.1 不引入 SQLite / 向量数据库，Phase 6.2 作为可选后端；
5. **与现有架构共生**：新建 `packages/memory/` 包，不污染 `agent-core`。

### 原则

- **显式优先**：Agent 写记忆需要 Permission Gate 批准，不自动静默写入；
- **作用域隔离**：全局记忆 vs 项目记忆不混用文件；
- **幂等写入**：相同内容多次写入不产生重复；
- **可审计**：记忆文件包含时间戳和来源会话 ID。

---

## 4. 记忆分类与作用域

### 4.1 三层记忆

```
层级        文件位置                         注入时机          生命周期
────────────────────────────────────────────────────────────────────────
全局画像     userData/memory/user.md          每次会话启动      手动管理
全局规则     userData/memory/rules.md         每次会话启动      手动管理
项目记忆     <工作目录>/.jojo/memory.md       会话绑定项目时    随项目 git
知识碎片     userData/memory/knowledge/       按需检索加载      自动 + 显式写入
────────────────────────────────────────────────────────────────────────
```

| 层 | 类比 | 典型内容 | 写入方式 |
|----|------|---------|---------|
| 全局画像 `user.md` | octo `user.md` | 姓名、技术栈、语言偏好、时区 | 用户手动或 `save_memory` 工具 |
| 全局规则 `rules.md` | octo `octorules.md` | 代码风格、不做列表、常用命令 | 用户手动或 `save_memory` 工具 |
| 项目记忆 `.jojo/memory.md` | pi-chat `workspace/memory.md` | 项目架构、已知坑、模型选择 | Agent 工具 + 用户手动 |
| 知识碎片 `knowledge/*.md` | pi-mind `.pi-mind/knowledge/` | 会话中学到的可复用事实 | 会话结束自动提炼 + 显式写入 |

### 4.2 文件路径约定

```
Electron userData/          （由 app.getPath('userData') 获取）
└── memory/
    ├── user.md
    ├── rules.md
    └── knowledge/
        ├── 20260822T143012-tsconfig-paths.md
        ├── 20260822T180055-electron-forge-quirks.md
        └── index.jsonl     # 摘要索引，每行一条知识碎片元信息

<项目工作目录>/
└── .jojo/
    └── memory.md           # 项目级记忆，建议 git commit
```

`index.jsonl` 格式（每行一个 JSON 对象）：

```jsonl
{"id":"20260822T143012-tsconfig-paths","title":"tsconfig paths 与 pnpm workspace 冲突","tags":["typescript","pnpm"],"summary":"在 monorepo 中使用 tsconfig paths 时…（50字以内）","session":"sess_abc123","ts":1724339412}
```

---

## 5. 存储格式

### 5.1 user.md / rules.md / project memory.md

自由 Markdown，无强制格式，建议在文件头加 YAML frontmatter 以便程序更新：

```markdown
---
updated: 2026-08-22T14:30:12Z
session: sess_abc123
---

## 用户画像
- 语言偏好：中文输出，代码注释可英文
- 常用技术栈：TypeScript、Electron、pnpm workspace

## 全局规则
- 代码修改前必须展示 diff，不跳过审批
- 不使用 `any`，优先收窄类型
```

### 5.2 知识碎片 `knowledge/<id>.md`

```markdown
---
id: 20260822T143012-tsconfig-paths
title: tsconfig paths 与 pnpm workspace 冲突
tags: [typescript, pnpm, monorepo]
session: sess_abc123
created: 2026-08-22T14:30:12Z
---

## 事实

在 pnpm workspace 中使用 `tsconfig paths` 映射内部包时，
Electron Forge 的 Vite 插件不会自动读取 `tsconfig.base.json`，
需要在每个应用的 `vite.config.ts` 中显式传入 `resolve.alias`。

## 来源

会话：sess_abc123（2026-08-22 14:30）  
触发：用户反馈构建失败，Agent 排查后写入。
```

### 5.3 版本与迁移

- 所有文件头包含 `schemaVersion`（frontmatter 字段）；
- 与现有 Session JSONL 迁移策略一致：读取时升级，写入时使用最新版；
- `knowledge/index.jsonl` 同样带 `schemaVersion`。

---

## 6. 系统提示注入策略

每次 Turn 开始前，Worker 在组装 `system` 字符串时，按以下顺序拼接（类比 octo 的分层机制）：

```
┌─────────────────────────────────────────────────────────────────┐
│ [Layer 0] Agent 固定人格（内置，不可覆盖）                        │
│  "你是 jojo-agent，一个本地桌面 Coding Agent..."                  │
├─────────────────────────────────────────────────────────────────┤
│ [Layer 1] 全局画像 user.md（若存在，≤ 1000 tokens）              │
├─────────────────────────────────────────────────────────────────┤
│ [Layer 2] 全局规则 rules.md（若存在，≤ 2000 tokens）             │
├─────────────────────────────────────────────────────────────────┤
│ [Layer 3] 项目记忆 .jojo/memory.md（若当前会话有工作目录）        │
├─────────────────────────────────────────────────────────────────┤
│ [Layer 4] 知识碎片摘要索引（知识条目数 > 0 时）                   │
│  "以下是你过去学到的可复用知识摘要，可通过 load_memory 获取详情"  │
│  • [20260822] tsconfig paths 与 pnpm workspace 冲突              │
│  • [20260820] Electron Forge pkg 在 Linux CI 上的 deb 问题       │
├─────────────────────────────────────────────────────────────────┤
│ [Layer 5] 当前会话工具、Skills、MCP 清单（已有机制，保持不变）    │
└─────────────────────────────────────────────────────────────────┘
```

**Token 预算策略**

| 层 | 硬上限 | 超出时 |
|----|--------|--------|
| user.md | 1 000 tokens | 截断并附 `[截断，完整内容见 user.md]` |
| rules.md | 2 000 tokens | 截断 |
| project memory.md | 2 000 tokens | 截断 |
| 知识索引摘要 | 500 tokens | 只显示最近 N 条 |
| 知识碎片全文（`load_memory` 返回） | 3 000 tokens/条 | 截断 |

---

## 7. 记忆写入流程

### 7.1 显式写入（Phase 6.1 核心）

Agent 调用 `save_memory` 工具，经 Permission Gate 批准后写入：

```
用户发起请求
    ↓
Agent 决定需要保存某条信息
    ↓
调用 save_memory(scope, title, content, tags?)
    ↓
Permission Gate → approval.required → UI 弹窗
    ↓
用户批准
    ↓
写入对应 Markdown 文件 + 更新 index.jsonl
    ↓
返回成功 ToolResult
```

`scope` 取值：

| scope | 写入位置 |
|-------|---------|
| `user` | `userData/memory/user.md` |
| `rules` | `userData/memory/rules.md` |
| `project` | `<cwd>/.jojo/memory.md` |
| `knowledge` | `userData/memory/knowledge/<id>.md` |

### 7.2 会话结束自动提炼（Phase 6.2）

会话完成（`turn.completed` 且 `stopReason === 'end_turn'`）后，在后台运行一次轻量提炼：

```
会话结束
    ↓
Worker 读取本轮对话历史摘要（由 Compaction 机制已有）
    ↓
调用 LLM（同一 Provider，低消耗 model）
    prompt: "从以下对话中提炼值得跨会话保留的技术事实（≤3条）..."
    ↓
若有可提炼内容 → 在 UI 显示 Toast：
    "本轮对话有 2 条知识可以保存，是否保存？[是] [跳过]"
    ↓
用户确认 → 写入 knowledge/
用户跳过 → 丢弃
```

自动提炼始终需要用户确认，不静默写入。

---

## 8. 记忆检索

### 8.1 摘要常驻（Phase 6.1）

`knowledge/index.jsonl` 的摘要字段（50 字以内）始终附在系统提示 Layer 4。

Agent 不需要搜索，可以直接看到所有知识碎片的标题和摘要，然后通过 `load_memory(id)` 获取全文。

### 8.2 按需全文加载

```typescript
// Agent 工具调用
load_memory({ id: "20260822T143012-tsconfig-paths" })
// 返回该 .md 文件的全文，注入到下一条 ToolResult
```

### 8.3 关键词搜索（Phase 6.2，可选）

引入 `better-sqlite3`（已在 Electron 环境有先例），建立 FTS5 虚拟表：

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  id,
  title,
  content,
  tags,
  content="memory_entries",
  content_rowid="rowid"
);
```

Agent 工具：`search_memory({ query: "tsconfig paths" })` → 返回匹配条目摘要列表。

此阶段 Markdown 文件仍为唯一数据源，SQLite 只是搜索加速的次级索引，可随时从文件重建。

### 8.4 向量语义搜索（Phase 6.3，可选）

通过 MCP 服务（如本地 Ollama embedding）或云端 embedding API 生成向量，存入 SQLite vector 扩展（libsql/vectorlite）。

不在 Phase 6.1 引入，作为插件能力。

---

## 9. Agent 工具集

新增四个工具，归入 `packages/tools-node/src/memory/` 目录：

### `save_memory`

```typescript
{
  name: "save_memory",
  description: "将重要信息持久化到记忆中，跨会话保留。",
  inputSchema: z.object({
    scope: z.enum(["user", "rules", "project", "knowledge"]),
    title: z.string().max(80).describe("知识标题，50 字以内"),
    content: z.string().max(4000).describe("知识正文，Markdown 格式"),
    tags: z.array(z.string()).optional().describe("可选标签，用于检索")
  })
}
```

- 权限：始终需要用户批准（类比 terminal）；
- 幂等：相同 title + scope 的条目先检查是否已存在，存在则提示是否覆盖。

### `load_memory`

```typescript
{
  name: "load_memory",
  description: "加载指定 ID 的知识碎片全文，或加载 user/rules/project 层记忆。",
  inputSchema: z.object({
    id: z.string().describe("knowledge/<id> 或 'user' | 'rules' | 'project'")
  })
}
```

- 权限：读操作，工作目录内记忆默认允许，不需要审批。

### `list_memories`

```typescript
{
  name: "list_memories",
  description: "列出所有已保存的知识碎片摘要。",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20)
  })
}
```

- 返回 `knowledge/index.jsonl` 的最近 N 条记录（id、title、tags、summary、ts）。

### `search_memory`（Phase 6.2）

```typescript
{
  name: "search_memory",
  description: "通过关键词搜索知识库（FTS5）。",
  inputSchema: z.object({
    query: z.string().max(200)
  })
}
```

---

## 10. 包架构与依赖

### 10.1 新增 `packages/memory/`

```
packages/memory/
├── src/
│   ├── index.ts          # 导出公开 API
│   ├── manager.ts        # MemoryManager 主类
│   ├── injector.ts       # 系统提示注入，组装 Layer 1–4
│   ├── writer.ts         # 写入 Markdown + 更新 index.jsonl
│   ├── loader.ts         # 读取单条或全量
│   ├── extractor.ts      # 会话后自动提炼（Phase 6.2）
│   └── schema.ts         # Zod schema（与 contracts 共享）
├── __tests__/
└── package.json
```

### 10.2 依赖关系

```
packages/memory/
  ↓ 依赖
packages/contracts/    (MemoryEntry, MemoryScopeType, IPC schema)
packages/storage/      (文件路径解析，userData 获取)

packages/tools-node/
  ↓ 依赖
packages/memory/       (save_memory / load_memory / list_memories 实现)
packages/contracts/

apps/desktop/worker/
  ↓ 依赖
packages/memory/       (injector.ts 组装系统提示)
```

**不允许的依赖**：

- `packages/memory/` 不依赖 `agent-core`（保持 agent-core 干净）；
- `packages/memory/` 不依赖 Electron（由 Worker 通过 `storage` 获取路径）；
- Renderer 不直接读写记忆文件，只通过 IPC 消费摘要和操作结果。

### 10.3 MemoryManager 接口

```typescript
export interface MemoryManager {
  // 组装系统提示片段（Layer 1–4）
  buildSystemPromptLayers(context: {
    workDir?: string;
    tokenBudget: number;
  }): Promise<MemoryPromptLayers>

  // 写入
  save(entry: MemorySaveRequest): Promise<MemoryEntry>

  // 读取
  load(id: string): Promise<MemoryEntry | null>
  list(limit?: number): Promise<MemoryEntrySummary[]>

  // 搜索（Phase 6.2，可选）
  search?(query: string): Promise<MemoryEntrySummary[]>
}
```

---

## 11. IPC 契约扩展

在 `packages/contracts/src/ipc.ts` 中新增以下 IPC 通道：

```typescript
// Renderer → Main → Worker
export const MemoryIPC = {
  listMemories:   "memory:list",          // → MemoryEntrySummary[]
  loadMemory:     "memory:load",          // id → MemoryEntry | null
  deleteMemory:   "memory:delete",        // id → void
  saveMemory:     "memory:save",          // MemorySaveRequest → MemoryEntry
  getMemoryLayers:"memory:layers",        // → MemoryPromptLayers（调试用）
} as const;
```

Approval（`approval.required`）机制对记忆写入同样生效，沿用现有 Permission Gate 协议，`toolName: "save_memory"` 识别。

---

## 12. UI 设计

### 12.1 记忆面板（Memory Panel）

在现有左侧栏（会话列表）下方新增"记忆"入口，或在设置页中以标签形式呈现：

```
┌─ 记忆 ──────────────────────────────────┐
│ 用户画像       →  [查看 / 编辑]           │
│ 全局规则       →  [查看 / 编辑]           │
│ 知识库  (12条) →  [查看全部]              │
│                                          │
│ 知识库列表（按时间倒序）                  │
│ ● tsconfig paths 与 pnpm workspace 冲突  │
│   2026-08-22 · typescript, pnpm          │
│   [加载] [删除]                           │
│ ● Electron Forge Linux deb 打包问题      │
│   2026-08-20 · electron, ci             │
│   [加载] [删除]                           │
└──────────────────────────────────────────┘
```

### 12.2 会话结束提炼 Toast

会话结束时，若自动提炼模块发现可保存内容，在消息列表底部弹出非阻塞 Toast：

```
╔══════════════════════════════════════╗
║  💡 本轮对话发现 2 条可复用知识          ║
║  • tsconfig paths 与 pnpm 冲突         ║
║  • Electron Forge deb 打包注意事项      ║
║                          [保存] [跳过] ║
╚══════════════════════════════════════╝
```

点击"保存"触发 `memory:save` IPC，批量写入 knowledge/。

### 12.3 approve 弹窗扩展

`save_memory` 的审批弹窗在现有审批组件基础上，展示记忆条目的标题和摘要预览，允许用户编辑后再确认。

---

## 13. 安全约束

| 约束 | 实现 |
|------|------|
| 写入必须审批 | `save_memory` 经 Permission Gate，`decision: 'ask'` |
| 不注入敏感信息 | API Key、密码等不允许写入任何记忆层（writer.ts 过滤） |
| 项目记忆路径限制 | `.jojo/memory.md` 只允许在当前工作目录内，真实路径校验 |
| 读取权限 | 工作目录内记忆默认允许；全局记忆由 Worker 直接读取，不经 Renderer |
| IPC 参数校验 | 所有 memory IPC 通道参数经 Zod 校验（与现有机制一致） |
| 文件大小上限 | 单条知识碎片 ≤ 100 KB；user.md / rules.md ≤ 50 KB |

---

## 14. 实现里程碑（对应 Phase 6）

### Phase 6.1：记忆基础（2–3 周）

**M6.1-a：存储与注入**（1 周）

- [ ] 新建 `packages/memory/`，实现 `MemoryManager` 接口；
- [ ] `injector.ts` 组装 Layer 1–4 并接入 Worker 系统提示；
- [ ] `load_memory`、`list_memories` 工具（只读，不需审批）；
- [ ] IPC 通道：`memory:list`、`memory:load`；
- [ ] UI：记忆面板基础版（list + 查看）。

验收：Agent 可以读取 `rules.md` 中的规则，在新会话中遵守。

**M6.1-b：显式写入**（1 周）

- [ ] `save_memory` 工具 + Permission Gate 接入；
- [ ] `writer.ts` 写入 Markdown + 更新 `index.jsonl`；
- [ ] IPC 通道：`memory:save`、`memory:delete`；
- [ ] UI：审批弹窗扩展（预览记忆内容）；
- [ ] 单元测试：幂等写入、文件大小上限、路径安全。

验收：Agent 在会话中发现值得记住的事实，经审批后写入知识碎片，下次会话系统提示中可见摘要。

**M6.1-c：项目记忆初始化**（0.5 周）

- [ ] `jojo init` 命令（或 UI 按钮）分析当前项目并生成 `.jojo/memory.md` 草稿；
- [ ] 会话启动时自动加载项目记忆到 Layer 3。

验收：为 jojo-agent 自身仓库运行 `jojo init`，生成包含架构说明的 `.jojo/memory.md`，新会话 Agent 能正确引用其中内容。

---

### Phase 6.2：检索增强（1–2 周）

- [ ] 引入 `better-sqlite3`（评估 Electron 兼容性），建立 FTS5 索引；
- [ ] `search_memory` 工具；
- [ ] `knowledge/index.jsonl` → SQLite 迁移脚本（可从文件重建）；
- [ ] 会话结束自动提炼 Toast（LLM 提炼 + 用户确认）；
- [ ] CI：增加 memory 读写离线单元测试。

---

### Phase 6.3：向量语义搜索（可选，视需求而定）

- [ ] 通过 MCP 服务对接本地 Ollama embedding；
- [ ] 扩展 `search_memory` 支持语义模式；
- [ ] 向量索引存入 SQLite vector 扩展（libsql/vectorlite），Markdown 文件仍为权威数据源。

---

## 15. 技术风险与应对

| 风险 | 应对 |
|------|------|
| 记忆内容过多撑爆 Token 预算 | Layer 1–4 各有硬上限；知识碎片只注入索引摘要，全文按需加载 |
| 自动提炼质量差（Phase 6.2） | 使用确认弹窗而非静默写入；提炼失败不影响主流程 |
| `.jojo/memory.md` 被 git 暴露敏感信息 | 文档明确说明不应写入密码/Key；生成 `.gitignore` 模板提示用户选择是否提交 |
| `better-sqlite3` 在 Electron 中的 native binding 兼容 | 评估时期先用纯 JSONL 实现；FTS5 作为可选后端，不影响基础功能 |
| 文件写入与 Renderer IPC 的并发 | 所有写入经 Worker 串行执行，不允许 Renderer 直接操作文件 |
| 知识碎片无限膨胀 | `list_memories` 默认限制 50 条；UI 提供删除；无自动淘汰（Phase 6.3 可加 TTL 或容量上限） |

---

## 附录 A：系统提示示例

```
你是 jojo-agent，一个本地桌面 Coding Agent。
[... 固定人格 ...]

---
## 用户画像
- 语言偏好：中文输出，代码注释可英文
- 技术栈：TypeScript、Electron、pnpm monorepo

---
## 全局规则
- 代码修改前必须展示 diff，不跳过审批
- 不使用 `any`，优先收窄类型
- Terminal 命令执行前确认工作目录

---
## 项目记忆（jojo-agent）
- packages/memory/ 为新增包，不依赖 Electron
- Agent Core 不感知记忆层，由 Worker 注入
- 测试使用 Vitest，在临时目录执行文件操作

---
## 知识库摘要（3 条）
你过去学到的可复用知识，可通过 load_memory(id) 获取详情：
• [20260822] tsconfig-paths：pnpm monorepo 中需在 vite.config.ts 显式配置 alias
• [20260820] forge-linux-deb：Linux CI 打包需设置 DISPLAY=:99 才能执行 Electron
• [20260815] zod-v4-migration：Zod v4 移除了 z.string().nonempty()，改用 z.string().min(1)

---
[已发现工具列表 ...]
```

---

## 附录 B：与 roadmap 的对应关系

| roadmap Phase 6 条目 | 本文覆盖位置 |
|---------------------|-------------|
| 用户明确保存的偏好和规则 | §4 全局规则层 `rules.md` + §7.1 显式写入 |
| 主题记忆按需加载 | §8.1 摘要常驻 + §8.2 按需全文加载 |
| 可选语义记忆后端 | §8.4 Phase 6.3 向量搜索 |
| 定时任务和唤醒 | 超出本文范围，Phase 6 另立文档 |
| 后台任务面板 | 超出本文范围 |
| 通知、托盘和开机启动 | 超出本文范围 |
| 无人值守任务使用更严格权限模式 | §13 安全约束提及，具体设计随 Phase 6 进展补充 |

# Jojo Agent Memory M6：Semantic Retrieval 与 Hybrid Search 技术设计

> 文档版本：v1.0  
> 阶段：Memory M6  
> 前置条件：M0–M5 已完成  
> 目标项目：`zxt6991-source/jojo-agent`  
> 上位设计：`jojo-agent-memory-final-design.md` v1.1  
> 状态：可进入实验实现；默认关闭

---

# 1. 阶段目标

M6 为 Jojo Memory 增加语义检索，但不改变两个基础原则：

```text
Markdown = Source of Truth
FTS      = 必须保留的可解释检索
```

Semantic Retrieval 只解决：

> 用户没有使用与 Memory 完全相同的关键词时，如何仍然找到语义相关的历史决策、经验和偏好。

例如 Memory 中：

```text
“Writable Sub-Agent 使用独立 Worktree，结果不自动 merge。”
```

用户问：

```text
“为什么后台修改代码不能直接落到主分支？”
```

纯关键词 FTS 可能召回较弱，Semantic Search 可以补充。

最终检索：

```text
FTS Retrieval
      +
Semantic Retrieval
      ↓
Hybrid Fusion
      ↓
Policy / Scope Ranking
      ↓
Top K
```

---

# 2. 非目标

M6 不做：

```text
完整 Session 全文向量化
代码仓库全文向量化
网页缓存全文 embedding
向量数据库成为 Memory 真源
自动把 Semantic Hit 当 Rule
LLM 每次强制 rerank
默认将 Memory 发送给远程 Embedding
```

---

# 3. 为什么 FTS 必须保留

Semantic Search 有几个天然问题：

- 结果不如关键词命中可解释；
- Embedding Model 升级会导致索引失效；
- 远程 Provider 有隐私外发；
- 中文/代码/路径/版本号等 exact token 仍然适合关键词；
- Semantic Similarity 高不代表事实仍然有效；
- Rule / Scope / Confirmed 状态不能由向量距离决定。

所以：

```text
Semantic
    ≠
Replacement for FTS
```

而是：

```text
Semantic
    =
Recall Expansion
```

---

# 4. 总体架构

```text
                    Query
                      │
              Normalize / Policy
                      │
         ┌────────────┴────────────┐
         │                         │
         ▼                         ▼
     FTS5 Search             Semantic Search
     BM25 / trigram          Embedding similarity
         │                         │
         └────────────┬────────────┘
                      ▼
                Rank Fusion
                      │
                      ▼
            Scope / Kind Boost
                      │
                      ▼
              Dedup / Filters
                      │
                      ▼
                   Top K
                      │
                      ▼
              memory_search
```

---

# 5. Semantic Backend 抽象

M6 不把某个向量库硬编码到 `packages/memory`。

接口：

```ts
export interface SemanticMemoryBackend {
  capabilities(): Promise<SemanticCapabilities>;

  ensureIndexed(
    input: SemanticIndexRequest
  ): Promise<SemanticIndexResult>;

  search(
    input: SemanticSearchRequest
  ): Promise<SemanticSearchHit[]>;

  remove(
    input: SemanticRemoveRequest
  ): Promise<void>;

  rebuild(
    input: SemanticRebuildRequest
  ): Promise<SemanticRebuildResult>;
}
```

Capabilities：

```ts
export type SemanticCapabilities = {
  enabled: boolean;

  mode:
    | 'local-linear'
    | 'local-vector'
    | 'remote-vector';

  embeddingProviderId: string;
  embeddingModel: string;

  dimensions?: number;

  supportsIncrementalIndex: boolean;
};
```

---

# 6. 第一版推荐 Backend

M6 第一版建议不要立即引入复杂 Native Vector Extension。

推荐先实现：

```text
Embedding Provider
      ↓
SQLite Embedding Table
      ↓
Bounded Local Linear Cosine Search
```

即：

```text
sqlite-embedding-linear
```

优点：

- 不增加第二套 Native ABI；
- 与现有 `node:sqlite` 保持一致；
- 实现简单；
- 容易测试；
- Memory 是精选知识，不是百万级文档库；
- 可以通过 Eval 判断是否真的需要 HNSW / sqlite-vec。

当规模超过阈值后，再增加：

```text
SemanticMemoryBackend
    └── sqlite-vec / vectorlite / external backend
```

而不改上层接口。

---

# 7. SQLite Embedding Schema

```sql
CREATE TABLE memory_embeddings (
  chunk_id TEXT PRIMARY KEY,

  entry_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,

  source_file TEXT NOT NULL,
  heading TEXT,

  content_hash TEXT NOT NULL,

  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,

  embedding_blob BLOB NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX memory_embeddings_scope
ON memory_embeddings(scope_id);

CREATE INDEX memory_embeddings_entry
ON memory_embeddings(entry_id);
```

`embedding_blob` 使用：

```text
Float32Array bytes
```

---

# 8. Embedding Index 不是 Source of Truth

唯一真源仍然：

```text
Markdown
```

Embedding Row 通过：

```text
source_file
entry_id
content_hash
```

关联。

如果：

```text
current Memory content_hash
    !=
embedding.content_hash
```

则：

```text
embedding stale
```

必须忽略或重新索引。

---

# 9. Embedding Model Fingerprint

索引必须绑定：

```text
provider
model
dimensions
normalization version
chunking version
```

定义：

```ts
export type EmbeddingIndexFingerprint = {
  providerId: string;
  model: string;
  dimensions: number;

  chunkingVersion: number;
  normalizationVersion: number;
};
```

任何字段变化：

```text
旧索引不再参与新查询
```

后台逐步 rebuild。

---

# 10. Chunking

M3 FTS 已按 Markdown Heading 切分。

M6 应复用同一个 `MemoryChunk`，避免 FTS 与 Semantic 使用两套边界。

```ts
export type MemoryChunk = {
  id: string;

  entryId: string;
  scopeId: string;

  file: string;
  headingPath: string[];

  kind: MemoryKind;

  title?: string;
  content: string;

  contentHash: string;
  updatedAt: number;
};
```

---

# 11. Chunk 大小

建议：

```text
目标 200～500 tokens
最大 800 tokens
```

优先边界：

```text
Entry metadata block
Heading
List item group
Paragraph
```

禁止跨 Rule Entry 拼接。

Confirmed Rule 必须保持独立 Chunk。

---

# 12. Embedding 文本

不要只 embedding `content`。

推荐：

```text
Title: ...
Kind: decision
Scope: project
Heading: Architecture / Runtime
Content:
...
```

但不要嵌入：

```text
绝对 canonicalPath
sessionId
operationId
secret metadata
recovery data
```

Provenance 保留在数据库元数据，不进入向量文本。

---

# 13. 哪些 Memory 做 Embedding

默认：

```text
preference
constraint
decision
fact
lesson
procedure
active rule
```

可选：

```text
recent task
recent daily handoff
```

默认不做：

```text
recovery
expired candidate
rejected candidate
raw scratchpad history
```

Open Scratchpad 如果参与 Semantic，应设置较低排名权重。

---

# 14. Embedding Provider

```ts
export interface EmbeddingProvider {
  id: string;
  model: string;

  embed(
    texts: string[],
    options?: {
      signal?: AbortSignal;
    }
  ): Promise<{
    vectors: Float32Array[];
    usage?: EmbeddingUsage;
  }>;
}
```

不要复用 Chat Model Interface。

Embedding 是独立 Provider Capability。

---

# 15. Local 与 Remote

## 15.1 Local

例如：

```text
Ollama
Local embedding service
Bundled provider（未来）
```

默认优先。

## 15.2 Remote

只有用户明确启用后可使用。

UI 必须展示：

```text
此功能会将选中的 Memory 文本发送给 <Provider>
```

并说明：

```text
不发送 Session 全文
不发送仓库全文
只发送需要索引的 Memory Chunk
```

---

# 16. Privacy Boundary

远程 Embedding 前：

```text
Memory Chunk
    ↓
Secret Scanner
    ↓
Sensitive Field Filter
    ↓
Remote Embedding
```

命中 Secret：

```text
不发送
```

该 Chunk：

```text
semanticIndexState = skipped_secret
```

仍然可以 FTS 搜索。

---

# 17. Index Job

M6 复用 `memory_jobs`：

```text
kind = semantic_index
```

Dedupe：

```text
semantic_index:<chunkId>:<contentHash>:<fingerprint>
```

状态：

```text
pending
running
completed
failed
skipped
```

索引失败不影响 Memory Write 成功。

---

# 18. 增量索引

Memory Write 成功：

```text
Markdown
  ↓
FTS Update
  ↓
enqueue semantic index job
```

不要在用户等待 `memory_write` Tool 返回时强制完成远程 Embedding。

推荐：

```text
write success
semantic index = async derived projection
```

---

# 19. 删除

`memory_forget` 后：

```text
删除对应 FTS projection
删除对应 embedding rows
```

如果删除 Semantic Row 失败：

```text
mark stale / cleanup job
```

Semantic Search 每次还应校验 active Entry，防止 stale vector 被召回。

---

# 20. Rebuild

```text
scan canonical Markdown
    ↓
parse chunks
    ↓
compare contentHash
    ↓
skip unchanged
    ↓
embed changed/new
    ↓
delete orphan vectors
```

支持：

```text
cancel
resume
progress
```

---

# 21. Query Embedding

查询：

```text
memory_search("为什么后台 Agent 不直接改主分支")
```

只有当：

```text
semantic.enabled = true
```

才生成 Query Embedding。

只 embedding `search query string`，不发送整个 User Message History。

---

# 22. Semantic Search

对于 `local-linear`：

```text
SQL Scope / Kind Filter
        ↓
Load bounded vectors
        ↓
cosine(query, vector)
        ↓
Top N
```

必须先按 Scope / Kind 在 SQL 层过滤，避免扫描所有 Scope。

---

# 23. 性能边界

Linear Backend 适用于精选 Memory。

建议默认：

```text
max semantic candidate vectors = 10,000
```

如果超限：

```text
memory_semantic_backend_capacity_exceeded
```

降级：

```text
FTS only
```

不要让一次查询加载无限向量。

---

# 24. 向量缓存

Worker 可以维护 LRU Vector Cache。

Key：

```text
chunkId + contentHash + modelFingerprint
```

缓存只是性能优化，不得成为唯一索引。

---

# 25. Hybrid Retrieval

不建议直接：

```text
0.7 * cosine + 0.3 * BM25
```

因为 BM25 与 cosine 数值区间不可直接比较。

推荐：

```text
Reciprocal Rank Fusion (RRF)
```

例如：

```ts
score =
  wFts / (k + ftsRank)
  +
  wSemantic / (k + semanticRank);
```

推荐初始：

```text
k = 60
wFts = 1.0
wSemantic = 1.0
```

再增加确定性业务 Boost。

---

# 26. Rank Fusion

完整：

```text
FTS Top 20
Semantic Top 20
       ↓
RRF
       ↓
Project Scope Boost
       ↓
Confirmed / Active Status Filter
       ↓
Kind / Recency Minor Boost
       ↓
Dedup by Entry
       ↓
Top 5
```

Project > Global 只做轻度 Boost，不应把不相关 Project Result 强行排第一。

---

# 27. Exact Match 保护

以下类型必须强烈保护关键词结果：

```text
文件路径
命令
版本号
错误码
函数名
ID
包名
```

例如：

```text
memory_conflict
node:sqlite
pnpm
```

FTS exact phrase 命中时给予高优先级。

Semantic 不能把相似概念排在 exact fact 前面。

---

# 28. Rule Retrieval

Confirmed Always Rules 仍然由 Snapshot 管理。

Triggered Rules 仍然由 deterministic matcher 管理。

```text
Semantic similarity
    ≠
Rule trigger
```

Semantic Search 可以搜索 Rule 供 Agent 阅读，但不能改变自动规则执行。

---

# 29. Search API

扩展：

```ts
export type MemorySearchInput = {
  query: string;

  scope?: 'project' | 'global' | 'all';

  kinds?: MemoryKind[];

  limit?: number;

  mode?:
    | 'fts'
    | 'semantic'
    | 'hybrid';
};
```

若 Semantic Enabled：

```text
mode default = hybrid
```

否则：

```text
hybrid → fts
```

---

# 30. Search Result

```ts
export type MemorySearchHit = {
  id: string;

  scope: 'global' | 'project';

  kind: MemoryKind;

  title?: string;
  snippet: string;

  sourceFile: string;
  heading?: string;

  updatedAt: string;

  retrieval: {
    ftsRank?: number;
    semanticRank?: number;
    semanticSimilarity?: number;
    fusedScore: number;

    modes: Array<'fts' | 'semantic'>;
  };
};
```

UI 可以解释：

```text
Matched by:
  keyword + semantic
```

---

# 31. Auto Recall

M6 仍不建议默认开启自动语义召回。

若未来开启：

```text
UserPromptSubmit
   ↓
Local eligibility
   ↓
Hybrid Search
   ↓
high confidence only
   ↓
Top <= 3
```

限制：

```text
总注入 <= 8 KiB
本地超时预算约 <= 200 ms
低置信度不注入
不修改 System Prefix
```

Remote Semantic Auto Recall 默认禁止。

---

# 32. LLM Rerank

M6 默认：

```text
OFF
```

只有 Eval 证明 RRF 不够时才加入。

未来接口：

```ts
interface MemoryReranker {
  rerank(query, hits): Promise<...>;
}
```

不能成为基础依赖。

---

# 33. Staleness

Semantic Hit 返回前必须验证：

```text
Entry active?
contentHash current?
scope enabled?
```

如果过期：

```text
drop
enqueue reindex
```

绝不能把已经 Forget 的旧向量继续返回。

---

# 34. Embedding Model 切换

用户从 Model A 切换到 Model B 时，不立即删除 A 索引。

流程：

```text
new fingerprint active
old fingerprint inactive
background rebuild
```

Query 只使用 active fingerprint。

Rebuild 完成后 GC 旧模型向量。

---

# 35. Settings

```ts
export type SemanticMemorySettings = {
  enabled: boolean;

  mode:
    | 'local-linear'
    | 'plugin-vector';

  providerId?: string;
  model?: string;

  remoteAllowed: boolean;

  searchMode:
    | 'fts'
    | 'semantic'
    | 'hybrid';

  maxSemanticCandidates: number;

  indexDaily: boolean;
  indexScratchpad: boolean;

  rerankEnabled: boolean;
};
```

默认：

```ts
{
  enabled: false,
  mode: 'local-linear',
  remoteAllowed: false,
  searchMode: 'hybrid',
  maxSemanticCandidates: 10000,
  indexDaily: false,
  indexScratchpad: false,
  rerankEnabled: false,
}
```

---

# 36. Provider Permission / UI

如果 Provider 是 Remote，第一次启用时必须展示：

```text
Semantic Memory 会把 Memory 中的文本片段发送给该 Embedding Provider。
不会发送完整 Session 或完整仓库。
```

用户明确确认后保存 Setting。

这不是每次 Chunk 的 Tool Approval，而是产品级隐私配置。

Secret Scanner 仍逐 Chunk 生效。

---

# 37. Usage

Embedding Usage 单独：

```text
cause = memory_embedding
```

统计：

```text
indexed chunks
query embeddings
input tokens
provider cost
```

不能混进主 Chat Model Usage。

---

# 38. Embedding Concurrency

增加独立：

```text
EmbeddingExecutionScheduler
```

或者轻量 Semaphore。

不要占 AgentExecutionScheduler。

Rebuild Job 应低优先级，不影响前台 Agent。

---

# 39. Failure Strategy

```text
Embedding Provider unavailable
    → FTS only

Query Embedding fail
    → FTS only

Index stale
    → FTS + valid semantic rows

Vector decode fail
    → drop row + rebuild

Semantic backend capacity exceeded
    → FTS only + warning

Remote permission disabled
    → semantic disabled
```

Semantic Search 失败不能让 `memory_search` 整体失败，只要 FTS 可用。

---

# 40. 错误码

新增：

```text
memory_semantic_disabled
memory_embedding_provider_unavailable
memory_embedding_failed
memory_embedding_invalid_dimension
memory_embedding_index_stale
memory_semantic_backend_capacity_exceeded
memory_semantic_rebuild_failed
memory_remote_embedding_not_allowed
```

---

# 41. 事件

```text
memory.embedding.job.queued
memory.embedding.completed
memory.embedding.failed

memory.semantic.search.started
memory.semantic.search.completed
memory.semantic.search.fallback

memory.semantic.rebuild.started
memory.semantic.rebuild.progress
memory.semantic.rebuild.completed

memory.semantic.model.changed
```

日志不记录 Chunk 正文。

---

# 42. UI

Memory Settings：

```text
Semantic Search: Off / On
Provider
Model
Local / Remote
Indexed Chunks
Pending
Failed
Skipped Secret
Rebuild Index
```

Search Tool Card：

```text
Hybrid Search
  FTS: yes
  Semantic: yes

Result 1
  matched by keyword + semantic

Result 2
  matched by semantic
```

保持可解释。

---

# 43. Plugin Vector Backend

如果后续需要高性能 ANN：

```ts
SemanticMemoryBackend
```

保持不变。

可新增：

```text
sqlite-vec
vectorlite
local service
external vector store
```

`packages/memory` 不直接依赖具体实现。

---

# 44. 安全

Semantic Index 不能扩大 Memory 权限。

要求：

```text
Forget 后旧向量不可召回
Project Scope 不跨项目泄露
Sub-Agent 仍只搜索允许 Scope
Remote Embedding 受用户配置
Secret 不发送
Candidate 不默认进入 Semantic Index
Recovery 不进入索引
```

---

# 45. 测试

Index：

```text
同 contentHash 不重复 embedding
内容变化产生新 embedding
模型 fingerprint 变化触发 rebuild
orphan vector cleanup
forget 删除 semantic projection
```

Search：

```text
同义改写能召回
Exact token 仍由 FTS 优先
Project scope 不泄露
Global + Project 正确融合
Stale vector 被过滤
```

Fallback：

```text
Provider down → FTS
Remote permission off → FTS
Vector capacity exceeded → FTS
corrupt vector → drop + FTS
```

Privacy：

```text
Secret Chunk 不发送 remote
完整 Session 不进入 embedding
canonical path 不进入 embedding text
Recovery 不索引
```

---

# 46. Retrieval Eval

建立测试集：

```text
query
expected memory ids
scope
query type
```

Query Type：

```text
exact keyword
semantic paraphrase
Chinese paraphrase
path / error code
old decision
user preference
negative / no-match
```

指标：

```text
Recall@5
MRR
Precision@5
No-Match False Positive Rate
Latency P50/P95
Embedding Cost
FTS-only vs Hybrid Delta
```

---

# 47. 上线门槛

Semantic 默认开启前至少证明：

```text
Hybrid Recall@5
    > FTS Recall@5

且

Exact Query Precision
    不显著下降

且

P95 latency 可接受

且

No-match False Positive
    不明显恶化
```

如果提升不明显，保持默认关闭。

---

# 48. 实施步骤

## M6.1 Backend Interface

```text
EmbeddingProvider
SemanticMemoryBackend
Embedding fingerprint
SQLite embedding schema
```

## M6.2 Incremental Index

```text
Chunk reuse
Index jobs
Write / Forget integration
Rebuild
```

## M6.3 Search

```text
Query embedding
Local cosine
FTS + semantic
RRF
Search explainability
```

## M6.4 Privacy / UI

```text
Remote opt-in
Secret filtering
Usage
Index status
```

## M6.5 Eval

```text
Retrieval dataset
Recall@5
MRR
Latency
Cost
```

## M6.6 Optional ANN Backend

只有线性搜索无法满足规模后再做。

---

# 49. 验收标准

M6 第一版完成必须满足：

1. Semantic 默认关闭；
2. Markdown 仍是唯一 Source of Truth；
3. FTS 永远可独立工作；
4. Semantic Backend 可以完全移除而不影响基础 Memory；
5. 只 embedding Memory Chunk，不 embedding Session / Repo 全文；
6. 远程 Embedding 明确 Opt-In；
7. Secret Chunk 不外发；
8. Embedding 与 contentHash / model fingerprint 绑定；
9. Forget 后旧向量不能召回；
10. Hybrid 使用可解释 Rank Fusion；
11. Exact token 结果不被 Semantic 轻易压制；
12. Provider 失败自动降级 FTS；
13. Eval 能量化 Hybrid 相对 FTS 的真实收益。

---

# 50. 一句话结论

> **M6 的目标不是“给 Memory 加一个向量数据库”，而是在不改变 Markdown 真源和 FTS 基线的前提下，通过可插拔 Embedding Backend 扩展模糊召回能力，并用 Hybrid/RRF、严格 Scope、隐私边界和可降级机制保证语义搜索只是增强，而不是新的单点依赖。**

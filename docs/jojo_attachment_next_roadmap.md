# Jojo Agent 附件资源系统后续开发路线

> 文档状态：Roadmap / Implementation Plan  
> 基线提交：`667f9fd56e92596f3b270158fe2e1ccb80ce7cdd`  
> 基线提交说明：`feat: 文档上传优化`  
> 适用项目：`zxt6991-source/jojo-agent`  
> 前置文档：`docs/jojo_attachment_resource_design.md`

---

# 1. 当前基线

截至基线提交，Jojo 的附件系统已经完成首阶段资源化改造：

```text
File
 ↓
LocalAttachmentStore
 ↓
AttachmentId
 ↓
FileContentBlock
 ├── optional preview
 └── stable local path
```

当前已经具备：

- `type: file` 内容块；
- `FileAttachmentRef`；
- `LocalAttachmentStore`；
- 原始附件持久化；
- UUID Attachment ID；
- `~/.jojo/attachments/v1` 存储目录；
- 任意普通文件上传；
- 单文件最大 512 MiB；
- PDF / Excel / HTML / Text Preview；
- Preview 与原附件解耦；
- JSONL Session 持久化；
- Session reload 后恢复附件；
- Provider 根据 `attachmentId` 解析本地路径；
- Agent 可通过现有文件工具读取原附件；
- 旧 `type: text + attachment` 格式兼容；
- Composer / 历史消息 UI 已适配资源型附件。

因此，后续开发重点不再是“支持文件上传”，而是把当前首版实现升级为：

```text
Persistent Attachment Resource
        +
Extractor Registry
        +
Execution Projection
        +
Streaming / Digest / Dedupe
        +
Lifecycle / GC
        +
Advanced Extractors
```

---

# 2. 后续总体目标

最终目标：

```text
User File
   │
   ▼
Upload / Import
   │
   ▼
AttachmentStore
   │
   ├── immutable bytes
   ├── digest
   ├── metadata
   ├── lifecycle
   └── provider-independent ref
            │
            ▼
      AttachmentRef
            │
     ┌──────┴────────────┐
     │                   │
     ▼                   ▼
Extractor            Access Resolver
     │                   │
     ▼                   ▼
 Preview        execution-visible path
     │                   │
     ▼                   ▼
LLM context       read/bash/python/tools
```

要求：

1. 附件的存储、解析、模型序列化、执行环境访问彻底解耦；
2. 本地 Desktop、`jojo serve`、远程 Agent、容器执行使用同一附件抽象；
3. 大文件导入不进入 JS 全量内存；
4. 相同文件可去重；
5. Session 删除后附件资源可安全回收；
6. 已知格式自动提供 Preview；
7. 未知格式仍然保持可操作；
8. 高级解析功能通过插件式 Extractor 扩展。

---

# 3. 推荐开发顺序

建议按以下优先级推进：

```text
M2.1 Extractor Registry
        ↓
M4.1 Attachment Access / Projection
        ↓
M5.1 Streaming Store
        ↓
M5.2 SHA256 + Dedupe
        ↓
M5.3 Lifecycle / GC
        ↓
M6 Advanced Extractors
        ↓
M7 Remote / Serve Attachment Transport
```

不要优先堆：

```text
DOCX
PPTX
OCR
ZIP Preview
```

因为当前最重要的问题已经从“格式支持不足”变成：

> Attachment Store 与本地 Provider / filesystem 耦合仍然较强。

---

# 4. M2.1：Extractor Registry

## 4.1 当前问题

当前解析入口仍然集中在：

```text
apps/desktop/src/main/attachment-preview.ts
```

核心形式仍是：

```ts
extractText(data, extension)
```

然后：

```ts
if (extension === 'pdf') ...
if (spreadsheet) ...
else ...
```

虽然已经实现：

```text
Attachment Resource
≠
Preview
```

但 Extractor 本身还没有插件化。

---

## 4.2 目标

引入统一：

```ts
AttachmentExtractor
```

和：

```ts
AttachmentExtractorRegistry
```

最终结构：

```text
Attachment
   ↓
ExtractorRegistry
   ↓
supports(metadata)
   ↓
Extractor
   ↓
AttachmentPreview
```

---

## 4.3 推荐目录

新增：

```text
packages/
└── attachment-extractors/
    ├── package.json
    ├── src/
    │   ├── types.ts
    │   ├── registry.ts
    │   ├── text-extractor.ts
    │   ├── html-extractor.ts
    │   ├── pdf-extractor.ts
    │   ├── spreadsheet-extractor.ts
    │   └── index.ts
    └── test/
```

逐步移除 Desktop Main 对具体解析实现的直接依赖。

---

## 4.4 推荐接口

```ts
export interface AttachmentMetadata {
  attachmentId: AttachmentId;
  name: string;
  bytes: number;
  extension?: string;
  mimeType?: string;
}

export interface AttachmentExtractInput {
  metadata: AttachmentMetadata;
  openStream(): Promise<NodeJS.ReadableStream>;
  getPath?(): Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface AttachmentExtractor {
  id: string;

  priority?: number;

  supports(
    metadata: AttachmentMetadata
  ): boolean;

  extract(
    input: AttachmentExtractInput
  ): Promise<AttachmentPreview | undefined>;
}
```

Registry：

```ts
export interface AttachmentExtractorRegistry {
  register(extractor: AttachmentExtractor): void;

  find(
    metadata: AttachmentMetadata
  ): AttachmentExtractor | undefined;

  extract(
    input: AttachmentExtractInput
  ): Promise<AttachmentPreview | undefined>;
}
```

---

## 4.5 内置 Extractor

第一阶段迁移：

```text
TextExtractor
HtmlExtractor
PdfExtractor
SpreadsheetExtractor
```

映射：

```text
txt/md/json/source → TextExtractor
html/htm           → HtmlExtractor
pdf                → PdfExtractor
xlsx/xls/...       → SpreadsheetExtractor
```

---

## 4.6 行为要求

Extractor 异常：

```text
EXTRACT_FAILED
```

只能影响：

```text
preview
```

不能影响：

```text
attachment resource
```

即：

```text
Store Success
Extractor Failure
        ↓
Attachment = usable
Preview = unavailable
```

---

## 4.7 验收标准

必须新增测试：

```text
✓ Registry priority
✓ unsupported extension returns undefined
✓ extractor error does not invalidate attachment
✓ PDF extractor
✓ spreadsheet extractor
✓ HTML extractor
✓ binary pretending to be text
✓ AbortSignal cancellation
```

---

# 5. M4.1：Attachment Access / Projection

## 5.1 当前问题

当前 Provider 直接调用：

```ts
resolveAttachmentPath(attachmentId)
```

也就是说：

```text
Provider
  ↓
LocalAttachmentStore
  ↓
Host filesystem path
```

当前 Desktop 本地运行没有问题，但未来：

```text
jojo serve
Docker
SSH Agent
remote runtime
sandbox
```

会出现：

```text
Host path
≠
Agent execution path
```

例如：

```text
Host:
~/.jojo/attachments/v1/files/att_x/original/a.zip

Container:
路径不存在
```

---

## 5.2 目标

引入统一附件访问抽象：

```text
AttachmentRef
     ↓
AttachmentAccessResolver
     ↓
Execution Projection
     ↓
Path / Stream / Unavailable
```

Provider 不再直接依赖：

```text
@desktop-agent/attachments
```

---

## 5.3 推荐接口

新增 package：

```text
packages/
└── attachment-access/
```

接口：

```ts
export interface AttachmentAccessContext {
  sessionId: string;
  workingDirectory?: string;
  executionId?: string;
}

export type AttachmentAccess =
  | {
      kind: 'path';
      path: string;
      readonly: boolean;
    }
  | {
      kind: 'stream';
      open(): Promise<NodeJS.ReadableStream>;
    }
  | {
      kind: 'unavailable';
      reason: string;
    };

export interface AttachmentAccessResolver {
  resolve(
    ref: FileAttachmentRef,
    context: AttachmentAccessContext
  ): Promise<AttachmentAccess>;
}
```

---

## 5.4 Desktop Local Resolver

第一实现：

```ts
class LocalAttachmentAccessResolver
```

流程：

```text
attachmentId
 ↓
LocalAttachmentStore
 ↓
getPath()
 ↓
kind:path
```

---

## 5.5 Container Projection

未来实现：

```ts
class ContainerAttachmentAccessResolver
```

行为：

```text
AttachmentStore host file
        ↓
bind mount / copy
        ↓
container path
```

例如：

```text
host:
~/.jojo/attachments/v1/...

container:
/mnt/jojo-attachments/att_x/report.xlsx
```

---

## 5.6 SSH / Remote Projection

可实现：

```text
Attachment
 ↓
remote staging
 ↓
scp / stream upload
 ↓
remote temp path
```

然后返回：

```ts
{
  kind: 'path',
  path: '/tmp/jojo/attachments/...'
}
```

---

## 5.7 Provider 改造

当前：

```text
Provider
 ↓
resolveAttachmentPath
```

改为：

```text
Runtime
 ↓
AttachmentAccessResolver
 ↓
构造模型可见 handle
```

Provider 只接收已经解析好的：

```ts
ModelAttachmentDescriptor
```

例如：

```ts
interface ModelAttachmentDescriptor {
  name: string;
  bytes: number;
  preview?: AttachmentPreview;
  access:
    | { kind: 'path'; path: string }
    | { kind: 'unavailable'; reason: string };
}
```

---

# 6. M5.1：Streaming Attachment Store

## 6.1 当前问题

当前：

```ts
copyFile(source, object)
```

虽然不会把 512 MiB 文件整体放进 JS Heap，但 API 仍然依赖：

```text
本机 source path
```

无法直接支持：

```text
Web upload
RPC
remote client
ReadableStream
serve mode
```

---

## 6.2 目标

AttachmentStore 增加：

```ts
saveStream()
```

并让：

```text
saveFile(path)
```

变成其本地 convenience wrapper。

---

## 6.3 推荐接口

```ts
export interface SaveAttachmentStreamInput {
  name: string;
  stream: AsyncIterable<Uint8Array>;
  expectedBytes?: number;
  signal?: AbortSignal;
}

export interface AttachmentStore {
  saveFile(...): Promise<FileAttachmentRef>;

  saveStream(
    input: SaveAttachmentStreamInput
  ): Promise<FileAttachmentRef>;

  openFile(...): Promise<NodeJS.ReadableStream>;

  ...
}
```

---

## 6.4 实现流程

```text
ReadableStream
   ↓
bounded chunks
   ↓
temporary object
   ↓
byte count
   ↓
digest calculation
   ↓
fsync / close
   ↓
atomic rename
```

必须保证：

```text
中途失败
→ 删除 staging
→ 不发布 metadata
```

---

## 6.5 Backpressure

必须避免：

```text
producer
→ 无限 push
→ memory growth
```

推荐：

```text
for await (const chunk of stream)
```

顺序写入。

---

## 6.6 取消

使用：

```ts
AbortSignal
```

取消后：

```text
close stream
delete temp object
delete temp metadata
```

---

# 7. M5.2：SHA256 + Content Addressing + Dedupe

## 7.1 当前问题

现在每次上传：

```text
same file
 ↓
different UUID
 ↓
different object
```

会产生重复存储。

---

## 7.2 目标布局

推荐：

```text
~/.jojo/attachments/v2/
├── objects/
│   └── ab/
│       └── abcdef123456...
│
└── refs/
    └── att_xxx/
        ├── metadata.json
        └── original/
            └── report.xlsx
```

对象：

```text
sha256(content)
```

Ref：

```text
AttachmentId
```

两者不要混为一个概念。

推荐：

```text
AttachmentId = att_uuid
ObjectDigest = sha256:...
```

原因：

- 一个 object 可以对应多个文件名；
- 一个 object 可以对应多个 Session attachment ref；
- metadata / preview / relativePath 属于 ref，不属于 object。

---

## 7.3 Metadata

建议增加：

```ts
interface FileAttachmentRef {
  type: 'file';

  attachmentId: AttachmentId;

  digest?: string;

  name: string;

  bytes: number;

  ...
}
```

Store 内部 metadata：

```json
{
  "attachmentId": "att_x",
  "digest": "sha256:abc...",
  "name": "report.xlsx",
  "bytes": 123456
}
```

---

## 7.4 Dedupe

保存：

```text
hash calculated
 ↓
object exists?
 ├─ yes → reuse
 └─ no  → atomic publish
```

需要处理并发：

```text
two uploads same bytes simultaneously
```

建议：

```text
temp file
 ↓
rename
 ↓
EEXIST
 ↓
delete temp
 ↓
reuse existing object
```

---

## 7.5 完整性验证

当前只校验：

```text
size
```

升级后：

```text
size
+
digest
```

必要时：

```text
openFile()
```

可选择：

```text
fast path:
只验证 metadata + stat

strict path:
重新 hash
```

---

# 8. M5.3：Attachment Lifecycle / GC

## 8.1 当前问题

当前附件不会自动删除。

可能产生：

```text
选择文件
 ↓
保存 Store
 ↓
用户移除附件
 ↓
orphan
```

以及：

```text
Session 删除
 ↓
附件仍存在
```

长期会导致：

```text
~/.jojo/attachments
```

无限增长。

---

## 8.2 推荐模型

不要使用简单 ref count。

因为：

```text
Session JSONL
branch
fork
clone
backup
```

都可能引用同一附件。

推荐：

```text
Mark & Sweep
```

---

## 8.3 GC 流程

```text
扫描所有 Session
 ↓
收集 attachmentId
 ↓
Mark
 ↓
扫描 attachment refs
 ↓
未被引用 + 超过 grace period
 ↓
删除 ref
 ↓
扫描 object digest
 ↓
无 ref 引用
 ↓
删除 object
```

---

## 8.4 Grace Period

建议：

```text
24h 或 7d
```

不要附件一失去引用就立即删除。

避免：

```text
发送失败
Session 写入失败
UI retry
```

造成资源丢失。

---

## 8.5 Draft 生命周期

后续引入：

```text
DraftAttachment
```

状态：

```text
selected
uploading
stored
submitted
abandoned
```

未提交附件可以：

```text
24h 后清理
```

---

# 9. M6：高级 Extractor

在资源层完成后，再扩展解析能力。

---

## 9.1 DOCX

推荐：

```text
.docx
 ↓
mammoth
 ↓
plain text / markdown-like preview
```

可提取：

- 段落；
- 标题；
- 表格文本；
- 简单列表。

不需要第一阶段保留完整样式。

---

## 9.2 PPTX

推荐：

```text
pptx zip
 ↓
slide XML
 ↓
ordered slide text
```

输出：

```text
[幻灯片 1]
标题...
正文...

[幻灯片 2]
...
```

重点：

```text
保持 slide 顺序
```

---

## 9.3 OCR PDF

当前：

```text
PDF no text
→ warning
```

升级为：

```text
PDF
 ↓
text layer?
 ├─ yes → PdfExtractor
 └─ no
     ↓
OCR Extractor
```

OCR 建议作为可选能力，不要强依赖主包。

2026-09-06 决策：暂停 OCR 开发，已回滚宿主机工具适配方案。后续方案不得要求用户在宿主机安装 Poppler、Tesseract。

---

## 9.4 Archive Preview

ZIP/TAR 可增加轻量：

```text
ArchiveManifestExtractor
```

只输出：

```text
文件列表
大小
目录结构
```

不要自动解压全部内容进入 Prompt。

---

## 9.5 SQLite Preview

可以生成：

```text
tables
columns
row count estimate
```

但不要自动 dump 整库。

---

## 9.6 Extractor 安全原则

所有高级 Extractor：

```text
只读
bounded output
bounded time
AbortSignal
```

必须有限制：

```text
max files
max pages
max rows
max cells
max extracted chars
timeout
```

---

# 10. M7：Serve / Remote Attachment Transport

这个阶段与 `jojo serve` 强相关。

---

## 10.1 问题

Desktop 当前附件是：

```text
local filesystem path
```

如果：

```text
Browser
 ↓
jojo serve
 ↓
remote Agent
```

浏览器 File 并不存在于 Server filesystem。

---

## 10.2 需要增加 Upload API

推荐：

```text
POST /api/attachments
```

请求：

```text
multipart
or
raw streaming body
```

返回：

```json
{
  "attachmentId": "att_x",
  "name": "report.xlsx",
  "bytes": 123456
}
```

---

## 10.3 上传过程

```text
Client File
 ↓
HTTP stream
 ↓
AttachmentStore.saveStream()
 ↓
AttachmentRef
 ↓
Session message
```

Client 不应该发送：

```text
base64 in JSON
```

因为会：

```text
+33% size
+
full buffering
```

---

## 10.4 上传凭证

为了避免客户端伪造：

```text
attachmentId
```

推荐：

```text
upload
 ↓
staged receipt
 ↓
submit message
 ↓
server resolves receipt
 ↓
durable AttachmentRef
```

可以参考：

```text
DeepSeek Harness staged receipt
```

---

# 11. Model Context 序列化改造

当前 Provider 自己构造：

```text
name
size
path
preview
```

后续建议抽成统一函数：

```ts
serializeAttachmentForModel()
```

但该函数不应该直接访问 Local Store。

输入：

```ts
{
  ref,
  access
}
```

输出：

```text
[附件]
name: ...
size: ...
path: ...
preview: ...
[附件结束]
```

---

# 12. Attachment Handle 格式

建议统一：

```text
<jojo_attachment>
id: att_x
name: report.xlsx
size: 183920
path: /...
readonly: true
preview: available
</jojo_attachment>
```

注意：

```text
id
```

对模型可选。

如果模型不需要 Attachment ID，可仅给 path。

---

# 13. Read Tool 改造

当前附件可使用现有 ReadFileTool。

建议后续增加：

```ts
read({
  path,
  offset,
  limit
})
```

并对大文本：

```text
2000 lines
or
50 KB
```

截断。

返回：

```text
Showing lines 1-2000 of 12345.
Use offset=2001 to continue.
```

这样可以吸收 Pi 的 Lazy Read 优点。

---

# 14. 不建议新增 read_attachment

当前阶段不建议：

```text
read_attachment
```

原因：

```text
Attachment
 ↓
execution path
 ↓
read/bash/python
```

已经足够。

除非未来：

```text
remote backend
```

没有可投影 filesystem path。

届时：

```text
AttachmentAccess.kind = stream
```

可以再增加内部 bridge。

---

# 15. Workspace Copy

建议增加显式：

```text
copy_attachment_to_workspace
```

或者 Runtime helper。

因为 Attachment Store 应继续只读。

流程：

```text
Attachment immutable file
 ↓
copy
 ↓
workspace
 ↓
edit
```

推荐接口：

```ts
copyAttachmentToWorkspace({
  attachmentId,
  destination
})
```

必须防：

```text
path traversal
overwrite
```

---

# 16. MIME Detection

当前主要依赖：

```text
extension
```

后续建议增加：

```text
magic byte sniffing
```

生成：

```ts
mimeType
```

但不要用 MIME 决定：

```text
是否允许上传
```

只用于：

- Preview Extractor 选择；
- 图片验证；
- UI 展示；
- 安全处理。

---

# 17. Attachment Metadata 版本化

建议 metadata 增加：

```ts
schemaVersion: 1
```

例如：

```json
{
  "schemaVersion": 1,
  "attachmentId": "...",
  "digest": "...",
  "name": "...",
  "bytes": 123
}
```

方便后续：

```text
v1 UUID store
→ v2 digest store
```

迁移。

---

# 18. Store 版本升级策略

不要直接破坏：

```text
~/.jojo/attachments/v1
```

建议：

```text
attachments/
├── v1/
└── v2/
```

或者：

```text
storeVersion
```

实现 lazy migration。

旧 Session 的：

```text
att_uuid
```

必须继续可读取。

---

# 19. 错误模型扩展

建议统一：

```text
ATTACHMENT_NOT_FOUND
ATTACHMENT_CORRUPTED
ATTACHMENT_TOO_LARGE
ATTACHMENT_UPLOAD_FAILED
ATTACHMENT_STORE_FAILED
ATTACHMENT_ACCESS_UNAVAILABLE
ATTACHMENT_PROJECTION_FAILED
ATTACHMENT_EXTRACT_FAILED
ATTACHMENT_EXTRACT_TIMEOUT
ATTACHMENT_UNSUPPORTED_PREVIEW
ATTACHMENT_CANCELLED
```

不要用普通 Error 文本承担协议语义。

---

# 20. UI 后续状态

建议附件卡加入：

```text
uploading
stored
extracting
ready
preview-unavailable
failed
```

示例：

```text
report.xlsx
184 KB
✓ 已保存
✓ 已生成预览
```

```text
archive.zip
32 MB
✓ 已保存
○ 无自动预览
```

```text
large.bin
511 MB
✓ 已保存
○ 不生成预览
```

---

# 21. 进度与取消

Streaming 后 UI 应显示：

```text
上传 32%
```

允许：

```text
cancel
```

取消：

```text
AbortSignal
 ↓
stop HTTP / stream
 ↓
delete staging
```

---

# 22. 测试体系

后续每阶段都必须扩充：

```text
Unit
Integration
E2E
Migration
Failure Injection
```

---

## 22.1 Extractor Registry

```text
✓ selection
✓ priority
✓ error isolation
✓ timeout
✓ cancellation
```

---

## 22.2 Streaming Store

```text
✓ 0 bytes
✓ 1 byte
✓ 512 MiB boundary
✓ stream abort
✓ producer error
✓ disk error
✓ source length mismatch
✓ no whole-buffer read
```

---

## 22.3 Digest

```text
✓ same bytes = same digest
✓ concurrent same upload
✓ corrupted object
✓ metadata digest mismatch
```

---

## 22.4 GC

```text
✓ referenced survives
✓ orphan removed
✓ grace period
✓ shared object survives
✓ deleted sessions release refs
```

---

## 22.5 Projection

```text
✓ desktop local path
✓ missing attachment
✓ container mapped path
✓ remote unavailable
✓ readonly behavior
```

---

# 23. 性能指标

建议增加 benchmark：

```text
100 MB file
500 MB file
1000 small files
50 attachments/message
20 MB PDF
20 MB XLSX
```

监控：

```text
peak RSS
import time
preview time
store throughput
hash throughput
```

目标：

```text
大文件保存时 JS Heap 不随文件体积线性增长
```

---

# 24. 安全检查

必须继续保持：

```text
filename sanitize
symlink reject
regular file only
readonly object
path traversal reject
```

增加：

```text
TOCTOU handling
digest validation
safe projection path
archive bomb prevention
extractor timeout
```

---

# 25. 推荐 PR 拆分

不要一次做完。

---

## PR 1：Extractor Registry

范围：

```text
packages/attachment-extractors
registry
text/html/pdf/spreadsheet migration
tests
```

不改变用户行为。

---

## PR 2：Attachment Access Resolver

范围：

```text
AttachmentAccessResolver
Local resolver
Provider decoupling
runtime integration
tests
```

目标：

```text
Provider 不再 import LocalAttachmentStore
```

---

## PR 3：Streaming Store

范围：

```text
saveStream
AbortSignal
staging
atomic publish
```

暂不加 digest 去重。

---

## PR 4：SHA256 + Object Store v2

范围：

```text
digest
content address
dedupe
metadata version
v1 compatibility
```

---

## PR 5：GC

范围：

```text
session attachment scanner
mark/sweep
grace period
orphan cleanup CLI
```

建议提供：

```bash
jojo attachments gc
jojo attachments stats
```

---

## PR 6：DOCX / PPTX Extractor

范围：

```text
DOCX
PPTX
tests
```

---

## PR 7：Serve Upload Transport

范围：

```text
HTTP upload
progress
cancel
staged receipt
remote session attachment
```

---

# 26. CLI 建议

后续可增加：

```bash
jojo attachments list
jojo attachments info <id>
jojo attachments stats
jojo attachments verify
jojo attachments gc
```

示例：

```bash
jojo attachments stats
```

输出：

```text
Objects:      132
References:   158
Total size:   4.2 GB
Orphans:      6
Orphan size:  128 MB
```

---

# 27. 可观测性

建议日志统一：

```text
attachment.import
attachment.store
attachment.extract
attachment.resolve
attachment.project
attachment.gc
```

字段：

```text
attachmentId
digest
bytes
extractor
durationMs
sessionId
result
```

不要记录：

```text
用户文件完整内容
```

---

# 28. 与 Jojo Serve 的结合

未来建议：

```text
jojo serve
```

直接复用：

```text
AttachmentStore
AttachmentUploadService
AttachmentAccessResolver
```

不要 Desktop 和 Serve 各实现一套附件逻辑。

推荐：

```text
packages/
├── attachments
├── attachment-extractors
├── attachment-access
└── attachment-upload
```

Desktop：

```text
native path importer
```

Serve：

```text
HTTP stream importer
```

最后都进入同一个：

```text
AttachmentStore
```

---

# 29. 最终目标架构

```text
                         Client
                           │
                 ┌─────────┴──────────┐
                 │                    │
              Desktop                Web
                 │                    │
           local path             HTTP stream
                 │                    │
                 └─────────┬──────────┘
                           ▼
                  AttachmentUpload
                           │
                           ▼
                   AttachmentStore
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
           Object       Metadata      Digest
              │
              ▼
        AttachmentRef
              │
      ┌───────┴─────────────┐
      │                     │
      ▼                     ▼
ExtractorRegistry     AccessResolver
      │                     │
      ▼                     ▼
   Preview          Execution Projection
      │                     │
      ▼                     ▼
LLM fast context     read/bash/python
```

---

# 30. 阶段完成度定义

建议后续以以下状态管理：

```text
M2.1 Extractor Registry          DONE（2026-09-05）
M4.1 Attachment Access          DONE（2026-09-05）
M5.1 Streaming Store            DONE（2026-09-05）
M5.2 SHA256 + Dedupe             DONE（2026-09-05）
M5.3 GC                         DONE（离线 CLI，2026-09-05）
M6.1 DOCX                       DONE（2026-09-06）
M6.2 PPTX                       DONE（2026-09-06）
M6.3 OCR                        TODO（暂停；已回滚宿主机工具方案）
M6.4 Archive Preview            DONE（ZIP / 基础 TAR，2026-09-06）
M6.5 SQLite Preview             DONE（基础结构与历史行数估计，2026-09-06）
M7.1 Serve Upload               DONE（API / SDK，2026-09-06）
M7.2 Remote Projection          PARTIAL（Docker 只读挂载 Resolver，2026-09-06）
```

---

## M2.1 实施记录（2026-09-05）

已完成 PR 1 范围：

- 新增 `packages/attachment-extractors`，提供统一输入、Registry、优先级选择和内置 Text / HTML / PDF / Spreadsheet Extractor。
- Desktop 导入器通过 Registry 生成 Preview，不再直接实现格式分支；存储先完成，解析失败仅产生预览警告。
- 保留 20 MiB 预览输入限制、50,000 字符单预览限制及 200,000 字符消息总预算；读取流时校验实际字节数。
- 提供结构化解析失败、超时、取消错误；取消关闭内置输入流并销毁 PDF 任务。
- 新增 Registry / 内置解析测试及资源保留集成测试。同步第三方解析器仍采用协作式取消，硬中断依赖 Desktop 现有 Worker 外层限制。

验证结果：全量单元/集成测试 824 通过、2 跳过；附件 Electron E2E 2 通过；`pnpm typecheck`、`pnpm lint`、Desktop E2E 构建通过。

本阶段后续为 PR 2（M4.1 Attachment Access Resolver），现已完成，见下方记录。

---

## M4.1 实施记录（2026-09-05）

已完成 PR 2 范围，Attachment M2 里程碑完成：

- 新增 `packages/attachment-access`，定义 Path / Stream / Unavailable 访问契约、执行上下文和请求级投影函数。
- 提供独立入口 `attachment-access/local` 的 Local Resolver；Desktop 主运行时、编排运行时及 Server 显式配置本地访问。
- Runtime 在每次模型请求前解析附件并传递 `ModelAttachmentDescriptor`；按请求去重，不跨执行缓存，不将路径写回 Session。
- Provider 移除对 Local Store 的运行时依赖，改用纯函数 `serializeAttachmentForModel`；保留内容顺序、每个内容块的 Preview 和只读提示。
- 缺少 Resolver、资源缺失及远程投影失败时只返回不可用访问，保留 Preview；Stream 暂不打开，待后续桥接。
- 验证本地文件权限、模拟容器映射、取消、错误隔离、JSONL 恢复、后续轮次重新解析及持久消息不含执行路径。

验证结果：全量测试 830 通过、2 跳过；附件 Electron E2E 2 通过；类型检查、Lint、Desktop E2E 构建通过。

范围说明：本阶段提供本地实现与可替换契约，未实现真实容器挂载、SSH staging 或流式工具桥接。后续 PR 3（M5.1 Streaming Store）已完成，见下方记录。

---

## M5.1 实施记录（2026-09-05）

已完成 PR 3 范围：

- `AttachmentStore.saveStream()` 接收异步字节流、可选预期字节数与 AbortSignal；`saveFile()` 复用流式实现。
- 使用背压、64 KiB 分块写入、实际字节计数、临时资源、fsync 与原子发布；保留 v1 布局和只读文件权限。
- 保存失败、长度不符或取消时清理 staging 和已创建 object；清理失败明确报错，不静默忽略。
- 文件路径导入拒绝符号链接和非普通文件，校验打开的 inode，避免读取时重新打开已被替换的路径。
- 取消能退出挂起的异步迭代器读取；Node 流主动销毁，通用生产者仍需自行配合释放外部资源。
- 新增 15 项测试：空文件、1 字节、实际 512 MiB 边界及超限、背压、挂起取消、生产者错误、磁盘写入/fsync/发布失败、长度不符和发布前不可见。

验证结果：全量测试 845 通过、2 跳过；取消监听调整后 Store 19 项测试通过；附件 Electron E2E 2 通过；类型检查、Lint 和 Desktop 构建通过。

本阶段不包含 SHA256、去重或上传 UI。后续 PR 4（M5.2 SHA256 + Object Store v2）已完成，见下方记录。

---

## M5.2 实施记录（2026-09-05）

已完成 PR 4 范围，Attachment M3 里程碑完成：

- 流式写入时计算 SHA256；`AttachmentId` 保持 UUID，`digest` 独立表示内容身份。
- 新增 v2 布局：`objects/<前两位>/<hash>` 与 `refs/<id>/metadata.json + original/<name>`；metadata 使用 `schemaVersion: 2`。
- 相同内容通过硬链接共用只读对象，保留独立名称和引用；原子、不覆盖的对象发布支持并发上传，复用前校验已有对象。
- `getPath()` 校验大小及引用/object inode 一致性；`verify()` 和 `openFile({ strict: true })` 重新计算摘要，发现内容损坏。
- 默认写入 `~/.jojo/attachments/v2`，兼容读取同级 v1；显式根目录兼容原有 `files/` 数据，也可显式传入独立 legacy root；不改写旧附件。
- v1 没有历史摘要，verify 仅返回计算出的 digest 与 `verified: false`，不宣称完整性验证成功。
- 引用发布失败时清理 staging，但不删除已发布的共享对象；无引用对象交由后续 GC 回收，避免并发误删。
- 新增内容寻址、并发去重、空文件摘要、同大小损坏、metadata 错配、v1 兼容和并发发布失败测试。

验证结果：全量测试 852 通过、2 跳过；附件 Electron E2E 2 通过；类型检查、Lint、Desktop 构建通过。

本阶段不包含 GC；严格校验发生在返回读取流之前，不提供对抗外部并发修改的文件系统快照。后续 PR 5（M5.3 Lifecycle / GC）已完成，见下方记录。

---

## M5.3 实施记录（2026-09-05）

已完成 PR 5 的离线清理范围：

- 新增 JSONL / Runtime SQLite 引用扫描器，扫描全部分支、操作状态及指定备份中的 attachmentId，不只检查活动会话路径。
- 新增 v1/v2 Mark & Sweep、默认 7 天宽限期与对象字节统计；实际硬链接也参与保护，仍有引用或 staging 链接的共享对象不删除。
- 提供 `jojo attachments stats` 与 `jojo attachments gc`；显式传入所有 `--root` 和完整 `--source`，默认只预览，`--apply --offline` 才执行清理。
- 任何引用源缺失、JSON 损坏、SQLite schema 不匹配或附件元数据异常，均在删除前终止；不会把读取失败当作无引用。
- 新增引用保护、孤儿回收、宽限期、共享对象、会话删除、SQLite 恢复记录、v1、staging 链接保护以及 CLI 测试。

验证结果：全量测试 859 通过、2 跳过；类型检查、Lint、CLI 构建及构建后命令帮助检查通过。清理测试仅使用临时目录，未运行用户真实附件清理。

范围限制：`--offline` 是调用者对所有写入进程已停止的声明，不是自动锁定；必须提供所有共享此 Store 的资料源。`.pending-*` 临时目录暂不自动删除。未引入后台 GC、Draft UI 状态或在线并发清理协议。

下一步按 PR 顺序为 DOCX / PPTX Extractor；Serve Upload 与真实远程 Projection 尚未完成，Attachment M4 整体仍未完成。

---

## M6.1 / M6.2 实施记录（2026-09-06）

已完成 PR 6 的 DOCX / PPTX 文本预览：

- 默认 Registry 新增 DOCX / PPTX Extractor；共享有界 OOXML ZIP/XML 读取器，不需要 Desktop 新增格式分支。
- DOCX 提取段落、标题/列表文本和表格单元格文本；PPTX 根据 presentation relationship 保留真实页面顺序，并标注幻灯片编号。
- 本实现直接解析正文 OOXML，未采用建议中的 Mammoth；目标仍是纯文本 Preview，不保留完整样式、列表编号或视觉布局。
- 限制 ZIP 条目数、单 XML / 总 XML 字节、XML 嵌套深度、节点数与最多 200 页；拒绝 DTD/实体声明、重复条目、外部页面关系和加密正文。
- 新增 13 项 Office 单测与 1 项 Desktop 导入集成测试；附件 E2E 增加 DOCX/PPTX 发送与会话恢复内容检查。

验证结果：全量测试 873 通过、2 跳过；附件 Electron E2E 2 通过；类型检查、Lint、Desktop 构建通过。

范围：不包含 OCR、备注页、图表渲染、页眉页脚或 Office 排版。解析失败仍保留原附件。后续阶段为 Serve Upload / Remote Projection，其他高级解析器按需求推进。

---

## M7.1 实施记录（2026-09-06）

已完成 PR 7 的 Server API / SDK 范围：

- 新增 `POST /api/v1/sessions/:sessionId/attachments?name=...`，与现有版本化路由对齐，接收 `application/octet-stream` 原始流。
- 复用 AttachmentStore 流式保存及默认 Extractor；请求断开传播取消，解析失败仍返回可用原附件。
- 生成绑定 principal / Session / AttachmentId 的随机凭证；有效期一小时、可重试、内存保存，服务重启后未提交凭证失效。
- HTTP / WebSocket 启动 Run 均由 Core 校验凭证并还原服务器元数据；客户端伪造的名称、字节数和 Preview 不进入持久消息。
- SDK 新增 Blob/File 上传和 AbortSignal；浏览器 XHR 路径支持传输进度，fetch 路径仅报告完成。
- 新增真实 HTTP 上传（超过 JSON 默认限额）、断开清理、鉴权、会话不匹配、WebSocket 拒绝、凭证过期和元数据覆盖测试。

验证结果：全量测试 879 通过、2 跳过；类型检查、Lint、CLI 与 Desktop 构建通过。

使用方式见 `docs/attachment-serve-upload.md`。范围限制：未提供独立浏览器上传 UI、持久凭证、续传、跨域配置或真实远程执行投影；浏览器 XHR 进度需在消费 UI 中继续验证。M7.2 Remote Projection 与部分高级解析仍待开发，路线图整体尚未完成。

---

## M7.2 阶段记录（2026-09-06，部分完成）

- 新增 `attachment-access/container` 入口及 `ContainerAttachmentAccessResolver`，可通过现有 Runtime 的 attachmentAccess 参数接入。
- 使用 Docker inspect 核实目标运行状态和只读 bind mount；从 Store 可信路径计算容器路径，检查嵌套挂载遮蔽。
- 在容器中执行 test -f / test -r / sha256sum，并与 Store 校验的 SHA256 对比，避免只返回未经验证的字符串映射。
- 命令使用独立参数，支持取消、超时与输出大小限制；失败返回 unavailable，不回退宿主机路径。

验证结果：新增 8 项容器适配器测试通过；全量测试 887 通过、2 跳过；类型检查和 Lint 通过。Docker CLI 已安装，但沙箱外连接仍报告 Docker daemon 不可用。

未完成：Docker daemon 当前不可用，尚未进行真实容器联调；宿主需自行配置挂载并确保工具使用同一容器和用户。未实现容器创建、复制 staging、SSH 传输或统一远程执行后端，M7.2 仍为 PARTIAL。

---

## M6.4 实施记录（2026-09-06）

- 默认 Registry 新增 ArchiveManifestExtractor，支持 ZIP 与基础非压缩 TAR/USTAR。
- 仅输出路径、目录/文件/链接类型和声明大小；ZIP 只读中央目录，不展开成员内容，TAR 校验 header 并跳过成员字节。
- 最多列出 1,000 个条目、50,000 字符；超限标记 truncated。路径控制字符转义，拒绝 traversal 路径和损坏 TAR header。
- 新增 5 项归档测试；Desktop E2E 验证清单进入会话历史、ZIP 成员正文不进入历史。
- 验证通过：全量 Vitest 892 项通过、2 项跳过；Desktop 附件 E2E 2 项通过；typecheck、lint、Desktop E2E 构建及 git diff --check 通过。

范围限制：不包含 PAX/GNU 扩展 TAR、tar.gz/tgz、RAR/7z；清单不代表已校验全部成员内容。Docker daemon 不可用导致的 M7.2 真实联调仍未解决。

---

## M6.5 实施记录（2026-09-06）

- 默认 Registry 新增 SQLite 3 结构预览，支持 sqlite/sqlite3/db 扩展名，检查文件头。
- 使用私有临时副本和只读 SQLite 连接；禁用扩展加载与 trusted schema，不查询应用表正文，不执行 COUNT，不解析视图或虚拟表列。
- 在可终止的 Worker 中执行，5 秒上限，支持 AbortSignal；结束后终止线程并清理临时目录。
- 最多 100 个表、每表 200 列及 50,000 字符，超限标记 truncated。
- 读取最多 1,001 条 sqlite_stat1 历史统计估计行数，注明可能过期；缺少统计时显示 unknown，不执行 ANALYZE。
- 新增 5 项回归测试，覆盖结构、内容隔离、数量限制、虚拟表、损坏数据库、取消和历史行数估计。
- 全量 Vitest：897 项通过、2 项跳过；Desktop 附件 E2E 2 项通过，验证结构进入历史且表内正文不进入历史；typecheck、lint、Desktop E2E 构建通过。

范围限制：行数估计可能过期或不完整，仅支持独立数据库快照，不导入 WAL/journal 旁文件，不支持加密数据库。M7.2 真实容器联调仍受 Docker daemon 不可用阻塞。

---

# 31. 当前最优先的三个任务

如果只选三个：

## 第一优先级

```text
Extractor Registry
```

原因：

- 改动小；
- 风险低；
- 后面 DOCX/PPTX/OCR 都依赖它。

---

## 第二优先级

```text
Attachment Access Resolver
```

原因：

- 为 `jojo serve` 和远程执行打基础；
- 避免 Provider 继续依赖本地 Store；
- 是后续容器化的重要基础。

---

## 第三优先级

```text
Streaming + SHA256
```

原因：

- 真正完成持久资源层；
- 去重；
- 支持 Web / Serve；
- 附件完整性更可靠。

---

# 32. 当前不建议优先做的事情

暂不建议优先：

```text
大量新增文件后缀
复杂 Office 渲染
自动全文 OCR
自动解压所有 ZIP
附件内容向量化
```

这些都属于上层能力。

当前应该继续巩固：

```text
Resource
Access
Transport
Lifecycle
```

---

# 33. 下一阶段推荐里程碑

建议定义：

## Attachment M2

完成：

```text
Extractor Registry
Attachment Access Resolver
Provider 解耦
```

验收标准：

> 同一 `FileAttachmentRef` 可以在 Desktop Local Runtime 中通过 Resolver 获取文件访问能力，Provider 不直接依赖 LocalAttachmentStore；所有 Preview 由注册式 Extractor 生成。

---

## Attachment M3

完成：

```text
Streaming
SHA256
Dedupe
Metadata v2
```

验收标准：

> 任意大文件可通过流式 API 保存；相同字节只保存一份 Object；资源具有 digest，可验证完整性。

---

## Attachment M4

完成：

```text
GC
Serve upload
Remote projection
```

验收标准：

> Browser 上传、Desktop 上传和远程执行共用统一附件资源模型，Session 删除后孤儿资源可以安全回收。

---

# 34. 总结

Jojo 当前已经完成了从：

```text
附件 = 解析文本
```

到：

```text
附件 = 持久资源 + 可选 Preview
```

的关键架构转变。

后续不应再把主要精力放在“增加支持后缀”，而应继续完成：

```text
Extractor Registry
        ↓
Attachment Access
        ↓
Streaming
        ↓
Digest / Dedupe
        ↓
Lifecycle / GC
        ↓
Remote / Serve
        ↓
Advanced Extractors
```

最终目标是：

> Jojo 的附件既能像 ChatGPT 文档上传一样开箱即问，又能像 Coding Agent 的工作区文件一样被工具持续操作，同时具备 DeepSeek Harness 式的持久资源、流式存储和生命周期管理能力。

# Jojo 对话内文档与 Artifact 能力优化方案

> 目标：将 Jojo 当前的「HTML Conversation Document V1」演进为统一、可扩展、可在 Desktop 与 Serve/Web 复用的 Artifact 交付体系。
>
> 参考项目：
> - Jojo 当前实现：`create_document` + `GeneratedDocumentCard`
> - Open Octo：Session Artifact + Artifacts Panel + `show_artifact`
> - DeepSeek Harness：Deliverables 自动识别 + Produced Files + 可点击文件引用
> - Pi：保留其 Tool Renderer 的优点，但不沿用其已移除的旧 Web Artifact 架构


## 本轮实现状态（更新至 2026-09-08）

已落地本文近期 P0/P1 主链路，并按最新交互要求改为 Desktop 固定右侧预览分栏：

- 共享 Contract：`ArtifactDescriptorSchema`、MIME 分类、Renderer 选择、可扩展 Extractor、历史重放和文件引用解析均位于 `packages/contracts/src/artifact.ts`，可供 Desktop/Serve/Web 消费。
- 结构化交付：`ToolResult.artifacts` 已贯通持久化、Worker IPC 和 Renderer；保留旧 `create_document` / `write_file` HTML 的兼容适配。
- 生产工具：`create_document` 保留 conversation-only 语义；成功的 `write_file` / `edit_file` 自动登记受支持的交付文件；`show_artifact` 用于脚本等间接生成的文件。
- 身份与版本：workspace 路径使用 canonical path 的 SHA-256 作为身份；历史重放合并相同路径，内容 revision 改变时递增版本。相同内容重复展示不产生新版本；当前文件内容在读取时获取，不保存历史二进制副本。
- Desktop：Turn 末尾显示去重后的最新 Artifact；对话中只显示紧凑文件入口；点击后在聊天工作区右侧固定分栏展示 HTML、Markdown、图片或文本，聊天与输入框保持可操作。关闭后恢复聊天宽度，切换会话关闭预览，下载与原始 HTML 语义说明位于右栏。PDF/Office/未知类型使用下载卡片；最终回复中的代码形式文件名和 Markdown 链接支持 exact path / unique basename 匹配。
- Serve：新增经过现有认证与会话查询授权的 `GET /api/v1/sessions/:sessionId/artifacts` 和 `GET /api/v1/sessions/:sessionId/artifacts/:artifactId/content`。内容响应提供 MIME、长度、ETag、下载文件名、nosniff 和严格 CSP。
- 内容权限：仅从当前会话的成功工具结果/旧工具记录确定可交付内容；忽略用户消息中伪装的工具结果。读取 workspace 文件重新校验真实路径、regular file、20 MiB 上限及读取期间的文件变化，拒绝越界、符号链接逃逸和跨会话 ID。
- 测试：新增生产工具、版本、消息恢复、IPC、文件引用、内容 API 和权限边界测试；Electron 用例覆盖 HTML 隔离、左右分栏不重叠、聊天输入可用、文件切换、关闭恢复布局、取消/确认保存及刷新后的文件入口。

首轮实现验证（后续 UI 调整另行验证）：`pnpm lint`、`pnpm typecheck`、Desktop E2E 构建均通过；全量 Vitest 为 **914 passed / 2 skipped**，Artifact Electron 用例 **2 passed**。实时 Artifact 完成事件已调整为持久化后发布，Desktop 从运行时持久记录读取，E2E 日志断言确认不存在 IPC 拒收或提前读取错误。

2026-09-08 拖拽扩展：文档右栏左边缘支持拖动调整宽度，向左拉满时隐藏聊天区并占满内容区，向右拖可恢复；支持展开/恢复按钮、双击分隔线恢复默认比例，以及键盘方向键调整。Electron 已验证跨 iframe 拖动、100% 宽度、拖回和恢复输入，两项端到端用例通过；lint、类型检查和构建通过。

2026-09-08 右侧栏交互验证：5 项相关单元测试、2 项 Electron 端到端测试均通过，lint、类型检查和 Desktop 构建通过。最新交互约定覆盖后文的内联预览/浮层建议：对话仅展示文件入口，点击打开固定右侧分栏，无预览浮层。

本轮边界与后续阶段：

- 当前仓库没有独立 Serve/Web 前端；本轮提供共享逻辑和内容 API，不新建整套 Web 会话 UI。
- PDF 原生预览、Office 转换预览、交互式 HTML、版本历史浏览和 CDN allowlist 仍按原方案保留为后续阶段。
- 暂不解析 HTML/Markdown 的 workspace 相对资源，预览继续要求 self-contained；未授权的本地资源不会加载。
- 内容 API 暂不支持 Range/流式大文件；文件超过 20 MiB 不进入预览交付，原始写入/编辑仍保持成功，并在工具结果说明预览不可用。
- Artifact 列表和版本目前由完整会话历史重放产生，尚未引入独立 Artifact 索引库。


---

## 1. 当前 Jojo 能力总结

Jojo 当前已经完成了一个质量不错的第一版「对话内 HTML 文档」能力：

```text
Agent
  ↓
create_document({ name, content })
  ↓
Tool Call 写入会话历史
  ↓
generatedDocuments(turn.nodes)
  ↓
GeneratedDocumentCard
  ↓
HTML iframe 预览 + 下载保存
```

当前主要能力：

- `create_document` 专门用于生成对话内 HTML 文档；
- 文档不自动写入 workspace；
- 文档内容跟随会话历史持久化；
- Desktop 对话中可以直接看到 HTML 预览；
- 支持展开 / 收起；
- 支持用户主动保存；
- 支持历史 `write_file` 产生的 HTML 兼容展示；
- 使用 DOMPurify、iframe sandbox、CSP 对 HTML 预览做隔离；
- 自动化测试已经覆盖创建、预览、刷新恢复、取消保存和确认保存。

当前边界：

- 仅支持 `.html/.htm`；
- 文档依赖 Tool Call Input 存储，没有独立 Artifact 数据模型；
- UI 通过识别 `create_document` / `write_file` 工具名重建文档；
- Desktop 已支持，但 Serve/Web 尚未形成同等展示能力；
- PDF、Markdown、图片、Word、Excel、PPT 等没有统一 Artifact Renderer；
- 没有 artifact id、版本、mimeType、storage、previewType 等通用元数据；
- 原始 HTML 与用于预览的安全 HTML 是两套语义，但保存时仍保存原始 HTML。

因此，Jojo 当前更准确的定位是：

> **HTML Conversation Artifact V1**

而不是通用 Artifact 系统。

---

## 2. 优化目标

不建议继续按文件类型扩展一组特殊工具：

```text
create_document
create_pdf
create_spreadsheet
create_image
create_presentation
...
```

这种方式短期简单，但会导致：

- Tool 数量不断增加；
- UI 需要按 Tool Name 写大量特殊判断；
- Desktop 与 Serve 重复实现；
- 会话历史和文件系统产物成为两套完全不同的数据流；
- 后续版本、更新、替换、重新预览都很难统一。

Jojo 更适合演进为：

```text
                  ┌──────────────┐
                  │ create_document
                  └──────┬───────┘
                         │
                  ┌──────▼───────┐
                  │  write_file   │
                  └──────┬───────┘
                         │
                  ┌──────▼────────┐
                  │ edit_file / CLI│
                  └──────┬────────┘
                         │
                         ▼
                  Artifact Detector
                         │
                         ▼
                  Artifact Descriptor
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
          Desktop       Serve        Future UI
             │           │
             └──── Artifact Renderer ─┘
```

核心目标：

1. **统一生成物模型**：conversation document、workspace file、tool-generated file 都进入 Artifact 体系；
2. **统一展示能力**：Desktop 与 Serve/Web 共享 Artifact contract 和 renderer 选择逻辑；
3. **自动识别产出文件**：模型即使忘记在最终回复里提文件，UI 仍能展示；
4. **支持显式展示**：脚本/终端生成的文件可以通过 `show_artifact` 主动交付；
5. **支持多 Renderer**：HTML、Markdown、图片优先，后续扩展 PDF、Office；
6. **会话与文件系统解耦**：Artifact 可以是内嵌内容，也可以是 workspace 路径；
7. **安全边界清晰**：预览内容与原始文件分离；
8. **兼容现有 create_document**：避免一次性重构破坏现有体验。

---

# 3. 推荐总体架构

## 3.1 引入统一 Artifact Contract

建议在 `@desktop-agent/contracts` 或更通用的共享 contracts 包中定义：

```ts
export type ArtifactKind =
  | 'html'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'text'
  | 'unknown';

export type ArtifactStorage =
  | {
      type: 'conversation';
      content: string;
    }
  | {
      type: 'workspace';
      path: string;
    };

export interface ArtifactDescriptor {
  id: string;

  name: string;
  mimeType: string;
  kind: ArtifactKind;

  source:
    | 'create_document'
    | 'write_file'
    | 'edit_file'
    | 'show_artifact'
    | 'generated';

  storage: ArtifactStorage;

  size?: number;

  version: number;

  createdAt?: string;
  updatedAt?: string;

  preview?: {
    renderer:
      | 'html'
      | 'markdown'
      | 'image'
      | 'pdf'
      | 'text'
      | 'download-only';
    safe?: boolean;
  };

  metadata?: Record<string, unknown>;
}
```

### 设计原则

Artifact 不应该等同于文件：

```text
Artifact ≠ File
```

Artifact 是：

> 用户本轮或会话中应该看到、打开、预览或下载的「交付物」。

例如：

### Conversation-only HTML

```ts
{
  storage: {
    type: 'conversation',
    content: '<html>...</html>'
  }
}
```

### Workspace PDF

```ts
{
  storage: {
    type: 'workspace',
    path: '/workspace/report.pdf'
  }
}
```

两者都可以统一进入：

```text
ArtifactRenderer
```

---

# 4. 保留 create_document，但降低它的架构特殊性

`create_document` 不需要删除。

它对模型仍然是非常好的语义：

> 用户要的是「对话里直接展示的报告」，而不是「写入工程目录的文件」。

建议仍保留：

```ts
create_document({
  name,
  content
})
```

但内部不要继续让 UI 从 Tool Input 猜测文档。

改为 Tool Result 返回结构化 Artifact：

```ts
return {
  callId: '',
  ok: true,
  content: `Document ready: ${document.name}`,
  artifacts: [
    {
      id: artifactId,
      name: document.name,
      mimeType: 'text/html',
      kind: 'html',
      source: 'create_document',
      storage: {
        type: 'conversation',
        content: document.content,
      },
      version: 1,
      preview: {
        renderer: 'html',
        safe: true,
      },
    },
  ],
};
```

即：

```text
create_document
      ↓
ToolResult.artifacts[]
      ↓
Conversation History
      ↓
Artifact Renderer
```

这样 `create_document` 只是一个 Artifact Producer，而不是 Artifact 系统本身。

---

# 5. 借鉴 DeepSeek Harness：增加 Deliverables 自动识别

这是 Jojo 下一步最值得优先加入的能力之一。

当前 Jojo 对旧 `write_file` HTML 的兼容是：

```text
识别 tool name = write_file
      ↓
从 input.path + input.content 重建 HTML document
```

这个思路可以泛化成：

```text
successful mutation tool
       ↓
extract locations
       ↓
Artifact Candidate
```

建议新增：

```ts
interface ToolArtifactExtractor {
  match(node: ConversationNode): boolean;
  extract(node: ConversationNode): ArtifactDescriptor[];
}
```

例如：

```ts
const writeFileArtifactExtractor = {
  match(node) {
    return node.kind === 'tool'
      && node.name === 'write_file'
      && node.state === 'ok';
  },

  extract(node) {
    // 从 path / content / result metadata 构建 artifact
  }
};
```

以后：

```text
write_file
edit_file
str_replace
code_runtime
generate_chart
...
```

只需要注册 extractor。

不要在：

```ts
generatedDocuments()
```

里继续堆：

```ts
if (node.name === ...)
else if (...)
else if (...)
```

---

# 6. 增加 show_artifact 工具

参考 Octo，Jojo 很有必要增加：

```text
show_artifact
```

原因：

很多产物并不是通过 `write_file` 生成的。

例如：

```bash
python create_report.py
npm run build-report
pandoc report.md -o report.pdf
```

最后生成：

```text
dist/report.html
output/report.pdf
chart.png
```

这些文件没有经过 Jojo 的文件写入 Tool。

如果没有 `show_artifact`：

- UI 无法知道它是用户需要看的最终产物；
- 模型只能告诉用户文件路径；
- 对话内交付链路中断。

建议接口：

```ts
show_artifact({
  path: string,
  title?: string
})
```

执行逻辑：

```text
1. path 必须存在
2. 必须是 regular file
3. 推导 MIME type
4. 检查是否属于允许展示的类型
5. 创建 ArtifactDescriptor
6. ToolResult.artifacts[] 返回
```

模型提示：

```text
If a user-facing deliverable was produced by a script, build command,
terminal command, converter, or other tool rather than write_file,
call show_artifact after it is ready.
```

这样 Jojo 的生成闭环就从：

```text
create_document
```

扩展成：

```text
write_file      → 自动展示
edit_file       → 自动更新
script/build    → show_artifact
create_document → conversation artifact
```

---

# 7. Artifact Renderer Registry

不要让主 Conversation Component 直接判断各种扩展名。

推荐：

```ts
interface ArtifactRendererDefinition {
  id: string;

  supports(artifact: ArtifactDescriptor): boolean;

  render: React.ComponentType<ArtifactRendererProps>;
}
```

注册：

```ts
const artifactRenderers = [
  htmlRenderer,
  markdownRenderer,
  imageRenderer,
  pdfRenderer,
  textRenderer,
  fallbackRenderer,
];
```

选择：

```ts
function resolveArtifactRenderer(artifact: ArtifactDescriptor) {
  return artifactRenderers.find(renderer =>
    renderer.supports(artifact)
  ) ?? fallbackRenderer;
}
```

未来增加 XLSX 时：

```text
新增 SpreadsheetRenderer
```

而不是：

```text
修改 ConversationViews
修改 GeneratedDocumentCard
修改 generated-documents.ts
修改所有平台
```

---

# 8. 文件类型支持优先级

不建议一开始就追求 Word / Excel / PPT 全部原生预览。

推荐分阶段。

## P0：已有能力

```text
HTML
```

## P1：最值得马上支持

```text
Markdown
Image
```

原因：

- 技术成本低；
- Agent 高频生成；
- Markdown 报告非常适合 coding agent；
- Mermaid / 架构说明 / README / 技术方案都能直接展示；
- 图片天然适合作为 Artifact。

建议支持：

```text
.md
.markdown

.png
.jpg
.jpeg
.webp
.gif
.svg
```

---

## P2：PDF

PDF 很适合作为「最终交付文件」。

实现：

```text
application/pdf
      ↓
PDF iframe / browser PDF viewer
```

Desktop 如果 Electron 内置 PDF 展示行为不统一，可以：

- Web 优先 browser native PDF；
- Desktop 后续引入 PDF.js；
- 第一版也可以先做「文件卡片 + 打开 / 保存」。

---

## P3：Office

```text
.docx
.xlsx
.pptx
```

第一阶段不必立刻做复杂编辑器。

可以：

```text
Artifact Card
  ├─ filename
  ├─ type
  ├─ size
  ├─ open
  └─ save
```

后续逐步加入：

```text
DOCX → HTML preview
XLSX → Spreadsheet grid
PPTX → slide preview
```

---

# 9. UI：建议融合 Jojo、DeepSeek、Octo 三种优点

推荐最终 UI 不只使用当前 Inline Card。

最佳结构：

```text
Conversation
────────────────────────

Assistant:
报告已经生成。

📄 report.html
📊 analysis.xlsx
📑 report.pdf

────────────────────────
```

点击某一个：

```text
┌────────────────────────────┬──────────────────────────┐
│ Conversation               │ Artifact Preview         │
│                            │                          │
│ User ...                   │ report.html              │
│                            │                          │
│ Assistant ...              │ [ rendered document ]    │
│                            │                          │
└────────────────────────────┴──────────────────────────┘
```

即：

### 学 DeepSeek

Turn 末尾提供：

```text
Produced Files / Artifacts
```

### 学 Octo

点击后在：

```text
Artifact Panel
```

中消费复杂文档。

### 保留 Jojo

对于较短的 conversation document：

```text
允许 Inline Preview
```

---

# 10. 推荐 UI 策略

Artifact 增加：

```ts
presentation: {
  preferred: 'inline' | 'panel' | 'download';
}
```

例如：

### HTML Report

```text
panel
```

### 小 Markdown

```text
inline
```

### 图片

```text
inline
```

### PDF

```text
panel
```

### XLSX

```text
panel
```

### 不支持类型

```text
download
```

这样 Jojo 不需要把所有复杂文档全部塞进聊天流。

---

# 11. Desktop 与 Serve/Web 必须共用 Contract

当前 Jojo 最大的架构风险之一：

> 文档展示已经写进 Desktop Renderer，但 Serve/Web 没有等价实现。

建议拆分：

```text
packages/
  artifacts/
    src/
      contract.ts
      detect.ts
      mime.ts
      renderer-registry.ts
      security.ts

apps/
  desktop/
    artifact-renderers/

  server/
    web/
      artifact-renderers/
```

共享：

```text
ArtifactDescriptor
ArtifactKind
Artifact detection
MIME classification
renderer metadata
security policy
```

平台只实现：

```text
“这个 Artifact 怎么显示”
```

而不是各自重新推导：

```text
“什么才算 Artifact”
```

---

# 12. Artifact 内容获取 API

对于 conversation artifact：

```text
content 已经跟随 conversation
```

对于 workspace artifact：

不建议直接把整个文件内容塞进 Tool Result。

应提供：

```http
GET /api/sessions/:sessionId/artifacts/:artifactId
```

或者：

```http
GET /api/artifacts/:artifactId/content
```

返回：

```text
Content-Type
Content-Length
ETag / revision
```

优点：

- 会话历史更小；
- 大文件不复制到历史；
- 图片/PDF 等二进制更自然；
- Desktop / Serve 可以共用；
- 后续支持 Range、streaming。

---

# 13. Artifact ID 与版本

强烈建议加入：

```text
artifactId
version
```

例如：

```text
Agent:
生成 report.html
      ↓
artifact_123 v1

Agent:
修改 report.html
      ↓
artifact_123 v2
```

不要变成：

```text
report.html
report.html
report.html
```

三张独立卡片。

推荐 identity：

```text
conversation storage:
  artifactId 独立生成

workspace storage:
  artifactKey = normalized absolute path
```

更新：

```text
same key
   ↓
version++
```

UI 默认展示最新版本，可选：

```text
Version History
```

---

# 14. 安全优化：区分 Preview Content 与 Original Content

Jojo 当前值得优先修的一点：

```text
Preview：
DOMPurify + sandbox + CSP

Save：
原始 document.content
```

这意味着：

```html
<script>...</script>
```

即使 Preview 不执行，

用户保存原始 HTML 后再用浏览器打开，仍可能执行。

这不是一定要禁止，但需要把产品语义讲清楚。

推荐 Artifact 中增加：

```ts
security: {
  originalTrusted: false,
  previewSanitized: true,
}
```

保存策略可选：

### 默认方案

```text
下载原始文件
```

但 UI 明确：

```text
Original HTML
```

### 更安全方案

提供：

```text
Save original
Save safe preview copy
```

或者默认：

```text
Save sanitized copy
```

并保留：

```text
Export original
```

作为高级操作。

---

# 15. HTML Sandbox 建议

Jojo 当前：

```text
sandbox=""
```

安全性很强，但交互能力弱。

Octo 的经验说明：

```text
allow-scripts
allow-forms
allow-modals
```

配合：

```text
不允许 allow-same-origin
```

可以支持很多真正有价值的交互 Artifact：

- dashboard；
- calculator；
- chart；
- architecture explorer；
- form；
- mini tool。

Jojo 可以考虑两级模式。

## Safe Document

默认：

```text
sandbox=""
```

适合：

```text
报告
文档
静态页面
```

## Interactive Artifact

显式：

```text
sandbox="allow-scripts allow-forms"
```

仍不加：

```text
allow-same-origin
allow-popups
allow-top-navigation
```

模型只有在用户请求交互页面时才选择该模式。

Artifact metadata：

```ts
interactionMode: 'static' | 'interactive'
```

---

# 16. 外部资源策略

Jojo 当前 Tool Prompt 要求：

```text
inline CSS
no scripts
no external resources
```

这对报告非常安全，但限制：

```text
ECharts
Chart.js
Mermaid
React
复杂字体
```

建议短期保持默认：

```text
self-contained first
```

后续再支持：

```text
CDN allowlist
```

例如：

```text
cdnjs.cloudflare.com
cdn.jsdelivr.net
unpkg.com
```

但必须：

- HTTPS only；
- URL parser 判断 host；
- 不允许字符串 prefix 判断；
- 无 allow-same-origin；
- 对被移除资源显示 warning。

---

# 17. 本地相对资源

HTML / Markdown 很可能引用：

```text
./chart.png
./screenshot.png
```

Artifact iframe 直接渲染时通常无法正确访问 workspace 相对路径。

建议提供：

```text
artifact://
```

虚拟资源协议，或者在渲染前把 session-authorized 本地图片转换成：

```text
data:
```

第一版可以简单规定：

```text
Conversation HTML 必须 self-contained
Workspace HTML 可以引用同一会话产生的图片
```

Serve 获取资源必须校验：

> 当前 session 是否确实产生 / 展示过这个文件。

不要允许：

```text
Artifact HTML
     ↓
任意读取 workspace / ~/.ssh / secrets
```

---

# 18. 文件交付检测

建议建立一个统一：

```ts
ArtifactDetector
```

输入：

```text
ConversationNode[]
```

输出：

```text
ArtifactDescriptor[]
```

检测来源：

```text
create_document
write_file
edit_file
show_artifact
future mutation tools
```

成功状态才进入：

```text
state === 'ok'
```

以下不进入：

```text
running
failed
cancelled
read_file
delete_file
```

同时：

```text
tool result metadata
```

应优先于：

```text
tool input guessing
```

---

# 19. 模型 Prompt 优化

推荐系统提示改为：

```text
When you create a user-facing deliverable:

1. Prefer create_document when the user wants a document shown in the
   conversation and does not request a workspace file.

2. Use write_file/edit_file when the user explicitly wants a project,
   workspace, source, or persistent local file.

3. Files created successfully through supported mutation tools are
   automatically surfaced to the user as artifacts.

4. If a user-facing artifact is produced through terminal commands,
   scripts, build tools, converters, downloads, or other indirect means,
   call show_artifact after the file is ready.

5. In the final response, briefly introduce primary artifacts rather
   than telling the user to search for a local path.
```

这样模型不会：

```text
重复调用 show_artifact(write_file 产物)
```

也不会：

```text
只返回一个路径
```

---

# 20. 建议代码结构

```text
packages/
  contracts/
    src/
      artifact.ts

  artifacts/
    src/
      artifact-detector.ts
      artifact-extractors.ts
      artifact-mime.ts
      artifact-security.ts
      artifact-storage.ts
      artifact-version.ts

  tools-node/
    src/
      create-document-tool.ts
      show-artifact-tool.ts

apps/
  desktop/
    src/
      renderer/
        artifacts/
          ArtifactCard.tsx
          ArtifactPanel.tsx
          ArtifactRenderer.tsx

          renderers/
            HtmlArtifact.tsx
            MarkdownArtifact.tsx
            ImageArtifact.tsx
            PdfArtifact.tsx
            DownloadArtifact.tsx

  server/
    src/
      artifact-content.ts
      artifact-auth.ts

  web/
    src/
      artifacts/
        ArtifactCard.tsx
        ArtifactPanel.tsx
        renderers/
```

---

# 21. 迁移计划

## Phase 1：Artifact Contract

目标：

> 不改变当前 UI，但把 `GeneratedDocument` 升级成 Artifact。

完成：

- `ArtifactDescriptor`；
- `ToolResult.artifacts`；
- `create_document` 返回 Artifact；
- `GeneratedDocumentCard` 改成 `ArtifactCard`；
- 保留旧 conversation 的兼容解析。

兼容：

```text
old create_document
old write_file HTML
       ↓
LegacyArtifactAdapter
```

---

## Phase 2：Deliverables

完成：

- `ArtifactDetector`；
- `write_file` 自动产出 Artifact；
- `edit_file` 自动更新 Artifact；
- Turn tail 显示 Produced Artifacts；
- unique basename / exact path 可点击引用。

这一阶段重点学习 DeepSeek Harness。

---

## Phase 3：show_artifact

完成：

```text
terminal/script/build
        ↓
show_artifact
        ↓
Artifact
```

这一阶段重点学习 Octo。

---

## Phase 4：Renderer Registry

先支持：

```text
HTML
Markdown
Image
Fallback
```

HTML：

```text
iframe
```

Markdown：

```text
Markdown renderer
```

Image：

```text
img + lightbox
```

Fallback：

```text
file card + save/open
```

---

## Phase 5：Artifact Panel

Desktop：

```text
Conversation | Artifact Panel
```

Serve/Web：

```text
Conversation | Artifact Panel
```

小屏：

```text
modal / drawer
```

保留：

```text
Inline Artifact
```

用于小型内容。

---

## Phase 6：PDF / Office

顺序：

```text
PDF
  ↓
DOCX
  ↓
XLSX
  ↓
PPTX
```

优先做：

```text
preview
```

而不是：

```text
edit
```

---

# 22. 测试要求

## Contract

```text
Artifact schema validation
unsupported mime
invalid name
oversize content
version update
```

## Detector

```text
successful write → artifact
failed write → none
read → none
edit existing → same artifact id + version
script output + show_artifact → artifact
```

## Security

HTML 必须覆盖：

```text
script isolation
host API inaccessible
cookie inaccessible
localStorage inaccessible
top navigation blocked
popup blocked
unapproved local file blocked
```

## Persistence

```text
create
reload
artifact still present
same path rewrite
latest version visible
old conversation compatible
```

## Desktop

```text
preview
collapse
panel
save
cancel save
open
```

## Serve/Web

```text
history replay
artifact content endpoint authorization
cross-session access denied
oversize file
invalid traversal
```

---

# 23. 建议产品能力分级

## Artifact V1

```text
HTML conversation artifact
```

即 Jojo 当前状态。

---

## Artifact V2

```text
HTML
Markdown
Image

+
Deliverables auto-detection
+
show_artifact
+
Desktop / Serve
```

这是最值得近期完成的版本。

---

## Artifact V3

```text
Artifact Panel
artifact id
version
workspace/content storage abstraction
PDF
```

---

## Artifact V4

```text
DOCX
XLSX
PPTX
interactive artifacts
artifact editing
version history
cross-platform renderer
```

---

# 24. 优先级建议

如果只做 5 件事：

## P0

### 1. ArtifactDescriptor

这是后续所有扩展的基础。

### 2. ToolResult.artifacts[]

停止让 UI 从 Tool Name 猜业务语义。

---

## P1

### 3. write/edit Deliverables 自动识别

解决：

> Agent 真实生成了文件，但最终回答忘记提。

### 4. show_artifact

解决：

> terminal / script / build 产物不能进入聊天展示。

### 5. Markdown + Image Renderer

这两类投入产出比最高。

---

# 25. 不建议近期做的事情

## 不建议 1：直接支持所有 Office

DOCX/XLSX/PPTX renderer 成本明显更高。

---

## 不建议 2：一个文件类型一个 Tool

例如：

```text
create_pdf
create_excel
create_word
```

除非工具本身承担「创建二进制格式」的生成能力，否则不要把：

```text
文件格式
```

和：

```text
Artifact Delivery
```

绑定。

---

## 不建议 3：把所有 Artifact 都塞进消息流

大型 dashboard / PDF / Spreadsheet 会严重破坏聊天阅读体验。

---

## 不建议 4：Artifact 直接拥有任意本地文件读取权限

Artifact preview 必须限制在：

```text
当前 session 已创建 / 修改 / 显式展示的文件
```

---

# 26. 最终推荐架构

```text
                        Agent
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
 create_document       write/edit      terminal/build
         │                │                │
         │                │         show_artifact
         │                │                │
         └────────────────┼────────────────┘
                          ▼
                  Artifact Producer
                          │
                          ▼
                 ArtifactDescriptor
                          │
              ┌───────────┼───────────┐
              │           │           │
              ▼           ▼           ▼
        Conversation   Workspace   Binary/File
          Content        Path        Storage
              │           │           │
              └───────────┼───────────┘
                          ▼
                   Artifact Service
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      Turn Tail       Artifact Panel    Inline Card
          │               │                │
          └───────────────┼────────────────┘
                          ▼
                 Renderer Registry
                          │
       ┌──────────┬───────┼────────┬─────────────┐
       ▼          ▼       ▼        ▼             ▼
      HTML     Markdown  Image     PDF        Fallback
```

---

# 27. 最终判断

Jojo 当前已经走出了正确的第一步：

```text
“不要让用户自己去文件系统里找 Agent 生成的 HTML”
```

下一阶段不应该继续增强 `GeneratedDocumentCard` 本身，而应该把这套能力抽象成：

> **Artifact Delivery System**

最值得借鉴的部分分别是：

### 从 Octo 学

- `show_artifact`；
- 自动 Artifact 检测；
- Artifact Panel；
- HTML sandbox；
- preview/content endpoint；
- Session 范围文件授权；
- HTML / Markdown / Image renderer。

### 从 DeepSeek Harness 学

- Deliverables 从真实 mutation tool 提取；
- Produced Files Turn Tail；
- 最终回答中的文件引用自动可点击；
- exact path / unique basename 匹配；
- 不依赖模型是否记得提文件。

### 从 Pi 学

- Tool renderer 与 Tool implementation 解耦；
- Tool Call 展示仍然保持简洁、可展开；
- 不把 Artifact Renderer 和 Tool Execution 强耦合。

### Jojo 自己应保留

- `create_document` 的 conversation-only 语义；
- 用户主动保存；
- 会话恢复；
- 默认严格的 HTML 安全策略。

最终推荐路线：

```text
Jojo HTML Document V1
        ↓
Unified Artifact Contract
        ↓
Deliverables + show_artifact
        ↓
Renderer Registry
        ↓
Desktop + Serve Artifact Panel
        ↓
PDF / Office / Interactive Artifact
```

这是比单纯增加更多 `GeneratedDocumentCard` 类型更可持续的方向。

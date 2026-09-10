# OPT-04：Artifact 内容、预览与下载一致性

> 状态：详细实现方案，本文中的 V2 接口、状态机、错误码和新增文件均为拟议，尚未实现。
> 核对基线：`e544bae`，2026-09-10。范围：内容一致性；不保存历史二进制副本。
> 本文不修改现有 Artifact 交付模型，不新增任意本地文件读取或相对资源访问权限。

## 1. 问题与验收目标

当前链路能可靠交付文件，但记录版本与实际读出的文件内容没有建立可验证的对应关系。
例如生成 `report.md` 为 v1，打开预览后由编辑器改写文件，再点保存：预览可能仍是旧内容，下载却已经变成新内容。
应当让用户明确看到“历史交付记录”和“本次读取内容”的区别，并保证一次保存对应已经确认的原始字节。

必须满足以下验收条件：

1. 预览使用的原始字节、返回的 `currentRevision`、大小和 ETag 来自同一次稳定读取。
2. 保存提交预览对应的 `expectedRevision`；不匹配时不打开保存框、不写文件，提示刷新。
3. 保存框打开后，源文件变化不改变本次导出的内容；导出已核对的缓冲区。
4. 外部修改不增加历史 `version`；刷新不会写工具结果、会话消息或新的 Artifact 版本。
5. PDF、Office 等仅下载文件，也在保存前取得并校验内容 revision。
6. 旧会话、旧客户端和现有 HTML 隔离边界继续可用。

## 2. 当前实现依据

以下位置均以基线提交为准；行号用于定位，仓库链接采用相对路径。

| 位置 | 当前行为 | 本方案调整 |
| --- | --- | --- |
| [artifact.ts](../../packages/contracts/src/artifact.ts)，8–26、69–95 行 | strict descriptor；历史重放计算版本 | 不改持久化 descriptor，增加独立读取协议 |
| [artifact-storage.ts](../../packages/tools-node/src/artifact-storage.ts)，9–33、46–51 行 | 校验真实路径、20 MiB 和读取稳定性；返回当前字节与 ETag | 同次读取生成标准元信息，增加条件校验 |
| [desktop.ts](../../packages/contracts/src/desktop.ts)，625–627、719–721 行 | read 只返回 Base64/MIME；save 不携带 revision | 保留旧方法，新增 V2 方法与频道 |
| [main.ts](../../apps/desktop/src/main/main.ts)，888–901 行 | strict 输入；先读文件，再打开保存框，写已读 Buffer | 保留“同一 Buffer 保存”，补 expectedRevision 和类型化错误 |
| [ArtifactPanel.tsx](../../apps/desktop/src/renderer/artifacts/ArtifactPanel.tsx)，10–31、46 行 | 按记录版本缓存；保存重新读取；下载类型跳过读取 | 以实际读取 revision 建立状态和保存条件 |
| [server.ts](../../packages/server-http/src/server.ts)，256–287 行 | 查询历史授权；返回强 ETag；读取错误统一 403 | v1 保持兼容，新增 V2 元信息与条件内容读取 |

当前保存流程已经在打开对话框前持有字节，这部分值得保留；缺口是它没有验证这些字节是否与用户预览一致。
当前 `executionScope` 只有 `workspace / none / custom`，见 [execution-scope.ts](../../packages/contracts/src/execution-scope.ts)。
不得把“只读”误写成当前已经存在的第四种 scope，也不得默认把 `none/custom` 映射到进程工作目录。

## 3. 身份、记录版本与内容 revision

| 字段 | 定义 | 变化规则 |
| --- | --- | --- |
| `artifactId` | 当前会话中的交付物身份；workspace 仍沿用 canonical path hash | 保留现有身份算法 |
| `recordedVersion` | 历史重放得到的 `ArtifactDescriptor.version` | 仅随已持久化交付事件变化 |
| `recordedRevision` | 该交付记录中有效的 `metadata.revision` | workspace 缺失时保留 unknown，不读取当前文件冒充历史内容 |
| `currentRevision` | 本次稳定读取的原始字节 SHA-256 | 仅取决于字节，不取决于 mtime、名称、预览清洗结果 |
| `recordedState` | 当前字节与记录 revision 的比较结果 | 相同、不同、记录 revision 未知 |
| `checkedAt` | 本次完成读取和校验的服务端时间 | 表示检查时间，不承诺后续持续监控 |

SHA-256 统一为 64 位小写十六进制；生产工具、读取服务和保存收据使用同一个 Node helper。
ETag 保持现有强 ETag 形式：`"<64 位小写 hash>"`，不加新前缀，不能使用弱 ETag 代表原始文件。
内部比较不带引号的 revision；HTTP 边界使用明确的 ETag 解析器，不能随意删除引号后接受任意字符串。
conversation 字符串按 UTF-8 编码后取 hash，不转换换行、不清洗、不重新序列化；这段历史内容本身可以推导记录 revision。
workspace 的旧记录若无有效 hash，显示“历史记录未包含内容指纹”；仍可针对本次读取内容进行条件保存。
不把上述读取元信息回写 `ArtifactDescriptor`；原有记录、版本重放、ToolResult 和 Worker 消息形状保持不变。

## 4. 拟议共享类型与 Desktop 协议（均未实现）

拟新增 `packages/contracts/src/artifact-content.ts`；实际实现使用 Zod strict schema 导出类型，以下展示协议形状。
该文件不包含 Node 文件读取或 hash 实现，供 Desktop 与 HTTP 共同使用。

```ts
type Revision = string; // schema: /^[a-f0-9]{64}$/
type ArtifactTargetV2 = { schemaVersion: 2; sessionId: string; artifactId: string };
type ArtifactReadRequestV2 = ArtifactTargetV2 & {
  representation: 'content' | 'metadata';
  knownRevision?: Revision;
};
type ArtifactContentInfoV2 = {
  schemaVersion: 2;
  sessionId: string;
  artifactId: string;
  name: string;
  mimeType: string;
  storageType: 'workspace' | 'conversation';
  recordedVersion: number;
  recordedRevision?: Revision;
  currentRevision: Revision;
  etag: string;
  size: number;
  checkedAt: string; // ISO datetime
  recordedState: 'matches-recorded' | 'changed-since-recorded' | 'recorded-revision-unknown';
};
type ArtifactReadValueV2 = { info: ArtifactContentInfoV2 } & (
  | { delivery: 'content'; data: string } // 原始字节的 Base64
  | { delivery: 'metadata' }
  | { delivery: 'not-modified' }
);
type ArtifactErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONTENT_MISSING' | 'CONTENT_TOO_LARGE' | 'CONTENT_UNSTABLE'
  | 'REVISION_MISMATCH' | 'EXPORT_BUSY' | 'EXPORT_TARGET_IS_SOURCE'
  | 'WRITE_FAILED' | 'IO_ERROR';
type ArtifactFailureV2 = {
  ok: false;
  error: { code: ArtifactErrorCode; retryable: boolean; currentRevision?: Revision };
};
type ArtifactReadResponseV2 = { ok: true; value: ArtifactReadValueV2 } | ArtifactFailureV2;
type ArtifactSaveRequestV2 = ArtifactTargetV2 & { expectedRevision: Revision };
type ArtifactSaveResponseV2 = ArtifactFailureV2 | { ok: true; value:
  | { canceled: true }
  | { canceled: false; path: string; savedRevision: Revision; size: number }
};
```

拟议 `DesktopApi.readArtifactV2` → `artifacts:read:v2`，`saveArtifactV2` → `artifacts:save:v2`。
刷新直接再次调用 `readArtifactV2`，携带上次 `knownRevision`；不增加会修改磁盘或历史记录的 refresh 命令。
`not-modified` 只在完成新一轮授权、稳定读取与 hash 校验后返回；不得只比较 mtime 或旧 descriptor。
客户端缺少对应缓存时不发送 `knownRevision`；若意外收到 `not-modified` 却没有字节，重新发起无条件读取。
metadata 模式同样完整读取并 hash，只是不通过 IPC 返回字节；适用于下载卡片，不能把 stat 当内容验证。
所有响应以 discriminated union 校验；异常通过明确 envelope 传输，避免依赖 Electron Error 序列化保留自定义属性。
sessionId/ArtifactId 沿用现有 256/4096 上限；size 以原始字节计，Base64 字段限长 `4 * ceil(MAX_ARTIFACT_BYTES / 3)`。
此 read IPC 直接经过 main/preload，不经 Worker；不要错误套用 Worker 的 16 MiB 消息上限或因此放宽 Worker 边界。

## 5. 稳定读取与条件保存算法

拟议内部结果为 `{ descriptor, info, bytes: Buffer }`，由共享存储层生成，平台只映射响应或打开保存框。
workspace 内部另保存已验证的 canonical target/dev/ino，用于拒绝导出覆盖源文件；这些字段不进入客户端响应。
读取顺序必须是：校验调用方 → 加载当前会话/交付证据 → 解析 storage → 稳定读取 → hash → 元信息 → 条件比较。
继续从成功工具结果和现有 legacy adapter 获取交付证据；不能信任客户端传来的 path、MIME、大小或 revision。
沿用 `resolveWorkspacePath`、`O_NOFOLLOW`、regular file、读取前后 inode/size/time 和 canonical path 复核。
发现读取中变化即失败，不对混合内容 hash 后宣称成功；P0 不承诺对恶意并发写入提供文件系统快照语义。
初版不自动循环重读；用户刷新可重试，避免持续写入文件触发忙循环。

Desktop 保存步骤：

1. 解析 V2 请求并验证可信窗口；按会话重新授权，不用预览缓存绕过授权。
2. 拒绝同一窗口同时发起第二个导出，返回 `EXPORT_BUSY`，控制对话框和缓冲区并发。
3. 调用稳定读取，计算当前 hash，和 `expectedRevision` 比较。
4. 不匹配则返回 `REVISION_MISMATCH`；不要打开对话框，不覆盖 expected 值后自动重试。
5. 匹配后保留本次 Buffer 与 info，打开保存原始文件对话框。
6. 用户取消则释放 Buffer，返回 `{ canceled: true }`，不显示错误或保存成功。
7. 用户确认后复核会话仍可访问、交付证据仍存在、workspace 绑定未被替换；失效则失败。
8. 将步骤 3 的同一个 Buffer 写至用户选择位置；不得再次读取源文件替换 Buffer。
9. 只有写入成功后返回 `savedRevision` 和实际 byte size；所有分支最终释放引用和导出锁。

保存框期间源文件被编辑、删除或换成符号链接：仍导出已核对的 Buffer，既不读取新目标，也不宣称导出了“最新内容”。
步骤 7 复核的是会话/交付授权和绑定，不是重新读取源文件；会话被删除、访问被撤销或绑定改变则取消导出。
若用户选中源文件本身或同 inode 的硬链接作为目标，V2 返回 `EXPORT_TARGET_IS_SOURCE`，提示“请选择另存位置”，避免把旧预览写回工作区。
目标路径只能来自原生保存对话框，不能由 IPC 参数任意指定；常规目标重名沿用原生覆盖确认。
源文件发生变化本身不取消已打开的保存框；本次操作的语义固定为“保存刚才核对的内容”。
“预览 A→保存的校验读取发现 B”必须冲突；“保存的校验成功后 A→B”导出 A，包括对话框打开前的微小时间窗口。
固定字节的边界是步骤 3 的成功校验，并非对话框在屏幕上出现的时间；测试不得假设不存在的文件锁。

## 6. Panel 状态与刷新交互

用 reducer/显式状态替代彼此独立的 `loaded/status/saving`；保存任务额外持有不可变的 target/revision 捕获值。

```ts
// 拟议状态形状，未实现；Loaded 包含 info 及按类型解码后的预览数据。
type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading'; requestId: number }
  | { phase: 'ready'; loaded: Loaded; refreshing: boolean }
  | { phase: 'stale'; loaded: Loaded; error: ArtifactErrorCode }
  | { phase: 'error'; error: ArtifactErrorCode };
```

首次打开、切换 Artifact、记录 revision/版本变化时读取；外部修改通过用户“刷新”发现，P0 不加 watcher 或轮询。
工具栏显示“交付记录 vN”；如果内容与记录不同，补充“文件已在交付后修改”，不能用 vN 标注当前文件版本。
可以在详情显示短 hash 和检查时间，但实际比较永远使用完整 hash。
刷新期间允许继续查看旧预览，并标注“正在检查”；禁用保存，避免提交不明确的内容。
刷新成功后一次性替换 info 和预览；`not-modified` 更新检查时间并保留现有字节和滚动位置。
刷新失败保留旧预览作为已读副本并标记 stale，禁用保存；提供“重试”，不永久停在“等待内容”。
保存冲突后保留旧预览并提示“文件已更改，请刷新后再保存”，不静默替换预览，也不自动打开第二次保存框。
保存按钮仅在 ready、未 refreshing、未 saving 时可用；HTML 按钮可使用“保存原始 HTML”。
读取/刷新响应使用 requestId + sessionId + artifactId 判定归属；旧请求无论成功失败都不能更新新面板。
切会话、关闭面板、切文件时递增 generation 并释放旧图片 URL/缓存；未支持 AbortSignal 的 IPC 使用逻辑取消。
逻辑取消不声称已经中止 main 中的文件读取，后端有界读取自然结束后释放数据。
已经打开的原生保存框属于发起时的 target；切会话不把它转交新会话，结果仅返回原操作，不能更新新面板状态。
用户在保存框确认仍可完成原导出；只有用户取消、授权失效或写入错误使其失败。

## 7. 下载类型、conversation 和只读环境

下载-only 文件打开面板时调用 metadata 模式；显示实际大小和检查状态后才允许下载。
点击下载时仍提交取得的 `currentRevision`；两次读取间文件变化则按相同规则冲突，不自动保存未检查的新文件。
这会增加一次 hash 读取，但避免把“没有预览”解释成“可以跳过一致性校验”；仍受 20 MiB 限制。
conversation 文档有 session 时走同一个授权服务，读取历史字符串的 UTF-8 字节；不存在 workspace 也可读取和导出。
旧 `create_document` / `write_file HTML` 的 conversation 适配仍保留；不要尝试把这些历史字符串反解成本地路径。
无 session 的临时 HTML 保留 `saveGeneratedDocument`：传入当前展示的原始字符串，主进程验证后编码一次再打开保存框。
该兼容模式没有历史 recordedVersion，也不声称具有 V2 会话授权；不得新增临时任意路径读取入口。
Serve 的 `none/custom` scope 仅允许 conversation storage；workspace storage 必须继续拒绝。
Desktop 的 legacy SessionMeta 按当前后端的真实 workingDirectory 适配，不能把 projectBound 标记机械等同于 Serve scope。
只读 Agent/profile 或只读源目录仍允许授权读取和用户主动另存副本；不因此授权 Agent 修改源文件。
执行范围与用户导出是不同能力：保存对话框是用户已有导出操作，HTTP 仅返回下载字节，不新增服务器写盘 API。

## 8. 拟议 HTTP V2 与旧客户端兼容（均未实现）

现有 `/api/v1/.../artifacts` 列表 JSON、内容端点及既有错误形状保持原行为，旧 Desktop 方法输入输出也保持原样。
不能向旧 strict 请求直接加入 `expectedRevision`，也不能在旧 descriptor 顶层增加字段；“字段可选”不保证老 schema 接受。
新增 V2 路由复用现有 `withHttp`、`core.getSession`、`core.transcript` 授权；不复制一份可绕过鉴权的读取实现。

| 拟议路由 | 请求 | 成功结果 |
| --- | --- | --- |
| `GET /api/v2/sessions/:sessionId/artifacts/:artifactId/metadata` | 原有身份凭据 | JSON `ArtifactContentInfoV2`，执行稳定读取/hash |
| `GET /api/v2/sessions/:sessionId/artifacts/:artifactId/content` | 可选 `If-Match: "hash"` | 原始字节；强 ETag 与本次内容一致 |

HTTP 不支持本地保存框；新版客户端先读 metadata 或 content，下载时必须带该 revision 的 `If-Match`。
无条件 GET 保留用于第一次内容读取；条件失败返回 412，不发送文件字节，客户端显示刷新提示。
P0 条件下载约定只接受单个合法 SHA-256 强 ETag；列表、`*`、弱 ETag、非法格式返回 400，明确为受限接口约定。
内容的 `ETag/Content-Length/Content-Type` 全部来自同一个读取结果；保持 attachment、nosniff、严格 CSP、private no-store。
metadata JSON 不借用原始文件 ETag 作为 JSON representation 的验证器；它只在 body 内携带原始内容 ETag。
P0 不增加 304、Range、缓存代理或流式大文件；HTTP 状态不得使用 JSON 的 ok 字段代替。
新版 Desktop 将主进程、preload、renderer 一起发布；新 renderer 发现 V2 方法不存在时提示更新，不能静默走无条件旧保存。
若方法存在但 invoke 返回“无处理器”，同样视为组件版本不一致，保留旧预览并禁用条件保存。
旧 renderer 调用旧方法仍能运行，旧客户端不获得本方案的一致性保证；在发布说明明确兼容窗口。
新增协议不进入 Agent Worker 消息，不向旧客户端广播新字段；现有持久化文件无需 migration。

## 9. 安全、清洗和资源预算

hash 一律覆盖原始文件，不覆盖 DOMPurify 结果；“同一内容”指预览来源和下载来源一致，不要求二者 HTML 字节相同。
继续使用 [ArtifactRenderer.tsx](../../apps/desktop/src/renderer/artifacts/ArtifactRenderer.tsx) 的 sandbox/CSP/DOMPurify；不开放脚本、外部资源或 workspace 相对图片。
明确文案：“预览经过清洗与隔离；保存的是对应的原始文件。” 不把 sanitized 副本替换到原始下载。
每次 read/refresh/save 都重新验证会话和工具结果证据，revision 知识本身不是读取授权。
缓存键至少为 `{ sessionId, artifactId, currentRevision }`；不得仅按路径或 hash 跨会话共享授权结果。
P0 只缓存当前面板内容，关闭/切会话清除；保存不直接信任 renderer 传来的 bytes、路径或缓存。
原始读取上限保持 20 MiB；conversation 额外保留原有字符数限制，再校验实际 UTF-8 bytes。
metadata 读取也遵守上限；超限文件不提供通过 V2 “绕过预览限制直接下载”的通道。
每个窗口至多一个保存 Buffer，读取并发有界；取消读取只丢弃结果时也不得无限积累等待任务。
本文不建立历史版本库、后台 hash watcher、跨会话 Artifact 索引或长期磁盘缓存。

## 10. 错误映射与文案

下表为 V2 约定；现有 v1 兼容路径不改变错误码。HTTP 下载失败返回小型 JSON，不带成功文件头。

| code | HTTP | UI 文案/动作 |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | 请求格式不兼容，请更新应用；不自动重试 |
| `UNAUTHENTICATED` | 401 | 登录状态已失效；重新认证 |
| `FORBIDDEN` | 403 | 当前会话无权读取此文件；不暴露服务器真实路径 |
| `NOT_FOUND` | 404 | 当前会话中没有此交付物；跨会话 ID 同样返回此项 |
| `CONTENT_MISSING` | 410 | 源文件已删除或移动；保留 stale 预览，禁用保存 |
| `CONTENT_TOO_LARGE` | 413 | 文件超过 20 MiB，暂时无法读取或导出 |
| `CONTENT_UNSTABLE` | 409 | 文件正在变化，请稍后刷新 |
| `REVISION_MISMATCH` | 412 | 文件已更改，请刷新后再保存 |
| `EXPORT_BUSY` | 不适用 | 已有保存操作，请先完成或取消 |
| `EXPORT_TARGET_IS_SOURCE` | 不适用 | 不能覆盖源文件，请选择另存位置 |
| `WRITE_FAILED` | 不适用 | 保存失败，请检查位置权限或磁盘空间 |
| `IO_ERROR` | 500 | 读取失败，请重试 |

ENOENT 仅在会话与交付证据验证成功后映射 CONTENT_MISSING；未授权请求不能通过错误差异探测本地文件。
保留稳定错误类型及 cause 供主进程日志诊断，UI 不直接拼接 Node 错误、磁盘路径或堆栈。
取消保存不属于失败；写入成功使用“已保存此次检查的原始内容”，不使用“已保存最新版本”。

## 11. 精确实施文件清单

| 文件 | 计划改动 |
| --- | --- |
| `packages/contracts/src/artifact-content.ts`（新增） | V2 schema、类型、错误码与字段约束 |
| `packages/contracts/src/index.ts` | 导出新协议 |
| `packages/contracts/src/desktop.ts` | 新增 V2 DesktopApi 方法/IPC 常量，保留旧签名 |
| `packages/tools-node/src/artifact-storage.ts` | 同次读取元信息、hash helper、条件校验与类型化错误 |
| `packages/tools-node/src/index.ts` | 导出供平台调用的读取/校验能力 |
| `apps/desktop/src/main/artifact-export.ts`（新增） | 提取可注入 dialog/write/auth 的条件保存流程 |
| `apps/desktop/src/main/main.ts` | 注册 V2 处理器、加载会话证据、委托导出服务 |
| `apps/desktop/src/preload/preload.ts` | V2 invoke 与响应 schema 校验 |
| `apps/desktop/src/renderer/artifacts/artifact-content-state.ts`（新增） | 请求代次、状态转移、缓存归属 |
| `apps/desktop/src/renderer/artifacts/ArtifactPanel.tsx` | 刷新、错误、条件保存、下载类型 metadata |
| `apps/desktop/src/renderer/styles.css` | stale/刷新/错误状态展示，不改变固定分栏约定 |
| `packages/server-http/src/server.ts` | V2 metadata/content 路由、If-Match 与错误映射 |

`ArtifactRenderer.tsx` 原有隔离策略保持，只有传入内容身份需要随状态一致更新；无必要不改该文件。
`packages/server-protocol` 无现成 Artifact schema 可迁移，P0 直接复用 contracts 新类型，不复制重复模型。

## 12. 测试矩阵与执行顺序

| 测试层/文件 | 必须覆盖的行为 |
| --- | --- |
| `packages/contracts/test/artifact-content.test.ts`（新增） | strict V2、非法 hash/ETag、必填 expectedRevision、Base64/字节边界、旧 descriptor 仍可解析 |
| `packages/tools-node/test/artifacts.test.ts`（扩展） | 工具记录 A→外部 B：记录版本不变、current hash 改变；相同 bytes/不同 mtime 不冲突 |
| 同上 | conversation UTF-8/中文/CRLF；旧记录无 hash；稳定读取中变化失败；空文件；20 MiB 与 +1 |
| 同上 | 跨会话 ID、假工具结果、越界/目录/符号链接、文件删除、scope none/custom；不因知道 hash 放行 |
| `apps/desktop/src/main/artifact-export.test.ts`（新增） | 预览后、保存校验前变化：无弹窗无写入；校验后、dialog 前/中编辑或删除源文件仍保存 A；原路径/硬链接目标拒绝 |
| 同上 | 取消、写入失败、会话删除/授权失效、并发导出；收据 hash 等于实际导出 bytes |
| `apps/desktop/src/renderer/artifacts/artifact-content-state.test.ts`（新增） | 读 A 慢于 B、切 session、关闭、旧 error 回调、refresh not-modified/stale、重复保存 |
| `packages/server-http/test/artifacts.test.ts`（扩展） | If-Match 命中/失败、原始 ETag/长度、状态码、认证、下载类型 metadata；v1 原有断言继续通过 |
| `apps/desktop/e2e/generated-documents.spec.ts`（扩展） | 打开→外部改写→保存冲突→刷新→保存；PDF metadata 冲突；HTML 清洗/原始导出；切会话后不串内容 |

首先执行上述定向 Vitest，再执行 `pnpm lint`、`pnpm typecheck`；Desktop 构建与相关 Electron 用例覆盖实际 IPC/保存框。
例如运行 `pnpm exec vitest run packages/tools-node/test/artifacts.test.ts packages/server-http/test/artifacts.test.ts`。
Electron 定向验证使用 `pnpm --filter @desktop-agent/desktop test:e2e generated-documents.spec.ts`，由现有脚本完成 E2E 构建。
PR 合并前按仓库既有要求执行全量测试；本文编写阶段未执行或声称这些拟议测试已经通过。

## 13. PR 拆分与完成判定

| PR | 可独立审查的交付 | 放行条件 |
| --- | --- | --- |
| 04-A | 新 contracts、读取元信息/hash/类型化错误；旧内部 API 使用适配保持行为 | 字节、版本、授权和边界单测通过，历史格式不变 |
| 04-B | Desktop V2 handler/preload 与可测试导出服务 | expectedRevision 必填；两种 dialog 竞态、取消、写失败和并发测试通过 |
| 04-C | Panel 状态机/刷新/下载卡片/兼容提示 | 可复现外部修改冲突闭环；切会话无串写；HTML 隔离回归通过 |
| 04-D | HTTP V2 路由、条件下载和 v1 兼容测试 | HTTP ETag 与导出收据对相同 bytes 一致；授权和错误矩阵通过 |

04-B 与 04-D 可在 04-A 后并行；04-C 依赖 04-B，不能先用 UI 字段假装实现后端条件保存。
回退时保留新增 V2 端点/频道兼容已发布客户端，先关闭新版入口；不得用旧无条件保存冒充成功的一致性操作。
完成标准是用户看到并选择的原始内容可被校验地导出，且变化可以刷新和解释；历史二进制存储另行立项。

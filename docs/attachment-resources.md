# 附件资源系统（首版）

本次实现对应 `jojo_attachment_resource_design.md` 第 33 节的七项范围。

## 已实现

- `FileAttachmentRef` 和 `type: file` 内容块；旧 `type: text` 附件继续读取和显示。
- `@desktop-agent/attachments` 的 `LocalAttachmentStore`：保存原始字节、读取元数据、打开流、解析路径和检查存在性。
- UUID 附件 ID，每次导入生成独立资源；保存时通过 `copyFile` 复制，不把大文件整体加载到 JavaScript 内存。
- 文件名清洗、只读文件权限、临时目录发布；同名文件互不覆盖。
- 任意普通文件均可附加，包括 ZIP、DOCX、PPTX、SQLite、BIN 和零字节文件。
- 原有 PDF、Excel、HTML 和文本提取实现移至 `attachment-preview.ts`，仅生成可选预览；提取异常返回警告，保留原件。
- JSONL 和 Runtime 输入保留结构化资源引用，Runtime 保留文本、图片和文件内容块的顺序。
- OpenAI 兼容 Provider 根据附件 ID 从本机 Store 解析路径，将元数据和预览转换为模型上下文；原件缺失时明确提示，不捏造可用路径。
- Composer 和历史消息区显示原始文件、已生成预览或预览截断状态。

## 存储布局

默认根目录为 `~/.jojo/attachments/v1`。可通过进程环境变量 `JOJO_ATTACHMENT_ROOT` 指定其他根目录；导入进程和模型进程必须使用同一配置。Electron E2E 使用独立测试目录。

```text
objects/<attachment-id>                         原始只读字节
files/<attachment-id>/metadata.json             持久元数据
files/<attachment-id>/original/<sanitized-name> 可读文件名硬链接
```

预览及文件夹相对路径保存在会话引用中，原件元数据独立于预览。删除或移动用户原文件不影响已保存的附件。Agent 使用原有文件和终端工具访问解析后的路径，沿用现有工具权限；编辑时先复制到工作区。

## 首版限制

| 项目 | 限制 |
| --- | --- |
| 单文件 | 512 MiB |
| 每条消息 | 最多 50 个文件 |
| 自动预览 | 仅对不超过 20 MiB 的已知格式执行 |
| 单文件预览 | 50,000 字符 |
| 总预览 | 200,000 字符；耗尽后仍保存其余原件 |
| 图片 | 沿用原有 10 MiB / 4 张限制 |

文件夹继续跳过隐藏项、依赖目录、符号链接和非普通文件，并限制递归深度及扫描数量。

首版沿用现有导入 Worker 的 60 秒超时和内存限制；如果 Worker 整体超时或退出，本次选择会报错，已落盘但未进入消息的资源不会自动回收。普通解析异常则只影响预览。

按照设计文档首版范围，尚未实现 SHA256 去重、流式上传 API、GC、断点续传、远端 Store、OCR、DOCX/PPTX 解析及专门的分页附件工具。完整性检查覆盖元数据 ID、文件类型与大小，不提供内容摘要校验。文件只读权限和 Agent 提示不替代操作系统安全隔离。

## 验证

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`：805 通过，2 跳过；含原件持久化、损坏与缺失、未知格式、大小边界、旧协议兼容、JSONL 恢复、模型序列化和文件工具读取。
- `pnpm --filter @desktop-agent/desktop build:e2e`
- 在 `apps/desktop` 下运行 `pnpm exec playwright test -c playwright.electron.config.ts e2e/attachments.spec.ts`：2 通过，覆盖选择、移除、文件夹、仅附件发送、页面恢复、拖拽及粘贴。

全量集成测试需要本地监听端口，Electron E2E 需要 GUI 权限。

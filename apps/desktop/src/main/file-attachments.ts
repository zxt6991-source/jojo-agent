import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalAttachmentStore, type AttachmentStore } from '@desktop-agent/attachments';
import { extractText } from './attachment-preview';
import {
  FileContentBlockSchema, MAX_ATTACHMENT_PREVIEW_TEXT, MAX_ATTACHMENT_PREVIEW_BYTES, MAX_FILE_ATTACHMENTS, MAX_FILE_BYTES,
  MAX_TOTAL_ATTACHMENT_PREVIEW_TEXT, type AttachmentSelection
} from '@desktop-agent/contracts';

const TEXT_EXTENSIONS = new Set('txt md markdown mdx csv tsv json jsonl html htm xml yaml yml log ini toml js jsx ts tsx py rb go rs java c h cpp hpp css scss sh sql vue svelte r tex rst'.split(' '));
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'vendor', '__pycache__']);

/** Only paths explicitly selected in a native dialog enter this importer. */
export async function importFileAttachments(paths: string[], mode: 'files' | 'folder', store: AttachmentStore = new LocalAttachmentStore()): Promise<AttachmentSelection> {
  const result: AttachmentSelection = { files: [], warnings: [] };
  let visited = 0;
  let attempted = 0;
  let totalText = 0;
  let skipped = 0;
  let stopped = false;
  const warn = (message: string) => { if (result.warnings.length < 20) result.warnings.push(message); };
  async function visit(filePath: string, relativePath: string, depth: number): Promise<void> {
    if (stopped) return;
    if (++visited > 10_000 || attempted >= 100 || result.files.length >= MAX_FILE_ATTACHMENTS) {
      warn('已达到附件数量或目录扫描上限，其余文件未导入。'); stopped = true; return;
    }
    try {
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) { skipped += 1; return; }
      if (info.isDirectory() && mode === 'folder') {
        if (depth > 20) { warn(`${relativePath}：目录层级过深，未导入。`); return; }
        for (const entry of (await readdir(filePath, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith('.') || (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name))) { skipped += 1; continue; }
          await visit(path.join(filePath, entry.name), `${relativePath}/${entry.name}`, depth + 1);
          if (stopped) break;
        }
        return;
      }
      if (!info.isFile()) { skipped += 1; return; }
      const extension = path.extname(filePath).slice(1).toLowerCase();
      attempted += 1;
      if (info.size > MAX_FILE_BYTES) { warn(`${relativePath}：超过单文件 512 MB 限制。`); return; }
      const attachment = await store.saveFile({ path: filePath });
      attachment.relativePath = relativePath;
      const supported = TEXT_EXTENSIONS.has(extension) || ['pdf', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extension);
      const remaining = MAX_TOTAL_ATTACHMENT_PREVIEW_TEXT - totalText;
      if (supported && attachment.bytes <= MAX_ATTACHMENT_PREVIEW_BYTES && remaining > 0) {
        try {
          const storedPath = await store.getPath(attachment.attachmentId);
          if (!storedPath) throw new Error('附件原文件不可用');
          const extracted = await extractText(await readFile(storedPath), extension);
          if (extracted.text.trim()) {
            const limit = Math.min(MAX_ATTACHMENT_PREVIEW_TEXT, remaining);
            attachment.preview = {
              type: 'text', extractor: extension,
              text: extracted.text.slice(0, limit),
              truncated: extracted.truncated || extracted.text.length > limit
            };
            totalText += attachment.preview.text.length;
            if (attachment.preview.truncated) warn(`${relativePath}：预览已截断，原始文件已保存。`);
          }
        } catch (cause) {
          warn(`${relativePath}：原始文件已保存，预览不可用：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      result.files.push(FileContentBlockSchema.parse({ type: 'file', attachment }));
    } catch (cause) {
      warn(`${relativePath}：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  for (const filePath of paths) await visit(filePath, path.basename(filePath), 0);
  if (skipped) warn(`已跳过 ${skipped} 个隐藏项、依赖目录、符号链接或非普通文件。`);
  if (!result.files.length && !result.warnings.length) warn('所选目录中没有可导入的文件。');
  return result;
}

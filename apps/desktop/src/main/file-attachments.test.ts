import { LocalAttachmentStore } from '@desktop-agent/attachments';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { MAX_ATTACHMENT_PREVIEW_BYTES, MAX_ATTACHMENT_TEXT, attachmentPreviewText, type FileContentBlock, MAX_FILE_BYTES, MAX_TOTAL_ATTACHMENT_TEXT, StartTurnInputSchema } from '@desktop-agent/contracts';
import { importFileAttachments as importFiles } from './file-attachments';
import { pdfFixture } from '../../test-fixtures/pdf';

const directories: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-attachments-'));
  directories.push(root);
  return root;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function importFileAttachments(paths: string[], mode: 'files' | 'folder') {
  const store = new LocalAttachmentStore(await fixture());
  const result = await importFiles(paths, mode, store);
  return { ...result, files: result.files as FileContentBlock[], store };
}

describe('chat file attachments', () => {
  it('extracts PDF pages, HTML text and every Excel sheet from real file bytes', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'guide.PDF'), pdfFixture('Annual revenue 1234'));
    await writeFile(path.join(root, 'page.html'), '<h1>销售 &amp; 利润</h1><script>secretScript()</script><style>hiddenStyle</style><p>增长 20%</p>');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['月份', '收入'], ['八月', 1234]]), '收入表');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['成本', 456]]), '成本表');
    for (const bookType of ['xlsx', 'xls'] as const) await writeFile(path.join(root, `report.${bookType}`), XLSX.write(workbook, { type: 'buffer', bookType }));
    const result = await importFileAttachments([root], 'folder');
    expect(result.warnings).toEqual([]);
    expect(result.files).toHaveLength(4);
    expect(result.files.find((file) => file.attachment.name === 'guide.PDF')?.attachment.preview?.text).toContain('[第 1 页]\nAnnual revenue 1234');
    const html = result.files.find((file) => file.attachment.name === 'page.html')!.attachment.preview!.text;
    expect(html).toContain('销售 & 利润');
    expect(html).not.toMatch(/secretScript|hiddenStyle/);
    for (const file of result.files.filter((file) => file.attachment.name.startsWith('report.'))) {
      expect(file.attachment.preview?.text).toContain('[工作表：收入表]');
      expect(file.attachment.preview?.text).toContain('八月,1234');
      expect(file.attachment.preview?.text).toContain('[工作表：成本表]');
      expect(file.attachment.preview?.text).toContain('成本,456');
    }
  });

  it('recurses with relative paths while excluding hidden files, dependencies and symlinks', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'notes'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'notes', 'readme.md'), '# 中文笔记\n内容');
    await writeFile(path.join(root, '.env'), 'PRIVATE=secret');
    await writeFile(path.join(root, 'node_modules', 'index.js'), 'dependency');
    await symlink(path.join(root, 'notes', 'readme.md'), path.join(root, 'linked.md'));
    const result = await importFileAttachments([root], 'folder');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.attachment.relativePath).toBe(`${path.basename(root)}/notes/readme.md`);
    expect(result.files[0]?.attachment.preview?.text).toContain('中文笔记');
    expect(result.warnings.join()).toContain('已跳过 3');
  });

  it('reports corrupt, scanned, binary, oversized and unsupported files without losing good files', async () => {
    const root = await fixture();
    const fixtures: Record<string, string | Buffer> = {
      'broken.pdf': 'not a PDF', 'scan.pdf': pdfFixture(''), 'binary.txt': Buffer.from([0, 1, 2]),
      'empty.txt': '', 'unsupported.zip': 'zip', 'large.md': '', 'good.md': '# keep me'
    };
    for (const [name, data] of Object.entries(fixtures)) await writeFile(path.join(root, name), data);
    await truncate(path.join(root, 'large.md'), MAX_FILE_BYTES + 1);
    const result = await importFileAttachments(Object.keys(fixtures).map((name) => path.join(root, name)), 'files');
    expect(result.files.map((file) => file.attachment.name)).toEqual(['broken.pdf', 'scan.pdf', 'binary.txt', 'empty.txt', 'unsupported.zip', 'good.md']);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings.join()).toContain('OCR');
    expect(result.warnings.join()).toContain('512 MB');
  });

  it('bounds text and attachment count and explicitly marks truncation for the model', async () => {
    const root = await fixture();
    for (let index = 0; index < 6; index += 1) await writeFile(path.join(root, `${index}.txt`), '文'.repeat(MAX_ATTACHMENT_TEXT + 1));
    const result = await importFileAttachments([root], 'folder');
    expect(result.files).toHaveLength(6);
    expect(result.files.filter((file) => file.attachment.preview).every((file) => file.attachment.preview?.truncated)).toBe(true);
    expect(result.files.filter((file) => !file.attachment.preview)).toHaveLength(2);
    expect(result.files.reduce((sum, file) => sum + attachmentPreviewText(file).length, 0)).toBeLessThanOrEqual(MAX_TOTAL_ATTACHMENT_TEXT);
    expect(() => StartTurnInputSchema.parse({ sessionId: 's', text: '', providerId: 'p', model: 'm', files: result.files })).not.toThrow();
    const second = await fixture();
    for (let index = 0; index < 51; index += 1) await writeFile(path.join(second, `${index}.md`), 'small file');
    const limited = await importFileAttachments([second], 'folder');
    expect(limited.files).toHaveLength(50);
    expect(limited.warnings.join()).toContain('上限');
  });

  it('decodes UTF-16 text and rejects combined requests exceeding the text budget', async () => {
    const root = await fixture();
    const filePath = path.join(root, 'unicode.txt');
    await writeFile(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')]));
    const result = await importFileAttachments([filePath], 'files');
    expect(result.files[0]?.attachment.preview?.text).toContain('你好');
    const file = structuredClone(result.files[0]!);
    file.attachment.preview!.text = 'x'.repeat(MAX_ATTACHMENT_TEXT);
    expect(() => StartTurnInputSchema.parse({ sessionId: 's', text: '', providerId: 'p', model: 'm', files: Array(5).fill(file) })).toThrow(/200,000/);
  });
  it('stores arbitrary and large files without preview and preserves bytes after source removal', async () => {
    const root = await fixture();
    const names = ['a.docx', 'b.pptx', 'c.zip', 'd.sqlite', 'e.bin', 'f.unknown', '空文件'];
    for (const name of names) await writeFile(path.join(root, name), Buffer.from([0, 1, 255]));
    await writeFile(path.join(root, 'large.txt'), '');
    await truncate(path.join(root, 'large.txt'), MAX_ATTACHMENT_PREVIEW_BYTES + 1);
    const result = await importFileAttachments([root], 'folder');
    expect(result.files).toHaveLength(8);
    expect(result.files.every((file) => !file.attachment.preview)).toBe(true);
    await rm(root, { recursive: true });
    for (const file of result.files) expect(await result.store.exists(file.attachment.attachmentId)).toBe(true);
  });

});

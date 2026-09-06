import { Readable } from 'node:stream';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { createDefaultAttachmentExtractorRegistry } from '../src';
import { pdfFixture } from './pdf-fixture';

const registry = createDefaultAttachmentExtractorRegistry();
const extract = (name: string, data: Buffer) => registry.extract({
  metadata: { attachmentId: 'att_test', name, bytes: data.length },
  openStream: async () => Readable.from([data])
});

describe('built-in attachment extractors', () => {
  it('extracts real PDF pages and rejects scanned and corrupt PDFs', async () => {
    expect((await extract('report.PDF', pdfFixture('Annual revenue 1234')))?.text).toContain('[第 1 页]\nAnnual revenue 1234');
    await expect(extract('scan.pdf', pdfFixture(''))).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED', message: expect.stringContaining('OCR') });
    await expect(extract('broken.pdf', Buffer.from('broken'))).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  });

  it.each(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'] as const)('extracts sheets from %s in order', async (bookType) => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['收入', 123]]), '收入表');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['成本', 45]]), '成本表');
    const result = await extract(`report.${bookType}`, XLSX.write(workbook, { type: 'buffer', bookType }));
    expect(result?.extractor).toBe('spreadsheet');
    expect(result?.text).toMatch(/收入表[\s\S]*收入,123[\s\S]*成本表[\s\S]*成本,45/u);
  });

  it('bounds spreadsheet rows and marks truncation', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(Array.from({ length: 2100 }, (_, i) => [`row${i}`])), 'rows');
    const result = await extract('large.xlsx', XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
    expect(result?.truncated).toBe(true);
    expect(result?.text).toContain('row1999');
    expect(result?.text).not.toContain('row2000');
  });

  it('removes HTML scripts and styles and decodes entities', async () => {
    const result = await extract('page.htm', Buffer.from('<h1>销售 &amp; 利润</h1><script>secret()</script><style>hidden</style><p>增长20%</p>'));
    expect(result?.text).toContain('销售 & 利润');
    expect(result?.text).not.toMatch(/secret|hidden/u);
  });

  it('decodes UTF-8 and UTF-16 and rejects disguised binary or invalid UTF-8', async () => {
    expect((await extract('note.md', Buffer.from('中文笔记')))?.text).toBe('中文笔记');
    expect((await extract('note.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')])) )?.text).toBe('你好');
    for (const data of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xff])]) {
      await expect(extract('binary.txt', data)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
    }
  });
});

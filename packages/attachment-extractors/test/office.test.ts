import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import { createDefaultAttachmentExtractorRegistry } from '../src';
import { deck, officeZip, paragraph, word } from './fixtures/office';

const registry = createDefaultAttachmentExtractorRegistry();
const extract = (extension: string, parts: Array<[string, string]>) => {
  const data = officeZip(parts);
  return registry.extract({ metadata: { attachmentId: 'test', name: `file.${extension}`, bytes: data.length }, openStream: async () => Readable.from([data]) });
};
it('extracts DOCX paragraphs, table cells, Unicode, entities, tabs and line breaks', async () => {
  const result = await extract('DOCX', [['word/document.xml', word(paragraph('标题 &amp; 内容') + '<w:tbl><w:tr><w:tc>' + paragraph('收入') + '</w:tc><w:tc>' + paragraph('1234') + '</w:tc></w:tr></w:tbl><w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>')]]);
  expect(result).toMatchObject({ extractor: 'docx', text: '标题 & 内容\n收入\n1234\nA\tB\nC\n', truncated: false });
});
it('uses presentation relationship order rather than slide filenames or ZIP order', async () => {
  const result = await extract('pptx', deck(['最后一页', '第一 &amp; 页', '第二页'], [1, 2, 0]).reverse());
  expect(result?.text).toBe('\n[幻灯片 1]\n第一 & 页\n\n[幻灯片 2]\n第二页\n\n[幻灯片 3]\n最后一页\n');
});
it('bounds long DOCX text and caps PPTX slide count', async () => {
  expect(await extract('docx', [['word/document.xml', word(paragraph('x'.repeat(50_001)))]] )).toMatchObject({ truncated: true, text: 'x'.repeat(50_000) });
  const result = await extract('pptx', deck(Array.from({ length: 201 }, (_, i) => `page${i}`)));
  expect(result?.truncated).toBe(true);
  expect(result?.text).toContain('[幻灯片 200]');
  expect(result?.text).not.toContain('page200');
});
it('returns no preview for an empty DOCX', async () => {
  expect(await extract('docx', [['word/document.xml', word('')]])).toBeUndefined();
});
it.each(([
  [['word/document.xml', '<broken>']],
  [['word/document.xml', '<!DOCTYPE x [<!ENTITY x "secret">]>' + word(paragraph('&x;'))]],
  [['word/document.xml', word('')], ['word/document.xml', word('')]],
  [['../word/document.xml', word('')]],
  [['unrelated.xml', '<x/>']],
  [['word/document.xml', word(paragraph('x'.repeat(4 * 1024 * 1024)))]]
] as Array<Array<[string, string]>>).map((parts) => ({ parts })))('rejects malformed or unsafe Office archives %#', async ({ parts }) => {
  await expect(extract('docx', parts)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
});
it('rejects missing and external slide relationships without following URLs', async () => {
  for (const external of [false, true]) {
    const parts = deck(['content']);
    parts[1]![1] = external ? parts[1]![1].replace('Target="slides/slide1.xml"', 'TargetMode="External" Target="https://example.invalid/slide.xml"') : '<Relationships/>';
    await expect(extract('pptx', parts)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  }
});

it('rejects deep XML and archives exceeding entry limits', async () => {
  await expect(extract('docx', [['word/document.xml', word('<w:div>'.repeat(140) + paragraph('deep') + '</w:div>'.repeat(140))]])).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  await expect(extract('docx', Array.from({ length: 5001 }, (_, i) => [`part${i}.xml`, '<x/>']))).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
});

it('rejects encrypted selected XML and cancellation before opening input', async () => {
  const data = officeZip([['word/document.xml', word(paragraph('text'))]]);
  const central = data.readUInt32LE(data.length - 6);
  data.writeUInt16LE(0x801, 6);
  data.writeUInt16LE(0x801, central + 8);
  const input = { metadata: { attachmentId: 'test', name: 'test.docx', bytes: data.length }, openStream: async () => Readable.from([data]) };
  await expect(registry.extract(input)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  await expect(registry.extract({ ...input, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
});

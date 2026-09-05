import path from 'node:path';
import { createRequire } from 'node:module';
import { convert } from 'html-to-text';
import * as XLSX from 'xlsx';
import { MAX_ATTACHMENT_PREVIEW_TEXT as MAX_ATTACHMENT_TEXT, MAX_ATTACHMENT_PREVIEW_BYTES as MAX_FILE_BYTES } from '@desktop-agent/contracts';

function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(data);
  if (data.includes(0)) throw new Error('二进制文件无法作为文本读取');
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

export async function extractText(data: Buffer, extension: string): Promise<{ text: string; truncated: boolean }> {
  if (extension === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const task = getDocument({
      data: new Uint8Array(data), useSystemFonts: true,
      cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep,
      standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep,
      wasmUrl: path.join(pdfRoot, 'wasm') + path.sep
    });
    try {
      const pdf = await task.promise;
      let text = '';
      let pageNumber = 1;
      for (; pageNumber <= pdf.numPages && text.length <= MAX_ATTACHMENT_TEXT; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        text += `\n[第 ${pageNumber} 页]\n` + content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        page.cleanup();
      }
      if (!text.replace(/\[第 \d+ 页\]/gu, '').trim()) throw new Error('PDF 没有可提取的文字，扫描件需要先进行 OCR');
      return { text, truncated: pageNumber <= pdf.numPages || text.length > MAX_ATTACHMENT_TEXT };
    } finally {
      await task.destroy();
    }
  }
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extension)) {
    const workbook = XLSX.read(data, { type: 'buffer', sheetRows: 2_001, cellFormula: false, cellHTML: false, cellStyles: false });
    let text = '';
    let truncated = false;
    for (const name of workbook.SheetNames) {
      if (text.length > MAX_ATTACHMENT_TEXT) { truncated = true; break; }
      const sheet = workbook.Sheets[name];
      if (!sheet?.['!ref']) continue;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      if (sheet['!fullref'] || range.e.c - range.s.c >= 500 || range.e.r > 1_999) truncated = true;
      if (range.s.r > 1_999) continue;
      range.e.c = Math.min(range.e.c, range.s.c + 499);
      range.e.r = Math.min(range.e.r, 1_999);
      sheet['!ref'] = XLSX.utils.encode_range(range);
      text += `\n[工作表：${name}]\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}\n`;
    }
    return { text, truncated: truncated || text.length > MAX_ATTACHMENT_TEXT };
  }
  const decoded = decodeText(data);
  const text = ['html', 'htm'].includes(extension)
    ? convert(decoded, { wordwrap: false, selectors: [{ selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }], limits: { maxInputLength: MAX_FILE_BYTES } })
    : decoded;
  return { text, truncated: text.length > MAX_ATTACHMENT_TEXT };
}


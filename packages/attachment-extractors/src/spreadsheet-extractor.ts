import * as XLSX from 'xlsx';
import { MAX_ATTACHMENT_PREVIEW_TEXT as MAX_ATTACHMENT_TEXT } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { extensionOf, readPreviewBytes, textPreview } from './shared';

export const spreadsheetExtractor: AttachmentExtractor = {
  id: 'spreadsheet',
  supports: (metadata) => ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(extensionOf(metadata)),
  async extract(input) {
    const data = await readPreviewBytes(input);
    const workbook = XLSX.read(data, { type: 'buffer', sheetRows: 2_001, cellFormula: false, cellHTML: false, cellStyles: false });
    let text = '';
    let truncated = false;
    for (const name of workbook.SheetNames) {
      input.signal?.throwIfAborted();
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
    return textPreview('spreadsheet', text, truncated);
  }
};

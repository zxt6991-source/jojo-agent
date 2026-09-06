export { sqliteExtractor } from './sqlite-extractor';
import { sqliteExtractor } from './sqlite-extractor';
export { archiveExtractor } from './archive-extractor';
import { archiveExtractor } from './archive-extractor';
export { docxExtractor } from './docx-extractor';
export { pptxExtractor } from './pptx-extractor';
import { docxExtractor } from './docx-extractor';
import { pptxExtractor } from './pptx-extractor';
export * from './types';
export * from './registry';
export { textExtractor } from './text-extractor';
export { htmlExtractor } from './html-extractor';
export { pdfExtractor } from './pdf-extractor';
export { spreadsheetExtractor } from './spreadsheet-extractor';

import { AttachmentExtractorRegistry } from './registry';
import { textExtractor } from './text-extractor';
import { htmlExtractor } from './html-extractor';
import { pdfExtractor } from './pdf-extractor';
import { spreadsheetExtractor } from './spreadsheet-extractor';

export function createDefaultAttachmentExtractorRegistry(timeoutMs = 30_000): AttachmentExtractorRegistry {
  const registry = new AttachmentExtractorRegistry(timeoutMs);
  for (const extractor of [textExtractor, htmlExtractor, pdfExtractor, spreadsheetExtractor, docxExtractor, pptxExtractor, archiveExtractor, sqliteExtractor]) registry.register(extractor);
  return registry;
}

import path from 'node:path';
import { createRequire } from 'node:module';
import { MAX_ATTACHMENT_PREVIEW_TEXT as MAX_ATTACHMENT_TEXT } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { extensionOf, readPreviewBytes, textPreview } from './shared';

export const pdfExtractor: AttachmentExtractor = {
  id: 'pdf',
  supports: (metadata) => extensionOf(metadata) === 'pdf',
  async extract(input) {
    const data = await readPreviewBytes(input);
    input.signal?.throwIfAborted();
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfRoot = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
    const task = getDocument({
      data: new Uint8Array(data), useSystemFonts: true,
      cMapUrl: path.join(pdfRoot, 'cmaps') + path.sep,
      standardFontDataUrl: path.join(pdfRoot, 'standard_fonts') + path.sep,
      wasmUrl: path.join(pdfRoot, 'wasm') + path.sep
    });
    const abort = () => { void task.destroy().catch(() => {}); };
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      input.signal?.throwIfAborted();
      const pdf = await task.promise;
      let text = '';
      let pageNumber = 1;
      for (; pageNumber <= pdf.numPages && text.length <= MAX_ATTACHMENT_TEXT; pageNumber += 1) {
        input.signal?.throwIfAborted();
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        text += `\n[第 ${pageNumber} 页]\n` + content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        page.cleanup();
      }
      if (!text.replace(/\[第 \d+ 页\]/gu, '').trim()) throw new Error('PDF 没有可提取的文字，扫描件需要先进行 OCR');
      return textPreview('pdf', text, pageNumber <= pdf.numPages || text.length > MAX_ATTACHMENT_TEXT);
    } finally {
      input.signal?.removeEventListener('abort', abort);
      await task.destroy();
    }
  }
};

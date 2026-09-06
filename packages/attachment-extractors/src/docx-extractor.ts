import { MAX_ATTACHMENT_PREVIEW_TEXT } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { extensionOf, textPreview } from './shared';
import { elements, paragraphText, parseOfficeXml, readOfficeParts } from './office-archive';

export const docxExtractor: AttachmentExtractor = {
  id: 'docx',
  supports: (metadata) => extensionOf(metadata) === 'docx',
  async extract(input) {
    const parts = await readOfficeParts(input, (name) => name === 'word/document.xml');
    const document = parseOfficeXml(parts, 'word/document.xml');
    if (document.documentElement?.localName !== 'document') throw new Error('无效 DOCX 文档');
    let text = '';
    let truncated = false;
    for (const paragraph of elements(document, 'p')) {
      input.signal?.throwIfAborted();
      if (text.length > MAX_ATTACHMENT_PREVIEW_TEXT) { truncated = true; break; }
      text += paragraphText(paragraph) + '\n';
    }
    return textPreview('docx', text, truncated);
  }
};

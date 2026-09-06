import path from 'node:path';
import { MAX_ATTACHMENT_PREVIEW_TEXT } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { extensionOf, textPreview } from './shared';
import { elements, paragraphText, parseOfficeXml, readOfficeParts } from './office-archive';

export const pptxExtractor: AttachmentExtractor = {
  id: 'pptx',
  supports: (metadata) => extensionOf(metadata) === 'pptx',
  async extract(input) {
    const parts = await readOfficeParts(input, (name) => name === 'ppt/presentation.xml'
      || name === 'ppt/_rels/presentation.xml.rels' || /^ppt\/slides\/[^/]+\.xml$/u.test(name));
    const presentation = parseOfficeXml(parts, 'ppt/presentation.xml');
    if (presentation.documentElement?.localName !== 'presentation') throw new Error('无效 PPTX 文档');
    const relationships = elements(parseOfficeXml(parts, 'ppt/_rels/presentation.xml.rels'), 'Relationship');
    const slides = elements(presentation, 'sldId');
    let text = '';
    let processed = 0;
    for (const slide of slides) {
      input.signal?.throwIfAborted();
      if (processed >= 200 || text.length > MAX_ATTACHMENT_PREVIEW_TEXT) break;
      const id = Array.from(slide.attributes).find((attribute) => attribute.localName === 'id' && attribute.prefix)?.value;
      const matches = relationships.filter((item) => item.getAttribute('Id') === id);
      const relation = matches[0];
      if (!id || matches.length !== 1 || !relation || relation.getAttribute('TargetMode') === 'External'
        || !relation.getAttribute('Type')?.endsWith('/slide')) throw new Error('无效或外部 PPTX 页面关系');
      const target = relation.getAttribute('Target') ?? '';
      const part = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`ppt/${target}`);
      if (!/^ppt\/slides\/[^/]+\.xml$/u.test(part) || target.includes('\\')) throw new Error('不安全的 PPTX 页面路径');
      const document = parseOfficeXml(parts, part);
      if (document.documentElement?.localName !== 'sld') throw new Error('无效 PPTX 页面');
      text += `\n[幻灯片 ${++processed}]\n`;
      for (const paragraph of elements(document, 'p')) {
        if (text.length > MAX_ATTACHMENT_PREVIEW_TEXT) break;
        text += paragraphText(paragraph) + '\n';
      }
    }
    return textPreview('pptx', text, processed < slides.length);
  }
};

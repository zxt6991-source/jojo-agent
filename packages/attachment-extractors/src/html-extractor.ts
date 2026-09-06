import { convert } from 'html-to-text';
import { MAX_ATTACHMENT_PREVIEW_BYTES } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { decodeText, extensionOf, readPreviewBytes, textPreview } from './shared';

export const htmlExtractor: AttachmentExtractor = {
  id: 'html',
  supports: (metadata) => ['html', 'htm'].includes(extensionOf(metadata)),
  async extract(input) {
    const text = convert(decodeText(await readPreviewBytes(input)), {
      wordwrap: false,
      selectors: [{ selector: 'script', format: 'skip' }, { selector: 'style', format: 'skip' }],
      limits: { maxInputLength: MAX_ATTACHMENT_PREVIEW_BYTES }
    });
    input.signal?.throwIfAborted();
    return textPreview('html', text);
  }
};

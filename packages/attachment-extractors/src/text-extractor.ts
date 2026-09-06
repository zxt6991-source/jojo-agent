import type { AttachmentExtractor } from './types';
import { decodeText, extensionOf, readPreviewBytes, textPreview } from './shared';

const extensions = new Set('txt md markdown mdx csv tsv json jsonl xml yaml yml log ini toml js jsx ts tsx py rb go rs java c h cpp hpp css scss sh sql vue svelte r tex rst'.split(' '));
export const textExtractor: AttachmentExtractor = {
  id: 'text',
  supports: (metadata) => extensions.has(extensionOf(metadata)),
  async extract(input) {
    return textPreview('text', decodeText(await readPreviewBytes(input)));
  }
};

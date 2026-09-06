import path from 'node:path';
import { Readable } from 'node:stream';
import { MAX_ATTACHMENT_PREVIEW_BYTES, MAX_ATTACHMENT_PREVIEW_TEXT, type AttachmentPreview } from '@desktop-agent/contracts';
import type { AttachmentExtractInput, AttachmentMetadata } from './types';

export const extensionOf = (metadata: AttachmentMetadata): string =>
  (metadata.extension ?? path.extname(metadata.name).slice(1)).replace(/^\./u, '').toLowerCase();

/** Preview parsers need a buffer, but even an inaccurate metadata size cannot bypass the byte cap. */
export async function readPreviewBytes(input: AttachmentExtractInput): Promise<Buffer> {
  input.signal?.throwIfAborted();
  if (input.metadata.bytes > MAX_ATTACHMENT_PREVIEW_BYTES) throw new Error('附件超过预览大小限制');
  const source = await input.openStream();
  const stream = source instanceof Readable ? source : new Readable().wrap(source);
  const abort = () => stream.destroy();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      input.signal?.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new Error('附件流必须提供原始字节');
      bytes += chunk.byteLength;
      if (bytes > MAX_ATTACHMENT_PREVIEW_BYTES) throw new Error('附件超过预览大小限制');
      chunks.push(Buffer.from(chunk));
    }
    input.signal?.throwIfAborted();
    return Buffer.concat(chunks, bytes);
  } finally {
    input.signal?.removeEventListener('abort', abort);
    stream.destroy();
  }
}

export function textPreview(extractor: string, text: string, truncated = false): AttachmentPreview | undefined {
  if (!text.trim()) return undefined;
  return { type: 'text', extractor, text: text.slice(0, MAX_ATTACHMENT_PREVIEW_TEXT), truncated: truncated || text.length > MAX_ATTACHMENT_PREVIEW_TEXT };
}

export function decodeText(data: Buffer): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(data);
  if (data.includes(0)) throw new Error('二进制文件无法作为文本读取');
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}


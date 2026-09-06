import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { decodeText, readPreviewBytes } from './shared';
import type { AttachmentExtractInput } from './types';

const MAX_ENTRIES = 5_000;
const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 16 * 1024 * 1024;

/** Read only selected XML parts, never extract files or follow package links on disk. */
export async function readOfficeParts(input: AttachmentExtractInput, select: (name: string) => boolean): Promise<Map<string, string>> {
  const data = await readPreviewBytes(input);
  input.signal?.throwIfAborted();
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(data, {
    lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true
  }, (error, archive) => error ? reject(error) : resolve(archive)));
  const parts = new Map<string, string>();
  try {
    await new Promise<void>((resolve, reject) => {
      let active: import('node:stream').Readable | undefined;
      let total = 0;
      let count = 0;
      let settled = false;
      const seen = new Set<string>();
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        input.signal?.removeEventListener('abort', abort);
        active?.destroy();
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(input.signal?.reason ?? new Error('Cancelled'));
      input.signal?.addEventListener('abort', abort, { once: true });
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry: Entry) => {
        void (async () => {
          input.signal?.throwIfAborted();
          if (++count > MAX_ENTRIES || zip.entryCount > MAX_ENTRIES) throw new Error('Office 压缩包条目过多');
          if (seen.has(entry.fileName)) throw new Error('Office 压缩包包含重复条目');
          seen.add(entry.fileName);
          if (!select(entry.fileName)) { zip.readEntry(); return; }
          if (entry.isEncrypted() || entry.uncompressedSize > MAX_XML_BYTES || total + entry.uncompressedSize > MAX_TOTAL_XML_BYTES) throw new Error('Office XML 超过解析大小限制或已加密');
          active = await new Promise<import('node:stream').Readable>((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream)));
          if (settled) { active.destroy(); return; }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of active) {
            input.signal?.throwIfAborted();
            bytes += chunk.length;
            if (bytes > MAX_XML_BYTES || total + bytes > MAX_TOTAL_XML_BYTES) throw new Error('Office XML 超过解析大小限制');
            chunks.push(Buffer.from(chunk));
          }
          total += bytes;
          parts.set(entry.fileName, decodeText(Buffer.concat(chunks)));
          if (!settled) zip.readEntry();
        })().catch(finish);
      });
      if (input.signal?.aborted) abort(); else zip.readEntry();
    });
  } finally { zip.close(); }
  return parts;
}

export function parseOfficeXml(parts: Map<string, string>, name: string): Document {
  const xml = parts.get(name);
  if (!xml) throw new Error(`Office 缺少必需 XML：${name}`);
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Office XML 不允许 DTD 或实体声明');
  return new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(xml, 'application/xml');
}

export function elements(document: Document | Element, localName: string): Element[] {
  const result: Element[] = [];
  const pending = Array.from(document.childNodes, (node) => ({ node, depth: 0 })).reverse();
  let visited = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++visited > 200_000 || depth > 128) throw new Error('Office XML 结构过于复杂');
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.localName === localName) result.push(element);
    if (element.localName === 'del') continue;
    for (let i = element.childNodes.length - 1; i >= 0; i--) pending.push({ node: element.childNodes.item(i)!, depth: depth + 1 });
  }
  return result;
}

/** Paragraph text includes runs, tabs and breaks; structural text only, no styles or embedded media. */
export function paragraphText(paragraph: Element): string {
  const pending = Array.from(paragraph.childNodes).reverse();
  let text = '';
  let visited = 0;
  while (pending.length) {
    if (++visited > 100_000) throw new Error('Office 段落结构过于复杂');
    const node = pending.pop()!;
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.localName === 't') text += element.textContent ?? '';
    else if (element.localName === 'tab') text += '\t';
    else if (element.localName === 'br' || element.localName === 'cr') text += '\n';
    else if (element.localName !== 'del' && element.localName !== 'p') {
      for (let i = element.childNodes.length - 1; i >= 0; i--) pending.push(element.childNodes.item(i)!);
    }
  }
  return text;
}

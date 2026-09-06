import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { MAX_ATTACHMENT_PREVIEW_TEXT } from '@desktop-agent/contracts';
import type { AttachmentExtractor } from './types';
import { extensionOf, readPreviewBytes, textPreview } from './shared';

const MAX_ENTRIES = 1_000;
function safeName(name: string): string {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('Archive 包含不安全路径');
  return JSON.stringify(name); // Escape line breaks and control characters in manifest names.
}
async function zipManifest(data: Buffer, signal?: AbortSignal) {
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(data, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, result) => error ? reject(error) : resolve(result)));
  try {
    return await new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
      let text = '[ZIP 文件清单；仅列元数据，未解压或校验文件内容]\n';
      let count = 0;
      let finished = false;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve({ text, truncated: count < zip.entryCount });
      };
      const abort = () => finish(signal?.reason ?? new Error('Cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry: Entry) => {
        try {
          signal?.throwIfAborted();
          if (count >= MAX_ENTRIES || text.length >= MAX_ATTACHMENT_PREVIEW_TEXT) { finish(); return; }
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          const kind = mode === 0xa000 ? '链接' : entry.fileName.endsWith('/') ? '目录' : '文件';
          text += `${kind} ${safeName(entry.fileName)} — ${entry.uncompressedSize} bytes${entry.isEncrypted() ? ' [加密]' : ''}\n`;
          count++;
          if (count >= MAX_ENTRIES || text.length >= MAX_ATTACHMENT_PREVIEW_TEXT) finish(); else zip.readEntry();
        } catch (cause) { finish(cause); }
      });
      if (signal?.aborted) abort(); else zip.readEntry();
    });
  } finally { zip.close(); }
}
function tarManifest(data: Buffer, signal?: AbortSignal) {
  let text = '[TAR 文件清单；仅列元数据，未读取成员内容]\n';
  let offset = 0;
  let count = 0;
  const field = (header: Buffer, start: number, length: number) => new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(start, start + length)).split('\0')[0]!;
  const octal = (value: string) => {
    const trimmed = value.trim();
    if (!/^[0-7]+$/u.test(trimmed)) throw new Error('无效 TAR 数字字段');
    const number = Number.parseInt(trimmed, 8);
    if (!Number.isSafeInteger(number)) throw new Error('TAR 数值超限');
    return number;
  };
  while (offset + 512 <= data.length) {
    signal?.throwIfAborted();
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > data.length || !data.subarray(offset).every((byte) => byte === 0)) throw new Error('TAR 结束块损坏');
      return { text, truncated: false };
    }
    if (count >= MAX_ENTRIES || text.length >= MAX_ATTACHMENT_PREVIEW_TEXT) return { text, truncated: true };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(field(header, 148, 8))) throw new Error('TAR 校验和无效');
    const magic = field(header, 257, 6);
    if (magic && magic !== 'ustar') throw new Error('仅支持普通 USTAR/TAR');
    const type = field(header, 156, 1);
    if (!['', '0', '1', '2', '5'].includes(type)) throw new Error('TAR 特殊条目或扩展格式暂不支持');
    const prefix = magic === 'ustar' ? field(header, 345, 155) : '';
    const name = (prefix ? prefix + '/' : '') + field(header, 0, 100);
    const size = octal(field(header, 124, 12));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > data.length) throw new Error('TAR 内容截断');
    text += `${type === '5' ? '目录' : type === '1' || type === '2' ? '链接' : '文件'} ${safeName(name)} — ${size} bytes\n`;
    count++; offset = next;
  }
  throw new Error('TAR 缺少结束块');
}
export const archiveExtractor: AttachmentExtractor = {
  id: 'archive-manifest',
  supports: (metadata) => ['zip', 'tar'].includes(extensionOf(metadata)),
  async extract(input) {
    const data = await readPreviewBytes(input);
    const result = extensionOf(input.metadata) === 'zip' ? await zipManifest(data, input.signal) : tarManifest(data, input.signal);
    return textPreview('archive-manifest', result.text, result.truncated);
  }
};

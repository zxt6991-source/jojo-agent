import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'plist';
import bplist from 'bplist-parser';

type FileClipboard = { availableFormats(): string[]; readBuffer(format: string): Buffer };
const FILE_FORMATS = ['NSFilenamesPboardType', 'public.file-url', 'text/uri-list', 'x-special/gnome-copied-files', 'CF_HDROP', 'FileNameW'];

export function hasClipboardFiles(clipboard: FileClipboard): boolean {
  return clipboard.availableFormats().some((format) => FILE_FORMATS.includes(format));
}

/** Read native file references only; ordinary copied text must remain text. */
export function clipboardFilePaths(clipboard: FileClipboard): string[] {
  const formats = clipboard.availableFormats();
  for (const format of FILE_FORMATS) {
    if (!formats.includes(format)) continue;
    const data = clipboard.readBuffer(format);
    if (data.length > 1024 * 1024) throw new Error('剪贴板文件列表过大，请分批粘贴。');
    let values: unknown[] = [];
    if (format === 'NSFilenamesPboardType') {
      const parsed: unknown = data.subarray(0, 6).toString() === 'bplist'
        ? bplist.parseBuffer(data)[0] : parse(data.toString('utf8'));
      if (Array.isArray(parsed)) values = parsed;
    } else if (format === 'CF_HDROP') {
      if (data.length < 20) continue;
      const offset = data.readUInt32LE(0);
      if (offset < 20 || offset >= data.length) continue;
      values = data.subarray(offset).toString(data.readUInt32LE(16) ? 'utf16le' : 'latin1').split('\0');
    } else if (format === 'FileNameW') {
      values = data.toString('utf16le').split('\0');
    } else {
      values = data.toString('utf8').split(/[\r\n\0]+/u).filter((value) => value.startsWith('file:'));
    }
    const paths = values.flatMap((value) => {
      if (typeof value !== 'string' || !value || value.includes('\0')) return [];
      try {
        const resolved = value.startsWith('file:') ? fileURLToPath(value) : value;
        return path.isAbsolute(resolved) ? [resolved] : [];
      } catch { return []; }
    });
    if (paths.length) return [...new Set(paths)];
  }
  return [];
}

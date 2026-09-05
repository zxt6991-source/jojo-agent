import { describe, expect, it } from 'vitest';
import { build } from 'plist';
import { clipboardFilePaths, hasClipboardFiles } from './clipboard-files';

function clipboard(entries: Record<string, Buffer | string>) {
  return {
    availableFormats: () => Object.keys(entries),
    readBuffer: (format: string) => Buffer.from(entries[format] ?? '')
  };
}

describe('native clipboard file references', () => {
  it('reads multiple Finder files and folders without decoding literal path characters', () => {
    const paths = ['/Users/test/中文 文件.pdf', '/Users/test/folder', '/Users/test/A&B%20.md'];
    const source = clipboard({ NSFilenamesPboardType: build(paths) });
    expect(hasClipboardFiles(source)).toBe(true);
    expect(clipboardFilePaths(source)).toEqual(paths);
  });

  it('reads binary Finder property lists', () => {
    // Binary plist containing an array with the single string /tmp/a.md.
    const data = Buffer.concat([
      Buffer.from('bplist00'), Buffer.from([0xa1, 1, 0x59]), Buffer.from('/tmp/a.md'),
      Buffer.from([8, 10]),
      Buffer.from('0000000000000101000000000000000200000000000000000000000000000014', 'hex')
    ]);
    expect(clipboardFilePaths(clipboard({ NSFilenamesPboardType: data }))).toEqual(['/tmp/a.md']);
  });

  it('decodes local file URIs and ignores remote web URLs and copied text', () => {
    expect(clipboardFilePaths(clipboard({ 'text/uri-list': '# copied\r\nfile:///tmp/a%20b.md\r\nhttps://example.com/a.md\r\nfile:///tmp/a%20b.md' }))).toEqual(['/tmp/a b.md']);
    expect(clipboardFilePaths(clipboard({ 'x-special/gnome-copied-files': 'copy\nfile:///tmp/a.md\nfile:///tmp/folder' }))).toEqual(['/tmp/a.md', '/tmp/folder']);
    const text = clipboard({ 'text/plain': '/tmp/report.pdf', 'public.utf8-plain-text': 'file:///tmp/report.pdf' });
    expect(hasClipboardFiles(text)).toBe(false);
    expect(clipboardFilePaths(text)).toEqual([]);
  });

  it('decodes UTF-16 file drop lists and handles malformed data', () => {
    const header = Buffer.alloc(20);
    header.writeUInt32LE(20, 0);
    header.writeUInt32LE(1, 16);
    expect(clipboardFilePaths(clipboard({ CF_HDROP: Buffer.concat([header, Buffer.from('/tmp/一.md\0/tmp/二.pdf\0\0', 'utf16le')]) }))).toEqual(['/tmp/一.md', '/tmp/二.pdf']);
    expect(clipboardFilePaths(clipboard({ CF_HDROP: Buffer.alloc(4) }))).toEqual([]);
    expect(() => clipboardFilePaths(clipboard({ 'public.file-url': Buffer.alloc(1024 * 1024 + 1) }))).toThrow('过大');
  });
});

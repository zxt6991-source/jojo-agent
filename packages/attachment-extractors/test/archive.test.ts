import { expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createDefaultAttachmentExtractorRegistry } from '../src';
import { officeZip } from './fixtures/office';
const extract = (extension: string, data: Buffer) => createDefaultAttachmentExtractorRegistry().extract({ metadata: { attachmentId: 'test', name: `file.${extension}`, bytes: data.length }, openStream: async () => Readable.from([data]) });
function tar(name: string, content: string, type = '0') {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name); header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]);
}
it('lists ZIP names and declared sizes without expanding highly compressed contents', async () => {
  const result = await extract('zip', officeZip([['目录/', ''], ['目录/file.txt', 'secret content'.repeat(10000)], ['line\nname', 'abc']]));
  expect(result?.text).toContain('目录/file.txt');
  expect(result?.text).toContain('140000 bytes');
  expect(result?.text).toContain('line\\nname');
  expect(result?.text).not.toContain('secret content');
  expect(result?.truncated).toBe(false);
});
it('caps archive entry counts and marks truncated output', async () => {
  const result = await extract('zip', officeZip(Array.from({ length: 1001 }, (_, i) => [`f${i}`, ''])));
  expect(result?.truncated).toBe(true);
  expect(result?.text).toContain('"f999"');
  expect(result?.text).not.toContain('"f1000"');
});
it('reads a TAR manifest without exposing member bytes', async () => {
  const result = await extract('tar', tar('folder/report.txt', 'secret'));
  expect(result?.text).toContain('"folder/report.txt" — 6 bytes');
  expect(result?.text).not.toContain('secret');
  expect(result?.truncated).toBe(false);
});
it('rejects corrupt, unsafe or unsupported archives', async () => {
  const invalidTar = tar('file', 'abc'); invalidTar[0] = 0;
  for (const data of [invalidTar, tar('../escape', ''), tar('extended', '', 'x'), tar('file', 'abc').subarray(0, 600)]) {
    await expect(extract('tar', data)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  }
  await expect(extract('zip', officeZip([['../escape', 'abc']]))).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
});
it('supports empty archives', async () => {
  expect((await extract('zip', officeZip([])))?.truncated).toBe(false);
  expect((await extract('tar', Buffer.alloc(1024)))?.truncated).toBe(false);
});

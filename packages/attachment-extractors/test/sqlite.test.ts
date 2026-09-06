import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { createDefaultAttachmentExtractorRegistry } from '../src';
async function fixture(sql: string): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sqlite-fixture-'));
  try {
    const file = path.join(dir, 'source.db');
    const db = new DatabaseSync(file);
    try { db.exec(sql); } finally { db.close(); }
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const extract = (bytes: Buffer, signal?: AbortSignal) => createDefaultAttachmentExtractorRegistry().extract({
  metadata: { attachmentId: 'test', name: 'data.sqlite', bytes: bytes.length },
  openStream: async () => Readable.from([bytes]), ...(signal ? { signal } : {})
});
it('previews schema without dumping data or modifying source bytes', async () => {
  const bytes = await fixture('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO users VALUES(1, \'private-secret\');');
  const before = Buffer.from(bytes);
  const result = await extract(bytes);
  expect(result?.text).toContain('table "users"');
  expect(result?.text).toContain('"name" "TEXT" NOT NULL');
  expect(result?.text).not.toContain('private-secret');
  expect(result?.truncated).toBe(false);
  expect(bytes).toEqual(before);
});
it('bounds table and column counts', async () => {
  const tables = await extract(await fixture(Array.from({ length: 101 }, (_, i) => `CREATE TABLE t${i}(id);`).join('')));
  expect(tables?.truncated).toBe(true);
  expect(tables?.text).not.toContain('table "t100"');
  const columns = await extract(await fixture(`CREATE TABLE wide(${Array.from({ length: 201 }, (_, i) => `c${i}`).join(',')});`));
  expect(columns?.truncated).toBe(true);
  expect(columns?.text).not.toContain('"c200"');
});
it('ignores views and does not invoke virtual tables', async () => {
  const result = await extract(await fixture('CREATE TABLE ordinary(id); CREATE VIEW dangerous AS SELECT load_extension(\'missing\'); CREATE VIRTUAL TABLE search USING fts5(content);'));
  expect(result?.text).not.toContain('dangerous');
  expect(result?.text).toContain('[虚拟表：跳过列解析]');
});
it('rejects invalid headers, corrupt databases, and cancellation', async () => {
  await expect(extract(Buffer.from('invalid'))).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  const corrupt = Buffer.alloc(100); corrupt.write('SQLite format 3\0');
  await expect(extract(corrupt)).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  const controller = new AbortController(); controller.abort();
  await expect(extract(await fixture('CREATE TABLE t(id);'), controller.signal)).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
});

it('uses existing statistics for estimates without recounting modified rows', async () => {
  const result = await extract(await fixture('CREATE TABLE estimated(id); INSERT INTO estimated VALUES(1),(2); ANALYZE; INSERT INTO estimated VALUES(3);'));
  expect(result?.text).toContain('table "estimated" — rows: ~2');
  const unknown = await extract(await fixture('CREATE TABLE uncounted(id);'));
  expect(unknown?.text).toContain('table "uncounted" — rows: unknown');
});

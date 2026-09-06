import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { extensionOf, readPreviewBytes, textPreview } from './shared';
import type { AttachmentExtractor } from './types';

// Isolate synchronous SQLite parsing so cancellation and timeout can stop malformed inputs.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
let db;
try {
  db = new DatabaseSync(workerData, { readOnly: true, allowExtension: false });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON');
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 101").all();
  const estimates = new Map();
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sqlite_stat1'").get()) {
    for (const row of db.prepare('SELECT tbl, stat FROM sqlite_stat1 LIMIT 1001').all()) {
      const token = String(row.stat).split(' ')[0];
      if (/^[0-9]+$/.test(token) && Number.isSafeInteger(Number(token))) {
        estimates.set(row.tbl, Math.max(estimates.get(row.tbl) || 0, Number(token)));
      }
    }
  }
  const lines = ['[SQLite 结构预览；不读取表数据；行数来自历史统计，可能过期；未执行 COUNT]'];
  let truncated = tables.length > 100;
  for (const table of tables.slice(0, 100)) {
    lines.push('table ' + JSON.stringify(table.name) + ' — rows: ' + (estimates.has(table.name) ? '~' + estimates.get(table.name) : 'unknown'));
    if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(table.sql || '')) {
      lines.push('  [虚拟表：跳过列解析]');
      continue;
    }
    const columns = db.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?) LIMIT 201').all(table.name);
    truncated ||= columns.length > 200;
    for (const col of columns.slice(0, 200)) {
      lines.push('  ' + JSON.stringify(col.name) + ' ' + JSON.stringify(col.type) + (col.notnull ? ' NOT NULL' : '') + (col.pk ? ' PRIMARY KEY' : ''));
      if (lines.join('\n').length > 50000) { truncated = true; break; }
    }
    if (lines.join('\n').length > 50000) break;
  }
  parentPort.postMessage({ text: lines.join('\n'), truncated });
} finally { if (db) db.close(); }
`;

export const sqliteExtractor: AttachmentExtractor = {
  id: 'sqlite-schema',
  supports: (metadata) => ['sqlite', 'sqlite3', 'db'].includes(extensionOf(metadata)),
  async extract(input) {
    const bytes = await readPreviewBytes(input);
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('不是有效的 SQLite 数据库');
    const directory = await mkdtemp(path.join(tmpdir(), 'jojo-sqlite-preview-'));
    let worker: Worker | undefined;
    try {
      const file = path.join(directory, 'preview.sqlite');
      await writeFile(file, bytes, { mode: 0o600 });
      input.signal?.throwIfAborted();
      worker = new Worker(workerSource, { eval: true, workerData: file });
      const activeWorker = worker;
      const result = await new Promise<{ text: string; truncated: boolean }>((resolve, reject) => {
        const abort = () => reject(input.signal?.reason ?? new Error('附件预览已取消'));
        const timer = setTimeout(() => reject(new Error('SQLite 预览超时')), 5_000);
        const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
        activeWorker.once('message', (value) => { cleanup(); resolve(value); });
        activeWorker.once('error', (error) => { cleanup(); reject(error); });
        activeWorker.once('exit', () => { cleanup(); reject(new Error('SQLite 预览线程已退出')); });
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
      });
      return textPreview('sqlite-schema', result.text, result.truncated);
    } finally {
      await worker?.terminate();
      await rm(directory, { recursive: true, force: true });
    }
  }
};

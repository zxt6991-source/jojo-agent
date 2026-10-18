import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { downloadPinnedFile, validPinnedFile, verifyPinnedFile } from './pinned-tts-download.mjs';
import { cosyvoicePaths, cosyvoiceReady, COSYVOICE_MANIFEST, main } from './setup-cosyvoice.mjs';

const descriptor = text => ({ path: 'model.bin', bytes: text.length, sha256: createHash('sha256').update(text).digest('hex') });
async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'jojo-cosyvoice-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const url = 'https://author.invalid/pinned/model';
test('retains partial bytes and resumes after a bounded failed transfer', async t => {
  const target = join(await workspace(t), 'model'), calls = [];
  await downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: async ({ partial, offset }) => {
    calls.push(offset);
    if (calls.length === 1) { await writeFile(partial, 'abc'); throw new Error('connection lost'); }
    await appendFile(partial, 'def');
  } });
  assert.deepEqual(calls, [0, 3]); assert.equal(await readFile(target, 'utf8'), 'abcdef');
  assert.deepEqual(await downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: () => assert.fail('refetched verified file') }), { reused: true });
});
test('a later invocation resumes a failed command without deleting existing output', async t => {
  const target = join(await workspace(t), 'model'); await writeFile(target, 'previous model'); let calls = 0;
  await assert.rejects(downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: async ({ partial, offset }) => {
    calls++; if (!offset) await writeFile(partial, 'abc'); throw new Error('offline');
  } }));
  assert.equal(calls, 2); assert.equal(await readFile(target, 'utf8'), 'previous model');
  await downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: async ({ offset, partial }) => { assert.equal(offset, 3); await appendFile(partial, 'def'); } });
  assert.equal(await readFile(target, 'utf8'), 'abcdef');
});
test('quarantines mismatched or oversized bytes and never publishes them', async t => {
  for (const contents of ['xxxxxx', 'far too many bytes']) {
    const root = await workspace(t), target = join(root, 'model'); await writeFile(target, 'previous');
    await assert.rejects(downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: async ({ partial }) => writeFile(partial, contents) }));
    assert.equal(await readFile(target, 'utf8'), 'previous'); assert.ok((await readdir(root)).some(name => name.includes('.invalid-')));
  }
});
test('resets an unsupported HTTP resume once while preserving the old partial', async t => {
  const root = await workspace(t), target = join(root, 'model'); await writeFile(`${target}.part`, 'abc'); const calls = [];
  await downloadPinnedFile(target, descriptor('abcdef'), url, { transfer: async ({ partial, offset }) => {
    calls.push(offset); if (offset) { const error = new Error('range unsupported'); error.downloadCode = 33; throw error; } await writeFile(partial, 'abcdef');
  } });
  assert.deepEqual(calls, [3, 0]); assert.ok((await readdir(root)).some(name => name.includes('.nonresumable-')));
});
test('validates traversal, digests, empty source files and maximum model size', async t => {
  for (const path of ['../x', '/x', 'a\\b', 'a/./b']) assert.equal(validPinnedFile({ ...descriptor('x'), path }), false);
  assert.equal(validPinnedFile({ ...descriptor('x'), bytes: 4 * 1024 ** 3 }), false);
  const root = await workspace(t), empty = join(root, 'empty'); await writeFile(empty, '');
  assert.equal(await verifyPinnedFile(empty, descriptor('')), true);
  assert.equal(await verifyPinnedFile(empty, descriptor('other')), false);
});
test('CosyVoice manifest pins both upstream source commits and required inference weights', () => {
  assert.match(COSYVOICE_MANIFEST.model.revision, /^[a-f0-9]{40}$/u);
  assert.equal(COSYVOICE_MANIFEST.model.files.reduce((sum, file) => sum + file.bytes, 0), 5427041134);
  assert.ok(COSYVOICE_MANIFEST.model.files.every(validPinnedFile));
  assert.equal(COSYVOICE_MANIFEST.model.files.some(file => file.path === 'llm.rl.pt'), false);
  for (const source of COSYVOICE_MANIFEST.sources) { assert.match(source.revision, /^[a-f0-9]{40}$/u); assert.ok(source.files.every(validPinnedFile)); }
});
test('CosyVoice default inspection creates no runtime, model, microphone or settings', async t => {
  const root = join(await workspace(t), 'absent'), previous = process.exitCode;
  try { const result = await main(['--directory', root]); assert.equal(result.model, false); assert.equal(result.productionTtsChanged, false); }
  finally { process.exitCode = previous; }
  assert.deepEqual(await cosyvoiceReady(cosyvoicePaths(root)), { model: false, sources: false });
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { candidateModelReady, downloadTtsCandidate, main } from './setup-local-tts.mjs';
import { MELO_FILES, MELO_REVISION } from './local-tts-models.mjs';
const { Response } = globalThis;
const sha256 = text => createHash('sha256').update(text).digest('hex');
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'jojo-tts-setup-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test('pins author revision, int8 model and exact support file digests', () => {
  assert.match(MELO_REVISION, /^[a-f0-9]{40}$/u);
  assert.equal(MELO_FILES.some(file => file.path === 'model.onnx'), false);
  const model = MELO_FILES.find(file => file.path === 'model.int8.onnx'); assert.equal(model.bytes, 53517430); assert.match(model.sha256, /^[a-f0-9]{64}$/u);
  for (const file of MELO_FILES) assert.ok(file.sha256 || /^[a-f0-9]{40}$/u.test(file.gitBlob));
});
test('publishes verified files atomically and reuses them without fetching', async t => {
  const root = await workspace(t), dir = join(root, 'model'), text = 'synthetic model'; let fetched = 0;
  const files = [{ path: 'nested/test.onnx', bytes: text.length, sha256: sha256(text) }];
  const options = { files, fetchImpl: async () => { fetched++; return new Response(text); } };
  assert.deepEqual(await downloadTtsCandidate(dir, options), { reused: false });
  assert.equal(await candidateModelReady(dir, files), true); assert.equal(fetched, 1);
  assert.deepEqual(await downloadTtsCandidate(dir, options), { reused: true }); assert.equal(fetched, 1);
});
test('a failed checksum never replaces an existing complete directory', async t => {
  const dir = join(await workspace(t), 'model'); await mkdir(dir); await writeFile(join(dir, 'model.onnx'), 'old model');
  await assert.rejects(downloadTtsCandidate(dir, { files: [{ path: 'model.onnx', bytes: 3, sha256: sha256('new') }], fetchImpl: async () => new Response('bad') }), /checksum/u);
  assert.equal(await readFile(join(dir, 'model.onnx'), 'utf8'), 'old model');
});
test('one transient transport failure is retried with a strict bound', async t => {
  let calls = 0; const text = 'model', files = [{ path: 'model.onnx', bytes: text.length, sha256: sha256(text) }];
  await downloadTtsCandidate(join(await workspace(t), 'model'), { files, fetchImpl: async () => { if (++calls === 1) throw new Error('connection reset'); return new Response(text); } });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(downloadTtsCandidate(join(await workspace(t), 'failed'), { files, fetchImpl: async () => { calls++; throw new Error('unavailable'); } }));
  assert.equal(calls, 2);
});
test('offline inspection creates no directory, runtime, settings or model', async t => {
  const directory = join(await workspace(t), 'absent'), previous = process.exitCode;
  try { const result = await main(['--directory', directory]); assert.equal(result.verifiedModelFiles, false); assert.equal(result.productionTtsChanged, false); }
  finally { process.exitCode = previous; }
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
test('rejects traversal and malformed manifests before fetching', async t => {
  const directory = join(await workspace(t), 'absent');
  for (const path of ['../outside', '/absolute', 'dir\\outside', 'dir/./file']) await assert.rejects(downloadTtsCandidate(directory, {
    files: [{ path, bytes: 2, sha256: sha256('ok') }], fetchImpl: async () => assert.fail('unexpected fetch')
  }), /manifest/u);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

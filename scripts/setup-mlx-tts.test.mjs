import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import process from 'node:process';
import test from 'node:test';
import { main, MLX_TTS_MANIFEST, prepareMlxTtsModel } from './setup-mlx-tts.mjs';

async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'jojo-neural-setup-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const file = { path: 'model.safetensors', bytes: 5, sha256: createHash('sha256').update('model').digest('hex') };
const manifest = { repository: 'https://huggingface.co/example/offline-voice', revision: 'a'.repeat(40), files: [file] };

test('pins the neural voice, codec and tokenizer as one immutable offline model', () => {
  assert.match(MLX_TTS_MANIFEST.revision, /^[a-f0-9]{40}$/u);
  assert.equal(MLX_TTS_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0), 1693603219);
  for (const name of ['model.safetensors', 'speech_tokenizer/model.safetensors', 'tokenizer_config.json']) assert.ok(MLX_TTS_MANIFEST.files.some(file => file.path === name));
});
test('default inspection creates no model, environment or settings', async t => {
  const root = join(await workspace(t), 'missing'), previous = process.exitCode;
  try { const result = await main(['--directory', root]); assert.equal(result.verifiedModelFiles, false); assert.equal(result.settingsChanged, false); }
  finally { process.exitCode = previous; }
  await assert.rejects(stat(root), { code: 'ENOENT' });
});
test('requires exact digests and reuses a verified offline model without transfer', async t => {
  const directory = await workspace(t);
  const options = { manifest, download: true, transfer: async ({ partial }) => { await writeFile(partial, 'model'); } };
  assert.equal(await prepareMlxTtsModel(directory, options), true);
  assert.equal(await prepareMlxTtsModel(directory, { ...options, transfer: () => assert.fail('unexpected network') }), true);
  await writeFile(join(directory, file.path), 'wrong');
  assert.equal(await prepareMlxTtsModel(directory, { manifest }), false);
});
test('rejects escaping and duplicate model paths before any transfer', async t => {
  const directory = await workspace(t);
  for (const files of [[{ ...file, path: '../escape' }], [file, file]]) await assert.rejects(prepareMlxTtsModel(directory, { manifest: { ...manifest, files }, download: true, transfer: () => assert.fail('unexpected network') }), /manifest/u);
});

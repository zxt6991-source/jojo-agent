import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { parseSetupArguments } from './setup-local-speech.mjs';
import { downloadStreamingModels, PARAFORMER_REVISION, probeStreamingSpeech, setupStreamingSpeech,
  SILERO_MODEL_URL, STREAMING_MODEL_FILES, SMART_TURN_PYTHON_PACKAGES, streamingModelFilesReady, streamingSpeechPaths } from './setup-local-speech-streaming.mjs';

const { queueMicrotask, Response } = globalThis;
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jojo-streaming-speech-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function probeFixture(header, { code = 0, extra = false } = {}) {
  let call;
  const spawnImpl = (executable, args, options) => {
    call = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => {
      const payload = Buffer.from(JSON.stringify(header)); const frame = Buffer.alloc(payload.length + 8);
      frame.writeUInt32BE(payload.length + 4, 0); frame.writeUInt32BE(payload.length, 4); payload.copy(frame, 8);
      child.stdout.write(frame.subarray(0, 3)); child.stdout.write(frame.subarray(3));
      if (extra) child.stdout.write('unexpected stdout log');
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, call: () => call };
}
const capabilities = { vad: { available: true }, streamingAsr: { available: true }, smartTurn: { available: false, reason: 'smart_turn_model_missing' } };

test('streaming preparation is explicit and defaults to offline inspection only', () => {
  const options = parseSetupArguments(['--streaming-sidecar']);
  assert.equal(options.downloadStreamingModels, false); assert.equal(options.installStreamingRuntime, false);
  assert.equal(options.installSmartTurnRuntime, false);
  assert.equal(parseSetupArguments(['--streaming-sidecar', '--install-smart-turn-runtime']).installSmartTurnRuntime, true);
  assert.throws(() => parseSetupArguments(['--install-smart-turn-runtime']), /require --streaming-sidecar/u);
  assert.deepEqual(SMART_TURN_PYTHON_PACKAGES, ['onnxruntime==1.19.2', 'transformers==4.49.0']);
  assert.throws(() => parseSetupArguments(['--download-streaming-models']), /require --streaming-sidecar/u);
  assert.throws(() => parseSetupArguments(['--smart-turn-model', '/local/model']), /require --streaming-sidecar/u);
  assert.throws(() => parseSetupArguments(['--streaming-sidecar', '--install-streaming-runtime', '--skip-install']), /conflicts/u);
  const paths = streamingSpeechPaths(options);
  assert.match(paths.vadModel, /\.local-speech\/models\/silero_vad.onnx$/u);
  assert.match(paths.paraformerDirectory, /\.local-speech\/models\/StreamingParaformer$/u);
  assert.match(paths.smartTurnModel, /\.local-speech\/models\/smart-turn-v3.1.onnx$/u);
});

test('streaming author models use immutable revisions and known encoder/decoder digests', () => {
  assert.match(PARAFORMER_REVISION, /^[a-f\d]{40}$/u);
  for (const file of STREAMING_MODEL_FILES) {
    assert.equal(file.url, `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/${PARAFORMER_REVISION}/${file.path}`);
    if (file.path.endsWith('.onnx')) assert.match(file.sha256, /^[a-f\d]{64}$/u);
  }
  assert.equal(SILERO_MODEL_URL, 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx');
});

test('real probe parsing uses binary framing and strips untrusted capability fields', async () => {
  const paths = streamingSpeechPaths({ directory: '/tmp/streaming paths' });
  const fixture = probeFixture({ type: 'ready', protocolVersion: 1, capabilities: {
    ...capabilities, smartTurn: { available: false, reason: '/private/audio-or-token', exception: 'secret' }
  } });
  assert.deepEqual(await probeStreamingSpeech(paths, fixture), {
    ...capabilities, smartTurn: { available: false, reason: 'local_dependency_or_model_unavailable' }
  });
  const call = fixture.call();
  assert.equal(call.executable, paths.pythonPath); assert.equal(call.options.shell, false);
  assert.equal(call.options.env.HF_HUB_OFFLINE, '1'); assert.equal(call.options.env.TRANSFORMERS_OFFLINE, '1');
  assert.deepEqual(call.args.slice(0, 4), ['-B', '-u', paths.scriptPath, '--probe']);
});

test('probe fails closed on extra stdout, incompatible protocol, failed exit, or missing capability', async () => {
  const paths = streamingSpeechPaths({ directory: '/tmp/unused' });
  for (const fixture of [probeFixture({ type: 'ready', protocolVersion: 1, capabilities }, { extra: true }),
    probeFixture({ type: 'ready', protocolVersion: 2, capabilities }),
    probeFixture({ type: 'ready', protocolVersion: 1, capabilities }, { code: 1 }),
    probeFixture({ type: 'ready', protocolVersion: 1, capabilities: { vad: { available: true } } })]) {
    const result = await probeStreamingSpeech(paths, fixture);
    assert.ok(Object.values(result).every(item => !item.available && item.reason === 'invalid_probe_protocol'));
  }
});

test('failed streaming digest preserves the existing model and never fetches Smart Turn', async t => {
  const directory = await workspace(t); const paths = streamingSpeechPaths({ directory });
  await mkdir(paths.paraformerDirectory, { recursive: true });
  await writeFile(join(paths.paraformerDirectory, 'encoder.int8.onnx'), 'previous model');
  const urls = [];
  await assert.rejects(downloadStreamingModels(paths, { fetchImpl: async url => {
    urls.push(url); return new Response('synthetic fixture');
  } }), /SHA256 check failed/u);
  assert.deepEqual(urls, STREAMING_MODEL_FILES.map(file => file.url));
  assert.equal(await readFile(join(paths.paraformerDirectory, 'encoder.int8.onnx'), 'utf8'), 'previous model');
  await assert.rejects(stat(paths.vadModel), { code: 'ENOENT' });
});

test('file presence is separate from pinned content verification', async t => {
  const directory = await workspace(t);
  assert.equal(await streamingModelFilesReady(directory), false);
  for (const file of STREAMING_MODEL_FILES) await writeFile(join(directory, file.path), 'fixture');
  assert.equal(await streamingModelFilesReady(directory, { verifyHashes: false }), true);
  assert.equal(await streamingModelFilesReady(directory), false);
});

test('offline inspection with missing venv creates no directories or settings', async t => {
  const directory = join(await workspace(t), 'not-created');
  const result = await setupStreamingSpeech(parseSetupArguments(['--streaming-sidecar', '--directory', directory]));
  assert.ok(Object.values(result.capabilities).every(item => !item.available));
  assert.equal(result.autoEndpointVerified, false); assert.equal(result.speakerBargeInVerified, false);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('Python protocol and lifecycle regression suite runs without third-party models', t => {
  const python = 'python3';
  if (spawnSync(python, ['--version'], { stdio: 'ignore' }).status !== 0) { t.skip('Python is not installed.'); return; }
  const result = spawnSync(python, ['-B', '-m', 'unittest', 'discover', '-s', 'apps/desktop/src/worker/speech-sidecar', '-p', 'test_*.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran [1-9]\d* tests/u);
});

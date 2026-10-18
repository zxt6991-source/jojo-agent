/** Explicit local sidecar preparation. Inspection is offline and never changes Jojo settings. */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { downloadFile, LOCAL_SPEECH_PYTHON_PACKAGES, runProcess } from './setup-local-speech.mjs';

// Official sherpa docs link to this author repository. Only int8 files are fetched,
// rather than its >1 GB archive containing duplicate fp32 models.
// https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html
export const PARAFORMER_REVISION = '8e40c43232a1c5c66c82111efc5820d3accca11b';
const base = `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/${PARAFORMER_REVISION}`;
export const STREAMING_MODEL_FILES = [
  { path: 'encoder.int8.onnx', url: `${base}/encoder.int8.onnx`, maximumBytes: 180 * 1024 * 1024,
    sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a' },
  { path: 'decoder.int8.onnx', url: `${base}/decoder.int8.onnx`, maximumBytes: 80 * 1024 * 1024,
    sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f' },
  { path: 'tokens.txt', url: `${base}/tokens.txt`, maximumBytes: 1024 * 1024 }
];
export const SILERO_MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
export const SMART_TURN_PYTHON_PACKAGES = ['onnxruntime==1.19.2', 'transformers==4.49.0'];
const scriptPath = fileURLToPath(new URL('../apps/desktop/src/worker/speech-sidecar/main.py', import.meta.url));

async function regularFile(path, maximumBytes) {
  try { const file = await stat(path); return file.isFile() && file.size > 0 && file.size <= maximumBytes; }
  catch { return false; }
}
async function matchesDigest(path, expected) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex') === expected;
}
export async function streamingModelFilesReady(directory, { verifyHashes = true } = {}) {
  for (const file of STREAMING_MODEL_FILES) {
    const path = join(directory, file.path);
    if (!await regularFile(path, file.maximumBytes) || (verifyHashes && file.sha256 && !await matchesDigest(path, file.sha256))) return false;
  }
  return true;
}
export function streamingSpeechPaths(options) {
  const directory = resolve(options.directory);
  return {
    pythonPath: join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'),
    scriptPath,
    vadModel: resolve(options.vadModel ?? join(directory, 'models', 'silero_vad.onnx')),
    paraformerDirectory: resolve(options.paraformerDirectory ?? join(directory, 'models', 'StreamingParaformer')),
    smartTurnModel: resolve(options.smartTurnModel ?? join(directory, 'models', 'smart-turn-v3.1.onnx'))
  };
}

/** Atomic publication preserves a previous complete model if any download/hash fails. */
export async function downloadStreamingModels(paths, downloadOptions = {}) {
  if (!await streamingModelFilesReady(paths.paraformerDirectory)) {
    await mkdir(dirname(paths.paraformerDirectory), { recursive: true });
    const stage = await mkdtemp(join(dirname(paths.paraformerDirectory), '.StreamingParaformer-part-'));
    for (const file of STREAMING_MODEL_FILES) {
      await downloadFile(join(stage, file.path), file.url, { ...downloadOptions, maximumBytes: file.maximumBytes });
    }
    if (!await streamingModelFilesReady(stage)) throw new Error('The pinned streaming Paraformer SHA256 check failed; no model was published.');
    let previous;
    try { await stat(paths.paraformerDirectory); previous = `${stage}.previous`; await rename(paths.paraformerDirectory, previous); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, paths.paraformerDirectory); }
    catch (error) { if (previous) await rename(previous, paths.paraformerDirectory); throw error; }
  }
  if (!await regularFile(paths.vadModel, 5 * 1024 * 1024)) {
    await downloadFile(paths.vadModel, SILERO_MODEL_URL, { ...downloadOptions, maximumBytes: 5 * 1024 * 1024 });
  }
}

const unavailable = reason => Object.fromEntries(['vad', 'streamingAsr', 'smartTurn'].map(name => [name, { available: false, reason }]));
/** A real child process imports/constructs models; no file-presence claim implies usable inference. */
export function probeStreamingSpeech(paths, { spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  return new Promise(resolveProbe => {
    let finished = false; let timer; let child; const chunks = []; let bytes = 0;
    const finish = capabilities => {
      if (finished) return; finished = true; clearTimeout(timer); resolveProbe(capabilities);
    };
    const args = ['-B', '-u', paths.scriptPath, '--probe', '--vad-model', paths.vadModel,
      '--paraformer-dir', paths.paraformerDirectory, '--smart-turn-model', paths.smartTurnModel];
    const env = { PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    try { child = spawnImpl(paths.pythonPath, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env }); }
    catch { finish(unavailable('python_unavailable')); return; }
    timer = setTimeout(() => { finish(unavailable('probe_timeout')); child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { finish(unavailable('invalid_probe_protocol')); child.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    child.once('error', () => finish(unavailable('python_unavailable')));
    child.once('close', code => {
      if (finished) return;
      try {
        const output = Buffer.concat(chunks);
        const size = output.readUInt32BE(0); const headerSize = output.readUInt32BE(4);
        if (code !== 0 || size + 4 !== output.length || headerSize !== size - 4 || headerSize > 16_384) throw new Error();
        const ready = JSON.parse(output.subarray(8).toString('utf8'));
        if (ready.type !== 'ready' || ready.protocolVersion !== 1 || !ready.capabilities
          || !['vad', 'streamingAsr', 'smartTurn'].every(key => typeof ready.capabilities[key]?.available === 'boolean')) throw new Error();
        const capabilities = Object.fromEntries(['vad', 'streamingAsr', 'smartTurn'].map(key => {
          const item = ready.capabilities[key];
          return [key, item.available ? { available: true } : { available: false,
            reason: typeof item.reason === 'string' && /^[a-z_]{1,128}$/u.test(item.reason) ? item.reason : 'local_dependency_or_model_unavailable' }];
        }));
        finish(capabilities);
      } catch { finish(unavailable('invalid_probe_protocol')); }
    });
  });
}

export async function setupStreamingSpeech(options) {
  const paths = streamingSpeechPaths(options);
  if (options.installStreamingRuntime || options.installSmartTurnRuntime) {
    await mkdir(resolve(options.directory), { recursive: true });
    if (!await regularFile(paths.pythonPath, Number.MAX_SAFE_INTEGER)) {
      await runProcess(options.python, ['-m', 'venv', join(resolve(options.directory), 'venv')]);
    }
    await runProcess(paths.pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:',
      ...(options.proxy ? ['--proxy', options.proxy] : []), ...LOCAL_SPEECH_PYTHON_PACKAGES,
      ...(options.installSmartTurnRuntime ? SMART_TURN_PYTHON_PACKAGES : [])]);
  }
  if (options.downloadStreamingModels) {
    console.log('Explicit streaming model download: Silero and pinned int8 Paraformer (~237 MB).');
    await downloadStreamingModels(paths, { diagnoseDownload: options.diagnoseDownload, proxy: options.proxy });
  }
  const capabilities = await probeStreamingSpeech(paths);
  const result = { ...paths, capabilities, autoEndpointVerified: false, speakerBargeInVerified: false };
  console.log(JSON.stringify(result, null, 2));
  console.log('Inspection does not enable continuous listening, auto endpoint, or speaker interruption.');
  console.log('Smart Turn is optional: supply --smart-turn-model after preparing local onnxruntime and transformers without torch. No Smart Turn download/install is automatic.');
  return result;
}

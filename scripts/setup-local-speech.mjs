#!/usr/bin/env node
import { spawn } from 'node:child_process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';

const { fetch, AbortController, TextDecoder } = globalThis;

export const SENSEVOICE_ARCHIVE_PREFIX = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
export const SENSEVOICE_ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${SENSEVOICE_ARCHIVE_PREFIX}.tar.bz2`;
export const LOCAL_SPEECH_PYTHON_PACKAGES = ['numpy==1.26.4', 'sherpa-onnx==1.13.8'];
export const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
export const HUGGINGFACE_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
export const SENSEVOICE_MODEL_SHA256 = 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51';
const HUGGINGFACE_BASE = `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${HUGGINGFACE_REVISION}`;
export const HUGGINGFACE_MODEL_FILES = [
  { path: 'model.int8.onnx', url: `${HUGGINGFACE_BASE}/model.int8.onnx`, maximumBytes: 450 * 1024 * 1024 },
  { path: 'tokens.txt', url: `${HUGGINGFACE_BASE}/tokens.txt`, maximumBytes: 5 * 1024 * 1024 },
  { path: 'test_wavs/zh.wav', url: `${HUGGINGFACE_BASE}/test_wavs/zh.wav`, maximumBytes: 10 * 1024 * 1024 }
];
const REQUIRED_MODEL_FILES = ['model.int8.onnx', 'tokens.txt', 'test_wavs/zh.wav'];
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

const EXTRACT_MODEL = String.raw`
import os
import sys
import tarfile

archive, stage, prefix = sys.argv[1:4]
wanted = {
    prefix + "/model.int8.onnx": ("model.int8.onnx", 450 * 1024 * 1024),
    prefix + "/tokens.txt": ("tokens.txt", 5 * 1024 * 1024),
    prefix + "/test_wavs/zh.wav": ("test_wavs/zh.wav", 10 * 1024 * 1024),
}
seen = set()
count = 0
total = 0
try:
    with tarfile.open(archive, mode="r|bz2") as package:
        for member in package:
            count += 1
            name = member.name.rstrip("/")
            parts = name.split("/")
            if (count > 256 or not name or name.startswith("/") or "\\" in name or "\0" in name
                or any(part in ("", ".", "..") for part in parts) or parts[0] != prefix):
                raise ValueError("invalid archive path")
            if member.isdir():
                continue
            if not member.isfile() or member.size < 0:
                raise ValueError("archive links and special files are unsupported")
            total += member.size
            if total > 500 * 1024 * 1024:
                raise ValueError("expanded archive exceeds limit")
            if name not in wanted:
                continue
            relative, maximum = wanted[name]
            if name in seen or member.size <= 0 or member.size > maximum:
                raise ValueError("invalid required model file")
            seen.add(name)
            target = os.path.join(stage, *relative.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            source = package.extractfile(member)
            copied = 0
            with open(target, "xb") as output:
                while True:
                    block = source.read(65536)
                    if not block:
                        break
                    copied += len(block)
                    if copied > member.size:
                        raise ValueError("model file exceeds its declared size")
                    output.write(block)
            if copied != member.size:
                raise ValueError("truncated model file")
    if seen != set(wanted):
        raise ValueError("archive is missing required model files")
except Exception:
    sys.stderr.write("The local SenseVoice archive failed validation; no model was published.\n")
    raise SystemExit(1)
`;

export function parseSetupArguments(args) {
  const options = { directory: join(REPOSITORY_ROOT, '.local-speech'), python: 'python3', source: 'github',
    skipInstall: false, diagnoseDownload: false, proxy: undefined, help: false,
    streamingSidecar: false, downloadStreamingModels: false, installStreamingRuntime: false, installSmartTurnRuntime: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--skip-install') options.skipInstall = true;
    else if (argument === '--diagnose-download') options.diagnoseDownload = true;
    else if (argument === '--streaming-sidecar') options.streamingSidecar = true;
    else if (argument === '--download-streaming-models') options.downloadStreamingModels = true;
    else if (argument === '--install-streaming-runtime') options.installStreamingRuntime = true;
    else if (argument === '--install-smart-turn-runtime') options.installSmartTurnRuntime = true;
    else if (['--directory', '--python', '--source', '--proxy', '--vad-model', '--paraformer-dir', '--smart-turn-model'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--') || value.includes('\0')) throw new Error(`${argument} requires a value.`);
      if (argument === '--directory') options.directory = resolve(value);
      else if (argument === '--python') options.python = value;
      else if (argument === '--proxy') options.proxy = validateLocalProxy(value);
      else if (argument === '--vad-model') options.vadModel = resolve(value);
      else if (argument === '--paraformer-dir') options.paraformerDirectory = resolve(value);
      else if (argument === '--smart-turn-model') options.smartTurnModel = resolve(value);
      else {
        if (!['github', 'huggingface'].includes(value)) throw new Error('--source must be github or huggingface.');
        options.source = value;
      }
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.streamingSidecar && (options.downloadStreamingModels || options.installStreamingRuntime || options.installSmartTurnRuntime || options.vadModel || options.paraformerDirectory || options.smartTurnModel)) {
    throw new Error('Streaming model flags require --streaming-sidecar.');
  }
  if (options.skipInstall && (options.installStreamingRuntime || options.installSmartTurnRuntime)) throw new Error('--skip-install conflicts with runtime installation.');
  return options;
}

export function validateLocalProxy(value) {
  const invalid = () => { throw new Error('--proxy requires a loopback http, https, or socks5h URL with an explicit port and no credentials, path, query, or fragment.'); };
  if (typeof value !== 'string' || value.length > 200) return invalid();
  const match = value.match(/^(https?|socks5h):\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/iu);
  if (!match) return invalid();
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return invalid();
  return `${match[1].toLowerCase()}://${match[2].toLowerCase()}:${port}`;
}

export async function modelFilesReady(directory) {
  try {
    const files = await Promise.all(REQUIRED_MODEL_FILES.map(file => stat(join(directory, file))));
    return files.every(file => file.isFile() && file.size > 0 && file.size <= MAX_ARCHIVE_BYTES);
  } catch { return false; }
}

class DownloadTransportError extends Error {}

async function downloadWithFetch(destination, { url, fetchImpl, timeoutMs, maximumBytes, diagnoseDownload }) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let file;
  let reader;
  try {
    let response;
    try { response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' }); }
    catch { throw new DownloadTransportError('The Node HTTPS downloader could not connect.'); }
    if (!response.ok || !response.body) throw new Error(`Could not download the official SenseVoice model file.${diagnoseDownload ? ` (HTTP ${Number.isInteger(response.status) ? response.status : 'unknown'})` : ''}`);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
      throw new Error('The SenseVoice archive exceeds the download limit.');
    }
    await mkdir(dirname(destination), { recursive: true });
    file = await open(`${destination}.part`, 'w', 0o600);
    reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      let item;
      try { item = await reader.read(); }
      catch { throw new DownloadTransportError('The Node HTTPS download connection was interrupted.'); }
      if (item.done) break;
      if (controller.signal.aborted) throw new Error('The SenseVoice archive download timed out.');
      bytes += item.value.byteLength;
      if (bytes > maximumBytes) throw new Error('The SenseVoice archive exceeds the download limit.');
      await file.writeFile(item.value);
    }
    if (controller.signal.aborted) throw new Error('The SenseVoice archive download timed out.');
    if (!bytes || (declared !== null && bytes !== Number(declared))) throw new Error('The SenseVoice archive download was incomplete.');
    await file.sync(); await file.close(); file = undefined;
    await rename(`${destination}.part`, destination);
    return { bytes };
  } finally {
    clearTimeout(deadline);
    if (reader) try { await reader.cancel(); } catch { /* Keep the original download failure. */ }
    if (file) await file.close();
  }
}

async function downloadWithCurl(destination, { url, curlSpawn, maximumBytes, curlTimeoutMs, diagnoseDownload, proxy }) {
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  // Replace only our incomplete download. The final archive remains intact until success.
  const pending = await open(partial, 'w', 0o600); await pending.close();
  await new Promise((done, reject) => {
    let deadline;
    let finished = false;
    let statusOutput = '';
    let outputValid = true;
    const failure = (message, exitCode) => {
      const status = outputValid && /^(?:000|[1-5]\d{2})$/u.test(statusOutput.trim()) ? statusOutput.trim() : 'unknown';
      const exit = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : 'unknown';
      return new Error(`${message}${diagnoseDownload ? ` (curl exit ${exit}, HTTP ${status})` : ''}`);
    };
    const finish = failure => {
      if (finished) return;
      finished = true;
      if (deadline) clearTimeout(deadline);
      if (failure) reject(failure); else done();
    };
    let child;
    try {
      child = curlSpawn('curl', [
        '--disable', '--silent', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
        ...(proxy ? ['--proxy', proxy] : []),
        '--retry', '0', '--max-filesize', String(maximumBytes), '--connect-timeout', '20',
        '--max-time', String(curlTimeoutMs / 1000), '--write-out', '%{http_code}', '--output', partial, '--', url
      ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { finish(new Error('Could not start the system HTTPS downloader.')); return; }
    child.stdout?.on('data', chunk => {
      if (!outputValid) return;
      if (!(chunk instanceof Uint8Array) && typeof chunk !== 'string') { outputValid = false; return; }
      statusOutput += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      if (statusOutput.length > 64) { statusOutput = ''; outputValid = false; }
    });
    child.on('error', () => finish(new Error('Could not start the system HTTPS downloader.')));
    child.on('close', code => finish(code === 0 ? undefined : failure('The system HTTPS model download failed.', code)));
    deadline = setTimeout(() => {
      finish(failure('The system HTTPS model download timed out.'));
      try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
    }, curlTimeoutMs + 1000);
  });
  const info = await stat(partial);
  if (!info.isFile() || !info.size || info.size > maximumBytes) throw new Error('The downloaded SenseVoice archive is empty or exceeds the download limit.');
  const complete = await open(partial, 'r');
  try { await complete.sync(); } finally { await complete.close(); }
  await rename(partial, destination);
  return { bytes: info.size };
}

/** Failed downloads retain .part. A native fetch transport failure gets one explicit curl attempt. */
export async function downloadFile(destination, url, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 120_000, maximumBytes = MAX_ARCHIVE_BYTES,
    curlSpawn = spawn, curlTimeoutMs = 180_000,
    diagnoseDownload = false, curlFallback = fetchImpl === fetch || options.curlSpawn !== undefined } = options;
  const proxy = options.proxy === undefined ? undefined : validateLocalProxy(options.proxy);
  if (proxy) {
    console.log('Using the explicitly selected local proxy for the model download...');
    return downloadWithCurl(destination, { url, curlSpawn, maximumBytes, curlTimeoutMs, diagnoseDownload, proxy });
  }
  try { return await downloadWithFetch(destination, { url, fetchImpl, timeoutMs, maximumBytes, diagnoseDownload }); }
  catch (failure) {
    if (!(failure instanceof DownloadTransportError) || !curlFallback) throw failure;
    console.log('Node HTTPS download failed; trying the system HTTPS downloader once...');
    return downloadWithCurl(destination, { url, curlSpawn, maximumBytes, curlTimeoutMs, diagnoseDownload });
  }
}

export function downloadArchive(destination, options = {}) {
  return downloadFile(destination, SENSEVOICE_ARCHIVE_URL, options);
}

export function runProcess(executable, args, { quiet = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', quiet ? 'ignore' : 'inherit', 'inherit'] });
    child.on('error', () => reject(new Error('Could not start the selected local Python executable.')));
    child.on('close', code => code === 0 ? done() : reject(new Error('The local speech setup command did not complete successfully.')));
  });
}

/** Only three known regular files are read; tar metadata never supplies an output path. */
export async function extractModelArchive(archive, directory, { python = 'python3' } = {}) {
  await mkdir(dirname(directory), { recursive: true });
  const stage = await mkdtemp(join(dirname(directory), '.SenseVoiceSmall-part-'));
  await runProcess(python, ['-I', '-u', '-c', EXTRACT_MODEL, resolve(archive), stage, SENSEVOICE_ARCHIVE_PREFIX], { quiet: true });
  if (!await modelFilesReady(stage)) throw new Error('The SenseVoice archive did not contain complete model files.');
  await publishModelStage(stage, directory);
  return directory;
}

async function publishModelStage(stage, directory) {
  let previous;
  try { await stat(directory); previous = `${directory}.previous-${randomUUID()}`; }
  catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  if (previous) await rename(directory, previous);
  try { await rename(stage, directory); }
  catch (failure) {
    if (previous) await rename(previous, directory);
    throw failure;
  }
}

async function verifyModelHash(directory) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, 'model.int8.onnx'))) hash.update(chunk);
  return hash.digest('hex') === SENSEVOICE_MODEL_SHA256;
}

/** An explicit source choice: the author repository and its immutable revision are fixed. */
export async function downloadHuggingFaceModel(directory, options = {}) {
  await mkdir(dirname(directory), { recursive: true });
  const stage = await mkdtemp(join(dirname(directory), '.SenseVoiceSmall-huggingface-part-'));
  for (const file of HUGGINGFACE_MODEL_FILES) {
    console.log(`Downloading SenseVoice ${file.path} from the author repository...`);
    await downloadFile(join(stage, file.path), file.url, { ...options, maximumBytes: file.maximumBytes });
  }
  if (!await modelFilesReady(stage) || !await verifyModelHash(stage)) {
    throw new Error('The pinned SenseVoice model SHA256 check failed; no model was published.');
  }
  await publishModelStage(stage, directory);
  return directory;
}

export async function setupLocalSpeech(options) {
  const source = options.source ?? 'github';
  if (!['github', 'huggingface'].includes(source)) throw new Error('--source must be github or huggingface.');
  const proxy = options.proxy === undefined ? undefined : validateLocalProxy(options.proxy);
  const downloadOptions = { diagnoseDownload: options.diagnoseDownload, proxy };
  const directory = resolve(options.directory);
  const pythonPath = join(directory, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
  const modelDirectory = join(directory, 'models', 'SenseVoiceSmall');
  await mkdir(directory, { recursive: true });
  let hasPython = false;
  try { hasPython = (await stat(pythonPath)).isFile(); } catch { /* A new local venv needs creating. */ }
  if (!hasPython) {
    if (options.skipInstall) throw new Error('--skip-install requires an existing venv in the selected directory.');
    console.log('Creating the isolated local speech Python environment...');
    await runProcess(options.python, ['-m', 'venv', join(directory, 'venv')]);
  }
  if (!options.skipInstall) {
    console.log('Installing the pinned local speech packages (binary wheels only)...');
    await runProcess(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', ...LOCAL_SPEECH_PYTHON_PACKAGES]);
  }
  const existingModelReady = await modelFilesReady(modelDirectory) && (source !== 'huggingface' || await verifyModelHash(modelDirectory));
  if (!existingModelReady && source === 'huggingface') {
    await downloadHuggingFaceModel(modelDirectory, downloadOptions);
  } else if (!existingModelReady) {
    const archive = join(directory, 'downloads', `${SENSEVOICE_ARCHIVE_PREFIX}.tar.bz2`);
    let archiveReady = false;
    try { const info = await stat(archive); archiveReady = info.isFile() && info.size > 0 && info.size <= MAX_ARCHIVE_BYTES; }
    catch { /* Download once; completed archives are reused on repeated runs. */ }
    if (!archiveReady) {
      console.log('Downloading the official SenseVoice int8 model (one-time download)...');
      await downloadArchive(archive, downloadOptions);
    }
    console.log('Validating and installing the local model files...');
    try { await extractModelArchive(archive, modelDirectory, { python: pythonPath }); }
    catch (failure) {
      // Preserve the failed archive for inspection; a rerun will download a fresh copy.
      await rename(archive, `${archive}.invalid-${randomUUID()}`).catch(() => {});
      throw failure;
    }
  } else console.log('Existing complete SenseVoice model found; skipping model download.');
  console.log('\nLocal speech is ready. Enter these values in Jojo voice settings:');
  console.log(JSON.stringify({ pythonPath, modelDirectory, language: 'auto' }, null, 2));
  return { pythonPath, modelDirectory };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseSetupArguments(args);
  if (options.help) {
    console.log(`Usage: node scripts/setup-local-speech.mjs [options]

Creates .local-speech/venv and .local-speech/models/SenseVoiceSmall in this repository.
Downloads pinned Python wheels and the official SenseVoice int8 model once.
Does not modify Jojo settings, stored credentials, or recordings.

  --directory PATH  Choose a different setup directory.
  --python PATH     Python 3.9–3.12 used to create the isolated venv (default: python3).
  --skip-install    Reuse an existing venv without running pip (model download may still occur).
  --source NAME     github (default) or huggingface (author repository, pinned revision and model SHA256).
  --diagnose-download  Include controlled HTTP status and curl exit codes on download errors.
  --proxy URL       Use an existing loopback http/https/socks5h proxy for this download only; requires an explicit port.
  --streaming-sidecar  Inspect existing local Silero / streaming Paraformer / optional Smart Turn without downloading or installing.
  --download-streaming-models  With --streaming-sidecar, explicitly download Silero and pinned int8 Paraformer (~237 MB).
  --install-streaming-runtime  With --streaming-sidecar, explicitly create the venv and install pinned numpy / sherpa wheels.
  --install-smart-turn-runtime With --streaming-sidecar, also install pinned ONNX Runtime / Transformers (no PyTorch).
  --vad-model PATH / --paraformer-dir PATH / --smart-turn-model PATH  Override local streaming model paths.
  --help            Show this help.

Model source: ${SENSEVOICE_ARCHIVE_URL}`);
    return;
  }
  if (options.streamingSidecar) {
    const { setupStreamingSpeech } = await import('./setup-local-speech-streaming.mjs');
    await setupStreamingSpeech(options);
    return;
  }
  await setupLocalSpeech(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(failure => { console.error(failure instanceof Error ? failure.message : 'Local speech setup failed.'); process.exitCode = 1; });
}

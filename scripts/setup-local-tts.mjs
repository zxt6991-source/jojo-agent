/** Explicit candidate preparation; never modifies the production TTS choice. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { log } from 'node:console';
import { downloadFile, LOCAL_SPEECH_PYTHON_PACKAGES, runProcess, validateLocalProxy } from './setup-local-speech.mjs';
import { MELO_FILES, MELO_REPOSITORY, MELO_REVISION } from './local-tts-models.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function candidateModelReady(directory, files = MELO_FILES) {
  try {
    for (const file of files) {
      const target = join(directory, file.path), info = await stat(target);
      if (!info.isFile() || info.size !== file.bytes) return false;
      const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
      if (!file.sha256) hash.update(`blob ${info.size}\0`);
      for await (const bytes of createReadStream(target)) hash.update(bytes);
      if (hash.digest('hex') !== (file.sha256 ?? file.gitBlob)) return false;
    }
    return true;
  } catch { return false; }
}
/** Verified staging is published only after the entire model+lexicon+dictionary
 * matches. A failed transfer preserves any prior complete destination. */
export async function downloadTtsCandidate(directory, options = {}) {
  const files = options.files ?? MELO_FILES;
  if (!files.length || files.some(file => !file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '..' || part === '.')
    || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 64 * 1024 * 1024
    || (file.sha256 ? !/^[a-f0-9]{64}$/u.test(file.sha256) : !/^[a-f0-9]{40}$/u.test(file.gitBlob)))) throw new Error('Invalid TTS candidate manifest.');
  if (await candidateModelReady(directory, files)) return { reused: true };
  await mkdir(dirname(directory), { recursive: true });
  const stage = await mkdtemp(join(dirname(directory), '.MeloTTS-part-'));
  for (const file of files) {
    log(`Preparing pinned MeloTTS file: ${file.path}`);
    const transfer = () => downloadFile(join(stage, file.path), `${MELO_REPOSITORY}/resolve/${MELO_REVISION}/${file.path}`, {
      maximumBytes: Math.max(file.bytes, 65536), diagnoseDownload: options.diagnoseDownload ?? false, ...(options.proxy ? { proxy: options.proxy } : {}), ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    // A single bounded retry handles a transient proxy/redirect disconnect.
    // Exact size and digest checks below still decide whether to publish.
    try { await transfer(); } catch { await transfer(); }
  }
  if (!await candidateModelReady(stage, files)) throw new Error('The pinned MeloTTS checksum check failed; no model was published.');
  let previous;
  try { await stat(directory); previous = `${stage}.previous`; await rename(directory, previous); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, directory); }
  catch (error) { if (previous) await rename(previous, directory); throw error; }
  return { reused: false };
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    directory: { type: 'string' }, python: { type: 'string', default: 'python3' }, proxy: { type: 'string' },
    download: { type: 'boolean' }, 'install-runtime': { type: 'boolean' }, 'diagnose-download': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    process.stdout.write('Local experimental MeloTTS preparation. Default: offline checksum inspection only.\n--download explicitly fetches the pinned int8 model and dictionary (~74 MB).\n--install-runtime explicitly creates/reuses the venv with pinned numpy/sherpa wheels, no PyTorch.\n--directory PATH chooses the local speech root; --python PATH selects venv creation Python.\n--proxy URL accepts an existing loopback proxy for explicit downloads/install only.\nNo microphone, playback, Jojo settings, production TTS switch, or automatic inference.\n'); return;
  }
  if ([values.directory, values.python].some(value => value !== undefined && (!value.trim() || value.includes('\0')))) throw new Error('Invalid local speech path.');
  const proxy = values.proxy ? validateLocalProxy(values.proxy) : undefined;
  const root = resolve(values.directory ?? join(ROOT, '.local-speech')), directory = join(root, 'models', 'MeloTTS-zh-en-int8');
  const python = join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3');
  if (values['install-runtime']) {
    let ready = false; try { ready = (await stat(python)).isFile(); } catch { /* Explicit installation may create a new venv. */ }
    if (!ready) { await mkdir(root, { recursive: true }); await runProcess(values.python, ['-m', 'venv', join(root, 'venv')]); }
    await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', ...(proxy ? ['--proxy', proxy] : []), ...LOCAL_SPEECH_PYTHON_PACKAGES]);
  }
  if (values.download) await downloadTtsCandidate(directory, { proxy, diagnoseDownload: values['diagnose-download'] ?? false });
  const ready = await candidateModelReady(directory);
  const result = { candidate: 'sherpa-melo-int8', revision: MELO_REVISION, verifiedModelFiles: ready,
    modelBytes: MELO_FILES.reduce((sum, file) => sum + file.bytes, 0), inferenceChecked: false, pythonPath: python, modelDirectory: directory, productionTtsChanged: false };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!ready) process.exitCode = 2;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    const diagnostic = process.argv.includes('--diagnose-download') && error instanceof Error ? error.message.match(/\(curl exit (?:\d+|unknown), HTTP (?:\d+|unknown)\)/u)?.[0] : undefined;
    process.stderr.write(`Local TTS candidate preparation failed; check model checksums, local paths and the proxy.${diagnostic ? ` ${diagnostic}` : ''}\n`); process.exitCode = 1;
  });
}

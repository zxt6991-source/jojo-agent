import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, rename, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { log } from 'node:console';
import { runProcess, validateLocalProxy } from './setup-local-speech.mjs';
import { downloadPinnedFile, verifyPinnedFile } from './pinned-tts-download.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const COSYVOICE_MANIFEST = JSON.parse(await readFile(new URL('./cosyvoice-models.json', import.meta.url), 'utf8'));
export const COSYVOICE_PACKAGES = [
  'torch==2.3.1', 'torchaudio==2.3.1', 'numpy==1.26.4', 'onnxruntime==1.18.0', 'transformers==4.51.3',
  'huggingface-hub==0.30.2', 'HyperPyYAML==1.2.3', 'omegaconf==2.3.0', 'diffusers==0.31.0', 'conformer==0.3.2',
  'x-transformers==2.11.24', 'modelscope==1.20.0', 'librosa==0.10.2', 'inflect==7.3.1', 'soundfile==0.12.1',
  'openai-whisper==20231117', 'rich==13.7.1', 'scipy==1.13.1', 'pyarrow==18.1.0', 'pyworld==0.3.4', 'lightning==2.2.4',
  'hydra-core==1.3.2', 'gdown==5.1.0', 'matplotlib==3.7.5', 'wget==3.2'
];
export function cosyvoicePaths(root = join(ROOT, '.local-speech')) {
  const directory = resolve(root), evaluation = join(directory, 'cosyvoice-evaluation');
  return { directory, evaluation, source: join(evaluation, 'source'), model: join(directory, 'models', 'CosyVoice3-0.5B'),
    python: join(directory, 'venv-cosyvoice', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3') };
}
export async function cosyvoiceReady(paths, manifest = COSYVOICE_MANIFEST) {
  let sources = true, model = true;
  for (const source of manifest.sources) for (const file of source.files) {
    if (!await verifyPinnedFile(join(paths.evaluation, source.target, file.path), file)) sources = false;
  }
  for (const file of manifest.model.files) if (!await verifyPinnedFile(join(paths.model, file.path), file)) model = false;
  return { sources, model };
}
async function publish(stage, target) {
  let previous;
  try { await stat(target); previous = `${target}.previous-${randomUUID()}`; await rename(target, previous); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await rename(stage, target); } catch (error) { if (previous) await rename(previous, target); throw error; }
}
export async function prepareCosyvoice(paths, options = {}) {
  const current = await cosyvoiceReady(paths), transfer = options.transfer;
  if (!current.sources) {
    await mkdir(paths.evaluation, { recursive: true, mode: 0o700 });
    for (const source of COSYVOICE_MANIFEST.sources) {
      log(`Preparing pinned ${source.name} source...`);
      await downloadPinnedFile(join(paths.evaluation, `${source.name}-source.tar.gz`), { path: `${source.name}.tar.gz`, bytes: source.archiveBytes, sha256: source.archiveSha256 }, source.url, { proxy: options.proxy, transfer });
    }
    const stage = await mkdtemp(join(paths.evaluation, '.sources-part-'));
    await runProcess(options.python ?? 'python3.11', ['-B', join(ROOT, 'scripts/extract_cosyvoice_sources.py'), join(ROOT, 'scripts/cosyvoice-models.json'), paths.evaluation, stage]);
    await publish(stage, paths.source);
  }
  if (!current.model) {
    await mkdir(dirname(paths.model), { recursive: true, mode: 0o700 });
    // Stable per-revision staging retains verified files and resumable .part data.
    const stage = `${paths.model}.staging-${COSYVOICE_MANIFEST.model.revision}`;
    for (const file of COSYVOICE_MANIFEST.model.files) {
      log(`Preparing pinned CosyVoice3 file: ${file.path} (${file.bytes} bytes)`);
      await downloadPinnedFile(join(stage, file.path), file, `${COSYVOICE_MANIFEST.model.repository}/resolve/${COSYVOICE_MANIFEST.model.revision}/${file.path}`, { proxy: options.proxy, transfer });
    }
    await publish(stage, paths.model);
  }
  return cosyvoiceReady(paths);
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { directory: { type: 'string' }, python: { type: 'string', default: 'python3.11' }, proxy: { type: 'string' },
    download: { type: 'boolean' }, 'install-runtime': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { log('Offline inspection by default. --download fetches pinned official sources and ~5.43 GB inference weights, with resume.\n--install-runtime explicitly installs CPU packages in a separate venv-cosyvoice (Python 3.11).\n--directory PATH --python PATH --proxy http://127.0.0.1:PORT\nNo Jojo settings, microphones, playback, or production TTS change.'); return; }
  if ([values.directory, values.python].some(value => value !== undefined && (!value.trim() || value.includes('\0')))) throw new Error('Invalid local candidate path.');
  const paths = cosyvoicePaths(values.directory), proxy = values.proxy ? validateLocalProxy(values.proxy) : undefined;
  if (values['install-runtime']) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This runtime lock targets macOS arm64.');
    let ready = false; try { ready = (await stat(paths.python)).isFile(); } catch { /* Explicit setup may create it. */ }
    if (!ready) { await mkdir(paths.directory, { recursive: true }); await runProcess(values.python, ['-m', 'venv', join(paths.directory, 'venv-cosyvoice')]); }
    await runProcess(paths.python, ['-c', 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 11) else 2)']);
    const pip = ['-m', 'pip', 'install', '--disable-pip-version-check', ...(proxy ? ['--proxy', proxy] : [])];
    // Old Whisper uses pkg_resources during build; keep build tools local/pinned.
    await runProcess(paths.python, [...pip, 'setuptools==75.8.2', 'wheel==0.45.1', 'Cython==3.0.12', 'numpy==1.26.4']);
    await runProcess(paths.python, [...pip, '--no-build-isolation', '--constraint', join(ROOT, 'scripts/cosyvoice-macos-py311.lock.txt'), ...COSYVOICE_PACKAGES]);
  }
  const verified = values.download ? await prepareCosyvoice(paths, { python: values.python, proxy }) : await cosyvoiceReady(paths);
  const result = { candidate: 'cosyvoice3-cpu', ...verified, modelRevision: COSYVOICE_MANIFEST.model.revision,
    modelBytes: COSYVOICE_MANIFEST.model.files.reduce((sum, file) => sum + file.bytes, 0), inferenceChecked: false, productionTtsChanged: false,
    runtimeInstalledThisRun: values['install-runtime'] === true,
    pythonPath: paths.python, modelDirectory: paths.model, sourceDirectory: paths.source };
  log(JSON.stringify(result, null, 2)); if ((!verified.sources || !verified.model) && (!values['install-runtime'] || values.download)) process.exitCode = 2; return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  const status = error.httpStatus ? ` HTTP ${error.httpStatus}, curl ${error.downloadCode ?? 'unknown'}.` : '';
  process.stderr.write(`CosyVoice preparation failed; retained partial downloads can be resumed.${status}\n`); process.exitCode = 1;
});

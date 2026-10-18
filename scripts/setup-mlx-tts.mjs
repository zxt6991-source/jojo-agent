/** Explicit offline neural-voice preparation. Importing never downloads or runs inference. */
import { readFile, mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';
import { downloadPinnedFile, verifyPinnedFile, validPinnedFile } from './pinned-tts-download.mjs';
import { runProcess, validateLocalProxy } from './setup-local-speech.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const MLX_TTS_MANIFEST = JSON.parse(await readFile(new URL('./mlx-tts-models.json', import.meta.url), 'utf8'));
export async function prepareMlxTtsModel(directory, options = {}) {
  const manifest = options.manifest ?? MLX_TTS_MANIFEST;
  if (!/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+$/u.test(manifest.repository)
    || !/^[a-f0-9]{40}$/u.test(manifest.revision) || !Array.isArray(manifest.files) || !manifest.files.length
    || !manifest.files.every(validPinnedFile) || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Invalid pinned neural voice manifest.');
  for (const file of manifest.files) {
    const target = join(directory, file.path);
    if (options.download) await downloadPinnedFile(target, file, `${manifest.repository}/resolve/${manifest.revision}/${file.path}`, options);
    if (!await verifyPinnedFile(target, file)) return false;
  }
  return true;
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args: args.filter(arg => arg !== '--'), allowPositionals: false, options: {
    directory: { type: 'string' }, python: { type: 'string', default: 'python3.11' }, proxy: { type: 'string' },
    download: { type: 'boolean' }, 'install-runtime': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) {
    process.stdout.write('Offline Qwen3 neural voice for Apple Silicon. Default: local checksum inspection only.\n--download fetches the pinned ~1.69 GB model with verified resume.\n--install-runtime creates a separate venv-mlx-tts and installs the pinned wheel lock.\n--directory PATH chooses the local speech root; --python PATH selects Python 3.11.\n--proxy URL accepts an existing loopback proxy for explicit downloads only.\nNo microphone, playback, inference or Jojo configuration changes.\n'); return;
  }
  if ([values.directory, values.python].some(value => value !== undefined && (!value.trim() || value.includes('\0')))) throw new Error('Invalid local speech path.');
  const proxy = values.proxy ? validateLocalProxy(values.proxy) : undefined;
  const root = resolve(values.directory ?? join(ROOT, '.local-speech'));
  const pythonPath = join(root, 'venv-mlx-tts', 'bin', 'python3');
  const modelDirectory = join(root, 'models', 'Qwen3-TTS-0.6B-4bit');
  if (values['install-runtime']) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This locked neural voice runtime requires Apple Silicon macOS.');
    let exists = false; try { exists = (await stat(pythonPath)).isFile(); } catch { /* Explicit install may create the venv. */ }
    await runProcess(exists ? pythonPath : values.python, ['-c', 'import platform, sys; assert sys.version_info[:2] == (3, 11), "Python 3.11 required"; assert int(platform.mac_ver()[0].split(".")[0]) >= 26, "macOS 26 required by the pinned MLX wheel"']);
    if (!exists) { await mkdir(root, { recursive: true }); await runProcess(values.python, ['-m', 'venv', join(root, 'venv-mlx-tts')]); }
    await runProcess(pythonPath, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', ...(proxy ? ['--proxy', proxy] : []), '-r', join(ROOT, 'scripts', 'mlx-tts-macos-py311.lock.txt')]);
  }
  const ready = await prepareMlxTtsModel(modelDirectory, { download: values.download, proxy });
  const result = { engine: 'mlx-qwen3', revision: MLX_TTS_MANIFEST.revision, verifiedModelFiles: ready,
    modelBytes: MLX_TTS_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0), pythonPath, modelDirectory,
    settingsChanged: false, inferenceChecked: false };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!ready && !(values['install-runtime'] && !values.download)) process.exitCode = 2;
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => {
  process.stderr.write('Offline neural voice preparation failed; check local paths, supported macOS/Python, checksums and proxy.\n'); process.exitCode = 1;
});

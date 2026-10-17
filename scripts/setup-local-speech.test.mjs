import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';

const { Response, queueMicrotask } = globalThis;

import {
  downloadArchive, downloadHuggingFaceModel, extractModelArchive, HUGGINGFACE_MODEL_FILES, HUGGINGFACE_REVISION,
  modelFilesReady, parseSetupArguments, SENSEVOICE_ARCHIVE_PREFIX, SENSEVOICE_ARCHIVE_URL, SENSEVOICE_MODEL_SHA256, validateLocalProxy
} from './setup-local-speech.mjs';

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jojo-local-speech-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function missing(path) { await assert.rejects(stat(path), { code: 'ENOENT' }); }
function response(chunks, headers = {}) {
  return new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(Buffer.from(chunk));
    controller.close();
  } }), { headers });
}

test('setup arguments default to local paths and reject incomplete flags', () => {
  const defaults = parseSetupArguments([]);
  assert.match(defaults.directory, /jojo-agent\/\.local-speech$/u);
  assert.equal(defaults.python, 'python3'); assert.equal(defaults.skipInstall, false);
  assert.equal(defaults.source, 'github'); assert.equal(defaults.diagnoseDownload, false);
  assert.equal(parseSetupArguments(['--source', 'huggingface', '--diagnose-download']).diagnoseDownload, true);
  assert.equal(parseSetupArguments(['--python', '/local venv/python', '--skip-install']).python, '/local venv/python');
  for (const args of [['--directory'], ['--python', '--help'], ['--remote-model', 'http://bad'], ['--source', 'untrusted']]) {
    assert.throws(() => parseSetupArguments(args));
  }
});

test('proxy arguments accept only explicit loopback endpoints without secrets or URL extras', () => {
  for (const proxy of ['http://127.0.0.1:7897', 'https://localhost:80', 'socks5h://[::1]:1080']) {
    assert.equal(validateLocalProxy(proxy), proxy);
    assert.equal(parseSetupArguments(['--proxy', proxy]).proxy, proxy);
  }
  for (const proxy of ['https://example.com:7897', 'http://127.0.0.1', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    'http://username:password@127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897?password=value',
    'http://127.0.0.1:7897#secret', 'socks5://127.0.0.1:1080', ' http://127.0.0.1:7897']) {
    assert.throws(() => parseSetupArguments(['--proxy', proxy]), /^Error: --proxy requires a loopback/u);
  }
});

test('downloads only the fixed official model and publishes a complete archive atomically', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  const result = await downloadArchive(destination, { fetchImpl: async (url, options) => {
    assert.equal(url, SENSEVOICE_ARCHIVE_URL); assert.equal(options.redirect, 'follow');
    return response(['first ', 'second'], { 'content-length': '12' });
  } });
  assert.equal(result.bytes, 12); assert.equal(await readFile(destination, 'utf8'), 'first second');
  await missing(`${destination}.part`);
});

test('failed, truncated, and oversized downloads never replace a previously completed archive', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  await writeFile(destination, 'previous archive');
  const cases = [
    () => new Response('rejected', { status: 403 }),
    () => response(['short'], { 'content-length': '10' }),
    () => response(['too long'], { 'content-length': '8' }),
    () => response(['small', 'overflow']),
    () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('partial')); controller.error(new Error('interrupted download'));
    } }))
  ];
  for (const fetchImpl of cases) {
    await assert.rejects(downloadArchive(destination, { fetchImpl, maximumBytes: 7 }));
    assert.equal(await readFile(destination, 'utf8'), 'previous archive');
  }
  assert.ok((await stat(`${destination}.part`)).isFile());
});

test('download timeouts abort the request and do not publish an archive', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  await assert.rejects(downloadArchive(destination, { timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_done, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) }));
  await missing(destination);
});

function curlFixture({ content = 'complete archive', exitCode = 0, httpStatus = '200' } = {}) {
  const calls = [];
  const curlSpawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => { child.emit('close', -1); return true; };
    queueMicrotask(() => {
      const target = args[args.indexOf('--output') + 1];
      void writeFile(target, content).then(() => {
        child.stdout.write(httpStatus); child.emit('close', exitCode);
      }, () => child.emit('error', new Error('untrusted raw error')));
    });
    return child;
  };
  return { calls, curlSpawn };
}

test('a fetch transport failure gets exactly one bounded fixed-URL curl fallback', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  const fixture = curlFixture();
  const result = await downloadArchive(destination, { fetchImpl: () => { throw new Error('secret proxy credentials'); }, curlSpawn: fixture.curlSpawn });
  assert.equal(result.bytes, 16); assert.equal(await readFile(destination, 'utf8'), 'complete archive');
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  assert.equal(call.executable, 'curl');
  assert.deepEqual(call.options, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.deepEqual(call.args, [
    '--disable', '--silent', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
    '--retry', '0', '--max-filesize', `${500 * 1024 * 1024}`, '--connect-timeout', '20', '--max-time', '180',
    '--write-out', '%{http_code}', '--output', `${destination}.part`, '--', SENSEVOICE_ARCHIVE_URL
  ]);
  await missing(`${destination}.part`);
});

test('an explicit loopback proxy goes straight to curl for both trusted sources', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  const proxy = 'http://127.0.0.1:7897'; const fixture = curlFixture(); let fetchCalls = 0;
  const options = { proxy, curlSpawn: fixture.curlSpawn, fetchImpl: () => { fetchCalls++; throw new Error('must not be called'); } };
  await downloadArchive(destination, options);
  await assert.rejects(downloadHuggingFaceModel(join(directory, 'models', 'SenseVoiceSmall'), options), /SHA256 check failed/u);
  assert.equal(fetchCalls, 0); assert.equal(fixture.calls.length, 4);
  for (const call of fixture.calls) assert.equal(call.args[call.args.indexOf('--proxy') + 1], proxy);
  assert.deepEqual(fixture.calls.map(call => call.args.at(-1)), [SENSEVOICE_ARCHIVE_URL, ...HUGGINGFACE_MODEL_FILES.map(file => file.url)]);
  await assert.rejects(downloadArchive(destination, { ...options, proxy: 'http://remote.example:7897' }), /--proxy requires a loopback/u);
  assert.equal(fixture.calls.length, 4);
});

test('failed, empty, and oversized curl output never replace a completed archive or retry curl', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  await writeFile(destination, 'previous archive');
  for (const options of [{ content: 'partial', exitCode: 22 }, { content: '' }, { content: 'oversized' }]) {
    const fixture = curlFixture(options);
    await assert.rejects(downloadArchive(destination, { fetchImpl: () => { throw new Error('secret'); },
      curlSpawn: fixture.curlSpawn, maximumBytes: 7 }));
    assert.equal(fixture.calls.length, 1);
    assert.equal(await readFile(destination, 'utf8'), 'previous archive');
    assert.ok((await stat(`${destination}.part`)).isFile());
  }
  await assert.rejects(downloadArchive(destination, { fetchImpl: () => { throw new Error('secret proxy'); },
    curlSpawn: () => { throw new Error('raw credentials must not escape'); } }), { message: 'Could not start the system HTTPS downloader.' });
});

test('HTTP and validation failures do not trigger a second downloader', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  const fixture = curlFixture();
  for (const fetchImpl of [() => new Response('forbidden', { status: 403 }), () => response(['exceeds limit'])]) {
    await assert.rejects(downloadArchive(destination, { fetchImpl, curlSpawn: fixture.curlSpawn, maximumBytes: 7 }));
  }
  assert.equal(fixture.calls.length, 0); await missing(destination);
});

test('diagnostics report only controlled HTTP and curl exit codes', async t => {
  const directory = await workspace(t); const destination = join(directory, 'archive.tar.bz2');
  const fixture = curlFixture({ exitCode: 22, httpStatus: '403' });
  await assert.rejects(downloadArchive(destination, { diagnoseDownload: true,
    fetchImpl: () => { throw new Error('raw proxy username:password'); }, curlSpawn: fixture.curlSpawn }),
  { message: 'The system HTTPS model download failed. (curl exit 22, HTTP 403)' });
  const unsafe = curlFixture({ exitCode: 6, httpStatus: 'raw proxy username:password' });
  await assert.rejects(downloadArchive(destination, { diagnoseDownload: true,
    fetchImpl: () => { throw new Error('raw proxy username:password'); }, curlSpawn: unsafe.curlSpawn }),
  { message: 'The system HTTPS model download failed. (curl exit 6, HTTP unknown)' });
  await assert.rejects(downloadArchive(destination, { diagnoseDownload: true,
    fetchImpl: () => new Response('private body', { status: 503 }) }),
  { message: 'Could not download the official SenseVoice model file. (HTTP 503)' });
});

test('Hugging Face sources are pinned to the author revision and published model digest', () => {
  assert.equal(HUGGINGFACE_REVISION, '2365baeacb507f821a0c8120fcee3d484dba7a07');
  assert.equal(SENSEVOICE_MODEL_SHA256, 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51');
  assert.deepEqual(HUGGINGFACE_MODEL_FILES.map(file => file.path), ['model.int8.onnx', 'tokens.txt', 'test_wavs/zh.wav']);
  for (const file of HUGGINGFACE_MODEL_FILES) assert.equal(file.url,
    `https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/${HUGGINGFACE_REVISION}/${file.path}`);
});

test('Hugging Face download or digest failures leave the previous model intact', async t => {
  const directory = await workspace(t); const destination = join(directory, 'models', 'SenseVoiceSmall');
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, 'model.int8.onnx'), 'previous model');
  for (const failDownload of [false, true]) {
    const requested = [];
    await assert.rejects(downloadHuggingFaceModel(destination, { fetchImpl: async url => {
      requested.push(url);
      if (failDownload && url.endsWith('/tokens.txt')) return new Response('private error body', { status: 403 });
      return response(['synthetic fixture']);
    } }), failDownload ? /Could not download/u : /SHA256 check failed/u);
    assert.deepEqual(requested, HUGGINGFACE_MODEL_FILES.slice(0, failDownload ? 2 : 3).map(file => file.url));
    assert.equal(await readFile(join(destination, 'model.int8.onnx'), 'utf8'), 'previous model');
    await missing(join(destination, 'tokens.txt'));
  }
});

const python = process.env.PYTHON ?? 'python3';
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
const CREATE_FIXTURE = String.raw`
import io
import json
import sys
import tarfile
with tarfile.open(sys.argv[1], "w:bz2") as package:
    for entry in json.loads(sys.argv[2]):
        item = tarfile.TarInfo(entry["name"])
        content = entry.get("content", "fixture").encode()
        item.size = len(content)
        if entry.get("link"):
            item.type = tarfile.SYMTYPE
            item.linkname = entry["link"]
            item.size = 0
        package.addfile(item, io.BytesIO(content) if item.isfile() else None)
`;
async function archiveFixture(directory, extras = [], omit) {
  const archive = join(directory, 'fixture.tar.bz2');
  const entries = ['model.int8.onnx', 'tokens.txt', 'test_wavs/zh.wav']
    .filter(name => name !== omit).map(name => ({ name: `${SENSEVOICE_ARCHIVE_PREFIX}/${name}` }));
  const built = spawnSync(python, ['-I', '-c', CREATE_FIXTURE, archive, JSON.stringify([...entries, ...extras])], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return archive;
}

test('extracts just the three required files and reuses their readiness check', { skip: !hasPython }, async t => {
  const directory = await workspace(t); const destination = join(directory, 'models', 'SenseVoiceSmall');
  const archive = await archiveFixture(directory, [{ name: `${SENSEVOICE_ARCHIVE_PREFIX}/export-onnx.py`, content: 'must not run or extract' }]);
  await extractModelArchive(archive, destination, { python });
  assert.equal(await modelFilesReady(destination), true);
  await missing(join(destination, 'export-onnx.py'));
  await writeFile(join(destination, 'tokens.txt'), '');
  assert.equal(await modelFilesReady(destination), false);
});

test('archive path traversal, links, duplicate model files, and missing files never publish a model', { skip: !hasPython }, async t => {
  const directory = await workspace(t);
  const cases = [
    [{ name: `${SENSEVOICE_ARCHIVE_PREFIX}/../escaped`, content: 'bad' }],
    [{ name: '/absolute/escape', content: 'bad' }],
    [{ name: `${SENSEVOICE_ARCHIVE_PREFIX}\\escape`, content: 'bad' }],
    [{ name: `${SENSEVOICE_ARCHIVE_PREFIX}/shortcut`, link: '/tmp/elsewhere' }],
    [{ name: `${SENSEVOICE_ARCHIVE_PREFIX}/model.int8.onnx`, content: 'duplicate' }],
    []
  ];
  for (const [index, entries] of cases.entries()) {
    const root = join(directory, `${index}`); await mkdir(root);
    const archive = await archiveFixture(root, entries, index === cases.length - 1 ? 'tokens.txt' : undefined);
    const destination = join(root, 'models', 'SenseVoiceSmall');
    await assert.rejects(extractModelArchive(archive, destination, { python }));
    await missing(destination); await missing(join(root, 'escaped'));
  }
});

test('a valid rerun can replace an incomplete model while retaining the previous files', { skip: !hasPython }, async t => {
  const directory = await workspace(t); const destination = join(directory, 'models', 'SenseVoiceSmall');
  await mkdir(destination, { recursive: true }); await writeFile(join(destination, 'tokens.txt'), 'old partial');
  const archive = await archiveFixture(directory);
  await extractModelArchive(archive, destination, { python });
  assert.equal(await modelFilesReady(destination), true);
  assert.equal(await readFile(join(destination, 'tokens.txt'), 'utf8'), 'fixture');
});

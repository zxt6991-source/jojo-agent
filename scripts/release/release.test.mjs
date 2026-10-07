import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareArtifacts, verifyArtifacts } from './artifacts.mjs';
import { snapshot, restore, verifySnapshot } from './snapshot.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'make'); await mkdir(input);
  const sbom = path.join(root, 'bill.json');
  await writeFile(sbom, JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{ name: 'fixture' }] }));
  return { root, input, output: path.join(root, 'candidate'), sbom, version: '0.1.0', commit: 'a'.repeat(40), platform: 'linux', arch: 'x64', compatibility: { appVersion: '0.1.0' } };
}
test('release verifies exact bytes and rejects tampered, extra and missing files', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.input, 'app.deb'), 'installer');
  await prepareArtifacts(options);
  assert.equal((await verifyArtifacts(options.output)).commit, options.commit);
  await writeFile(path.join(options.output, 'unexpected.zip'), 'extra');
  await assert.rejects(verifyArtifacts(options.output), /Untracked/);
  await rm(path.join(options.output, 'unexpected.zip'));
  await writeFile(path.join(options.output, 'app.deb'), 'tampered');
  await assert.rejects(verifyArtifacts(options.output), /integrity/);
  await rm(path.join(options.output, 'app.deb'));
  await assert.rejects(verifyArtifacts(options.output));
});
test('release requires installer, matching version, SBOM and a new output directory', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareArtifacts(options), /Missing/);
  await writeFile(path.join(options.input, 'app.deb'), 'installer');
  await assert.rejects(prepareArtifacts({ ...options, version: '0.2.0' }), /version mismatch/);
  await writeFile(options.sbom, '{}');
  await assert.rejects(prepareArtifacts(options), /SBOM/);
  await writeFile(options.sbom, JSON.stringify({ spdxVersion: 'SPDX-2.3', packages: [{ name: 'fixture' }] }));
  await prepareArtifacts(options);
  await assert.rejects(prepareArtifacts(options), /EEXIST/);
});
test('release rejects manifest path traversal without reading outside the bundle', async t => {
  const options = await fixture(t);
  await mkdir(options.output);
  await writeFile(path.join(options.output, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: '../secret' }] }));
  await assert.rejects(verifyArtifacts(options.output), /Unsafe/);
});
test('offline backup and restore preserve binary data and reject overwrite or corruption', async t => {
  const { root, input } = await fixture(t);
  const data = Buffer.from([0, 1, 255, 2]);
  await writeFile(path.join(input, 'application.sqlite'), data);
  const backup = path.join(root, 'backup'), restored = path.join(root, 'restored');
  await snapshot(input, backup);
  await verifySnapshot(backup);
  await restore(backup, restored);
  assert.deepEqual(await readFile(path.join(restored, 'application.sqlite')), data);
  await assert.rejects(restore(backup, restored), /already exists/);
  await assert.rejects(snapshot(input, path.join(input, 'nested')), /outside/);
  await writeFile(path.join(backup, 'data', 'application.sqlite'), 'corrupt');
  await assert.rejects(restore(backup, path.join(root, 'invalid')), /integrity/);
  assert.deepEqual(await readFile(path.join(input, 'application.sqlite')), data);
});

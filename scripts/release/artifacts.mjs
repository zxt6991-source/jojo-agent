import process from 'node:process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function collectFiles(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${name}`);
    if (entry.isDirectory()) result.push(...await collectFiles(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported file: ${name}`);
  }
  return result.sort();
}
export async function recordFile(directory, name) {
  if (!name || name.includes('\\') || path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe artifact path');
  let current = directory;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not allowed');
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(current)) { hash.update(chunk); size += chunk.length; }
  return { path: name, size, sha256: hash.digest('hex') };
}
export async function prepareArtifacts({ input, output, sbom, version, commit, platform, arch, compatibility }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid version or commit');
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid platform/architecture');
  if (compatibility.appVersion !== version) throw new Error('Compatibility version mismatch');
  const names = (await collectFiles(input)).filter(name => /\.(zip|deb|exe|nupkg)$/.test(name) || path.basename(name) === 'RELEASES');
  const required = { darwin: '.zip', win32: '.exe', linux: '.deb' }[platform];
  if (!names.some(name => name.endsWith(required))) throw new Error(`Missing ${platform} installer (${required})`);
  const bill = JSON.parse(await readFile(sbom, 'utf8'));
  if (bill.spdxVersion !== 'SPDX-2.3' || !Array.isArray(bill.packages) || !bill.packages.length) throw new Error('A nonempty SPDX 2.3 SBOM is required');
  await mkdir(output, { recursive: false }); // never overwrite a prior release
  for (const name of names) {
    await mkdir(path.dirname(path.join(output, name)), { recursive: true });
    await copyFile(path.join(input, name), path.join(output, name));
  }
  await copyFile(sbom, path.join(output, 'sbom.spdx.json'));
  const files = await Promise.all([...names, 'sbom.spdx.json'].sort().map(name => recordFile(output, name)));
  const manifest = { schemaVersion: 1, version, commit, platform, arch, compatibility, channel: 'candidate', files };
  await writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const manifestFile = await recordFile(output, 'release-manifest.json');
  await writeFile(path.join(output, 'SHA256SUMS'), [...files, manifestFile].map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n');
  await verifyArtifacts(output);
  return manifest;
}
export async function verifyArtifacts(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid release manifest');
  const expected = new Set(['release-manifest.json', 'SHA256SUMS']);
  for (const file of manifest.files) {
    if (expected.has(file.path)) throw new Error('Duplicate or reserved artifact path');
    expected.add(file.path);
    const actual = await recordFile(directory, file.path);
    if (actual.size !== file.size || actual.sha256 !== file.sha256) throw new Error(`Artifact integrity failed: ${file.path}`);
  }
  const names = await collectFiles(directory);
  if (names.length !== expected.size || names.some(name => !expected.has(name))) throw new Error('Untracked or missing artifact');
  const records = [...manifest.files, await recordFile(directory, 'release-manifest.json')];
  const checksums = records.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n';
  if (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8') !== checksums) throw new Error('Checksum manifest mismatch');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'verify' && args.length === 1) await verifyArtifacts(args[0]);
  else if (command === 'prepare' && args.length === 7) {
    const [input, output, sbom, version, commit, platform, arch] = args;
    const { BUILD_COMPATIBILITY } = await import('../../packages/contracts/src/build-compatibility.ts');
    await prepareArtifacts({ input, output, sbom, version, commit, platform, arch, compatibility: BUILD_COMPATIBILITY });
  } else throw new Error('Usage: artifacts.mjs verify DIRECTORY | prepare INPUT OUTPUT SBOM VERSION COMMIT PLATFORM ARCH');
}

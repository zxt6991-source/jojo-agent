import process from 'node:process';
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { collectFiles, recordFile } from './artifacts.mjs';

async function records(directory) {
  const files = [];
  for (const name of await collectFiles(directory)) files.push(await recordFile(directory, name));
  return files;
}

async function requireAbsent(destination) {
  try { await lstat(destination); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Destination already exists; never overwrite live data');
}
export async function snapshot(source, destination) {
  const origin = path.resolve(source), target = path.resolve(destination);
  if (target === origin || target.startsWith(origin + path.sep)) throw new Error('Backup must be outside the source');
  await requireAbsent(target);
  const before = await records(origin);
  const staging = `${target}.partial-${randomUUID()}`;
  try {
    await mkdir(staging, { mode: 0o700 });
    await cp(origin, path.join(staging, 'data'), { recursive: true, errorOnExist: true, force: false });
    const after = await records(origin);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source changed; stop all hosts before backup');
    await writeFile(path.join(staging, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, files: before }, null, 2), { mode: 0o600 });
    await verifySnapshot(staging);
    await rename(staging, target);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
export async function verifySnapshot(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid snapshot');
  const data = path.join(directory, 'data');
  const actual = await records(data);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Snapshot integrity failed');
}
export async function restore(source, destination) {
  await requireAbsent(destination);
  await verifySnapshot(source);
  const staging = `${destination}.partial-${randomUUID()}`;
  try {
    await cp(path.join(source, 'data'), staging, { recursive: true, errorOnExist: true, force: false });
    const expected = JSON.parse(await readFile(path.join(source, 'snapshot.json'), 'utf8')).files;
    const actual = await records(staging);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored data integrity failed');
    await rename(staging, destination);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, source, destination, offline] = process.argv.slice(2);
  if (command === 'verify' && source && !destination) await verifySnapshot(source);
  else if (source && destination && offline === '--offline' && ['backup', 'restore'].includes(command)) await (command === 'backup' ? snapshot : restore)(source, destination);
  else throw new Error('Stop all hosts first. Usage: snapshot.mjs backup|restore SOURCE NEW_DESTINATION --offline | verify SNAPSHOT');
}

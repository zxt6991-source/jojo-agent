import { URL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
const root = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const desktop = JSON.parse(await readFile(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8'));
if (root.version !== desktop.version) throw new Error('Root and Desktop versions differ');
if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF !== `refs/tags/v${root.version}`) throw new Error('Tag must match package version exactly');
console.log(`Release version: ${root.version}`);

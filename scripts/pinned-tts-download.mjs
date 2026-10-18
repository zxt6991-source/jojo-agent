/** Explicit, resumable large-model transfer. No network work at import time. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { validateLocalProxy } from './setup-local-speech.mjs';

export function validPinnedFile(file) {
  return file && typeof file.path === 'string' && file.path && !file.path.startsWith('/') && !file.path.includes('\\')
    && file.path.split('/').every(part => part && part !== '.' && part !== '..')
    && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= 3 * 1024 ** 3
    && (file.sha256 ? /^[a-f0-9]{64}$/u.test(file.sha256) : /^[a-f0-9]{40}$/u.test(file.gitBlob));
}
export async function verifyPinnedFile(target, file) {
  if (!validPinnedFile(file)) return false;
  try {
    const info = await stat(target);
    if (!info.isFile() || info.size !== file.bytes) return false;
    const hash = createHash(file.sha256 ? 'sha256' : 'sha1');
    if (!file.sha256) hash.update(`blob ${info.size}\0`);
    for await (const bytes of createReadStream(target)) hash.update(bytes);
    return hash.digest('hex') === (file.sha256 ?? file.gitBlob);
  } catch { return false; }
}
export async function fileBytes(target) {
  try { const info = await stat(target); if (!info.isFile()) throw new Error('invalid_partial'); return info.size; }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
function curlTransfer({ url, partial, offset, maximumBytes, proxy, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let status = '', finished = false, deadline;
    const finish = error => { if (finished) return; finished = true; clearTimeout(deadline); if (error) reject(error); else resolve(); };
    const child = spawnImpl('curl', ['--disable', '--silent', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
      ...(proxy ? ['--proxy', proxy] : []), ...(offset ? ['--continue-at', '-'] : []), '--connect-timeout', '20', '--max-time', '600',
      '--max-filesize', String(Math.max(65536, maximumBytes)), '--write-out', '%{http_code}', '--output', partial, '--', url],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', data => { if (status.length <= 64) status += data.toString(); });
    child.once('error', () => finish(new Error('Model downloader unavailable.')));
    child.once('close', code => {
      const error = new Error('Pinned model transfer failed.');
      error.downloadCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
      error.httpStatus = /^(?:000|[1-5]\d{2})$/u.test(status.trim()) ? status.trim() : null;
      finish(code === 0 ? undefined : error);
    });
    deadline = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Model transfer timed out.')); }, 601000);
  });
}
/** A failed transfer retains .part. Only exact size+digest matches are renamed
 * into place. Signed redirects and remote diagnostics are never printed. */
export async function downloadPinnedFile(target, file, url, options = {}) {
  if (!validPinnedFile(file) || !url.startsWith('https://')) throw new Error('Invalid pinned model descriptor.');
  const proxy = options.proxy ? validateLocalProxy(options.proxy) : undefined;
  if (await verifyPinnedFile(target, file)) return { reused: true };
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = `${target}.part`;
  if (file.bytes === 0) { const handle = await open(partial, 'a', 0o600); await handle.close(); }
  for (let attempt = 0; attempt < 2; attempt++) {
    const offset = await fileBytes(partial);
    if (offset > file.bytes) { await rename(partial, `${partial}.invalid-${randomUUID()}`); throw new Error('Invalid partial model size.'); }
    if (offset < file.bytes) {
      const handle = await open(partial, 'a', 0o600); await handle.close();
      try { await (options.transfer ?? curlTransfer)({ url, partial, offset, maximumBytes: file.bytes, ...(proxy ? { proxy } : {}) }); }
      catch (error) {
        if (await fileBytes(partial) > file.bytes) { await rename(partial, `${partial}.invalid-${randomUUID()}`); throw new Error('Model exceeded its pinned size.'); }
        if (attempt === 1) throw error;
        // curl refuses to append a server's full 200 response to a range resume.
        if (error.downloadCode === 33 && offset) await rename(partial, `${partial}.nonresumable-${randomUUID()}`);
        continue;
      }
    }
    if (!await verifyPinnedFile(partial, file)) { await rename(partial, `${partial}.invalid-${randomUUID()}`); throw new Error('Pinned model digest mismatch.'); }
    await rename(partial, target); return { reused: false };
  }
  throw new Error('Pinned model transfer did not complete.');
}

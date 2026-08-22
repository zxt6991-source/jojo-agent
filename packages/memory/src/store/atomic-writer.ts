import { chmod, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(target: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.jojo-${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    try {
      const directory = await open(path.dirname(target), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* Directory fsync is not available on every platform. */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

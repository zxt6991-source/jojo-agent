import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function backupFileToTrash(options: {
  trashDirectory: string;
  sessionId: string;
  root: string;
  target: string;
  operation: 'overwrite' | 'delete';
}): Promise<string> {
  const relativePath = path.relative(options.root, options.target);
  const entryDirectory = path.join(
    options.trashDirectory,
    options.sessionId,
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
  );
  const backupPath = path.join(entryDirectory, 'files', relativePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(options.target, backupPath);
  await writeFile(path.join(entryDirectory, 'metadata.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId: options.sessionId,
    operation: options.operation,
    originalPath: options.target,
    relativePath,
    createdAt: new Date().toISOString()
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return entryDirectory;
}

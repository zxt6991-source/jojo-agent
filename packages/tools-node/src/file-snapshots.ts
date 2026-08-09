import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type FileSnapshot = {
  sha256: string;
  mtimeMs: number;
  size: number;
  completeRead: boolean;
};

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function inspectFile(file: string, completeRead: boolean): Promise<FileSnapshot> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('The requested path is not a regular file.');
  return {
    sha256: await sha256File(file),
    mtimeMs: info.mtimeMs,
    size: info.size,
    completeRead
  };
}

export class FileSnapshotRegistry {
  private readonly snapshots = new Map<string, FileSnapshot>();

  set(file: string, snapshot: FileSnapshot): void {
    this.snapshots.set(file, snapshot);
  }

  get(file: string): FileSnapshot | undefined {
    return this.snapshots.get(file);
  }

  async record(file: string, completeRead: boolean): Promise<FileSnapshot> {
    const snapshot = await inspectFile(file, completeRead);
    this.set(file, snapshot);
    return snapshot;
  }

  async assertCurrent(file: string, requireCompleteRead = false): Promise<FileSnapshot> {
    const snapshot = this.get(file);
    if (!snapshot || (requireCompleteRead && !snapshot.completeRead)) {
      const qualifier = requireCompleteRead ? ' completely' : '';
      throw Object.assign(new Error(`Read the file${qualifier} before modifying it.`), { code: 'read_required' });
    }

    const current = await inspectFile(file, snapshot.completeRead);
    if (
      current.sha256 !== snapshot.sha256
      || current.size !== snapshot.size
      || current.mtimeMs !== snapshot.mtimeMs
    ) {
      throw Object.assign(new Error('The file changed after it was read. Read it again before modifying it.'), { code: 'file_conflict' });
    }
    return snapshot;
  }
}

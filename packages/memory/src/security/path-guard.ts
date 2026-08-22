import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MemoryError } from '@desktop-agent/contracts';

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function guardedMemoryPath(root: string, scopeDirectory: string, requested: string): Promise<string> {
  if (path.isAbsolute(requested) || requested.includes('\0')) {
    throw new MemoryError('memory_permission_denied', 'Memory paths must be relative.');
  }
  const canonicalRoot = await realpath(root);
  const canonicalScope = await realpath(scopeDirectory);
  if (!inside(canonicalRoot, canonicalScope)) {
    throw new MemoryError('memory_permission_denied', 'Memory scope escaped the configured root.');
  }
  const target = path.resolve(canonicalScope, requested);
  if (!inside(canonicalScope, target)) {
    throw new MemoryError('memory_permission_denied', 'Memory path traversal is not allowed.');
  }
  let cursor = canonicalScope;
  for (const segment of path.relative(canonicalScope, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new MemoryError('memory_permission_denied', 'Symbolic links are not allowed in Memory.');
      const resolved = await realpath(cursor);
      if (!inside(canonicalScope, resolved)) {
        throw new MemoryError('memory_permission_denied', 'Memory path escaped through a symbolic link.');
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export async function resolveWorkspaceRoot(workingDirectory: string): Promise<string> {
  return realpath(path.resolve(workingDirectory));
}

export async function resolveExistingPath(root: string, requestedPath: string): Promise<string> {
  return realpath(path.resolve(root, requestedPath));
}

export async function resolveWorkspacePath(
  workingDirectory: string,
  requestedPath: string
): Promise<{ root: string; target: string; inside: boolean }> {
  const root = await resolveWorkspaceRoot(workingDirectory);
  const target = await resolveExistingPath(root, requestedPath);
  return { root, target, inside: isInside(root, target) };
}

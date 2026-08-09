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

export async function resolveWritableWorkspacePath(
  workingDirectory: string,
  requestedPath: string
): Promise<{ root: string; target: string; inside: boolean; exists: boolean }> {
  const root = await resolveWorkspaceRoot(workingDirectory);
  const candidate = path.resolve(root, requestedPath);
  if (!isInside(root, candidate)) return { root, target: candidate, inside: false, exists: false };

  try {
    const target = await realpath(candidate);
    return { root, target, inside: isInside(root, target), exists: true };
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    let ancestor = path.dirname(candidate);
    const missingSegments = [path.basename(candidate)];
    let realAncestor: string;
    while (true) {
      try {
        realAncestor = await realpath(ancestor);
        break;
      } catch (ancestorError: any) {
        if (ancestorError?.code !== 'ENOENT' || ancestor === path.dirname(ancestor)) throw ancestorError;
        missingSegments.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    const target = path.join(realAncestor, ...missingSegments);
    return { root, target, inside: isInside(root, realAncestor) && isInside(root, target), exists: false };
  }
}

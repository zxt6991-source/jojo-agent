import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { OrchestrationError } from '../errors.js';

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function isolationSegment(value: string, fallback = 'agent'): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

export async function canonicalizeExisting(target: string): Promise<string> {
  try {
    return await realpath(path.resolve(target));
  } catch (error) {
    throw new OrchestrationError(
      'worktree_path_invalid',
      `Unable to resolve path: ${target}`,
      error
    );
  }
}

export async function assertManagedPath(root: string, target: string): Promise<string> {
  const resolvedRoot = await canonicalizeExisting(root);
  const resolvedTarget = await canonicalizeExisting(target);
  if (resolvedTarget === resolvedRoot || !isInside(resolvedRoot, resolvedTarget)) {
    throw new OrchestrationError(
      'worktree_path_invalid',
      'Refusing to operate on a path outside the isolation root.'
    );
  }
  return resolvedTarget;
}

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectIdentity } from '@desktop-agent/contracts';

export async function createProjectIdentity(workingDirectory: string): Promise<ProjectIdentity | undefined> {
  try {
    const canonicalPath = await realpath(path.resolve(workingDirectory));
    const digest = createHash('sha256')
      .update(process.platform)
      .update('\0')
      .update(canonicalPath)
      .digest('hex');
    return {
      id: `prj_${digest}`,
      displayName: path.basename(canonicalPath) || canonicalPath,
      canonicalPath
    };
  } catch {
    return undefined;
  }
}

export function projectScopeDirectoryName(identity: ProjectIdentity): string {
  const safeName = identity.displayName
    .normalize('NFKC')
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80) || 'project';
  return `${safeName}--${identity.id}`;
}

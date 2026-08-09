import { realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isInside } from './workspace-paths.js';

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'out', 'coverage', '.next', '.cache']);

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/');
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') source += '[^/]*';
    else if (character === '?') source += '[^/]';
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

export async function collectWorkspaceFiles(
  root: string,
  directory: string,
  limit: number,
  accept: (file: string) => boolean = () => true
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const candidate = path.join(current, entry.name);
      let resolved: string;
      try { resolved = await realpath(candidate); } catch { continue; }
      if (!isInside(root, resolved)) continue;
      if (entry.isDirectory()) {
        await walk(resolved);
        if (truncated) return;
      } else if (entry.isFile()) {
        if (!accept(resolved)) continue;
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(resolved);
      }
    }
  };

  await walk(directory);
  return { files, truncated };
}

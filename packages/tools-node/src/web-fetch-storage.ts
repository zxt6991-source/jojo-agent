import { mkdir, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isInside } from './workspace-paths.js';

export const WEB_FETCH_INLINE_BYTES = 64 * 1024;
export const WEB_FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_PREVIEW_LINES = 40;
export const WEB_FETCH_MAX_HEADINGS = 50;
export const WEB_FETCH_TTL_MS = 24 * 60 * 60 * 1000;

export function webFetchSpillDirectory(): string {
  return path.join(os.tmpdir(), 'jojo-web-fetch');
}

export async function isWebFetchSpillPath(target: string): Promise<boolean> {
  try {
    const root = await realpath(webFetchSpillDirectory());
    const resolved = await realpath(target);
    return isInside(root, resolved);
  } catch {
    return false;
  }
}

export function buildWebFetchOutline(markdown: string, max = WEB_FETCH_MAX_HEADINGS): string[] {
  const headings: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    if (!/^#{1,6}\s+\S/u.test(line)) continue;
    headings.push(line.trim());
    if (headings.length >= max) break;
  }
  return headings;
}

export function previewWebFetchContent(text: string, lines = WEB_FETCH_PREVIEW_LINES): string {
  return text.split(/\r?\n/u).slice(0, lines).join('\n').trimEnd();
}

export function formatWebFetchBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1).replace(/\.0$/u, '')} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1).replace(/\.0$/u, '')} MB`;
}

export async function spillWebFetchContent(content: string, sourceUrl: string): Promise<string> {
  await cleanupExpiredWebFetchFiles();
  const directory = webFetchSpillDirectory();
  await mkdir(directory, { recursive: true });
  const fileName = `${Date.now()}-${randomBytes(4).toString('hex')}-${urlSlug(sourceUrl)}.md`;
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

export async function cleanupExpiredWebFetchFiles(now = Date.now(), ttlMs = WEB_FETCH_TTL_MS): Promise<number> {
  let entries;
  try {
    entries = await readdir(webFetchSpillDirectory(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const filePath = path.join(webFetchSpillDirectory(), entry.name);
    try {
      const info = await stat(filePath);
      if (now - info.mtimeMs <= ttlMs) return;
      await unlink(filePath);
      removed += 1;
    } catch {
      /* ignore files removed concurrently */
    }
  }));
  return removed;
}

function urlSlug(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/[^a-z0-9.-]+/giu, '');
    return (host || 'page').slice(0, 40);
  } catch {
    return 'page';
  }
}

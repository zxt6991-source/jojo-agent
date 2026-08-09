const MAX_PATCH_BYTES = 250_000;

function lines(text: string): string[] {
  if (!text) return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

export function createUnifiedDiff(
  relativePath: string,
  before: string | null,
  after: string | null
): { patch: string; additions: number; deletions: number; truncated?: boolean } {
  const oldLines = lines(before ?? '');
  const newLines = lines(after ?? '');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const contextBeforeStart = Math.max(0, prefix - 3);
  const contextAfterCount = Math.min(3, suffix);
  const contextBefore = oldLines.slice(contextBeforeStart, prefix);
  const contextAfter = oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + contextAfterCount);
  const oldCount = contextBefore.length + oldChanged.length + contextAfter.length;
  const newCount = contextBefore.length + newChanged.length + contextAfter.length;
  const oldStart = oldLines.length === 0 ? 0 : contextBeforeStart + 1;
  const newStart = newLines.length === 0 ? 0 : contextBeforeStart + 1;
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${relativePath}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${relativePath}`}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
  ];
  const body = [
    ...contextBefore.map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`)
  ];
  const full = [...header, ...body].join('\n');
  const encoded = Buffer.from(full);
  if (encoded.byteLength <= MAX_PATCH_BYTES) {
    return { patch: full, additions: newChanged.length, deletions: oldChanged.length };
  }
  return {
    patch: `${encoded.subarray(0, MAX_PATCH_BYTES).toString('utf8')}\n[diff truncated]`,
    additions: newChanged.length,
    deletions: oldChanged.length,
    truncated: true
  };
}

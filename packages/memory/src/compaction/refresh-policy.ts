import type { MemoryWarning } from '@desktop-agent/contracts';

export function evaluateSnapshotRefresh(
  snapshotVersions: Record<string, number>,
  currentVersions: Record<string, number>
): { refreshSnapshot: boolean; warnings: MemoryWarning[] } {
  const warnings: MemoryWarning[] = [];
  for (const [scopeId, version] of Object.entries(currentVersions)) {
    if (!Number.isInteger(version) || version < 0) {
      warnings.push({
        code: 'memory_scope_version_invalid',
        message: `Memory scope ${scopeId} returned an invalid version.`
      });
    }
  }
  const scopes = new Set([...Object.keys(snapshotVersions), ...Object.keys(currentVersions)]);
  return {
    refreshSnapshot: warnings.length === 0 && [...scopes].some((scopeId) =>
      snapshotVersions[scopeId] !== currentVersions[scopeId]
    ),
    warnings
  };
}

import type { ExecutionScope, JsonValue } from '@desktop-agent/contracts/runtime';

export const EXECUTION_SCOPE_METADATA = '__runtimeExecutionScope';
export const LEGACY_WORKING_DIRECTORY_METADATA = '__runtimeWorkingDirectory';

export function scopeFromMetadata(metadata: Record<string, JsonValue> | undefined): ExecutionScope {
  const value = metadata?.[EXECUTION_SCOPE_METADATA];
  if (value && typeof value === 'object' && !Array.isArray(value) && 'kind' in value) {
    if (value.kind === 'none') return { kind: 'none' };
    if (value.kind === 'workspace' && typeof value.workingDirectory === 'string') {
      return { kind: 'workspace', workingDirectory: value.workingDirectory };
    }
    if (value.kind === 'custom' && typeof value.type === 'string' && 'data' in value) {
      return { kind: 'custom', type: value.type, data: value.data as JsonValue };
    }
  }
  const workingDirectory = metadata?.[LEGACY_WORKING_DIRECTORY_METADATA];
  return typeof workingDirectory === 'string'
    ? { kind: 'workspace', workingDirectory }
    : { kind: 'none' };
}

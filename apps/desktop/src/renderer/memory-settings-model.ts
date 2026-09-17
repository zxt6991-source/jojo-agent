import type { MemoryKind, MemorySettings, MemoryStatusSnapshot, ProviderConfig } from '@desktop-agent/contracts';

export type MemoryTab = 'overview' | 'saved' | 'suggestions' | 'advanced';

export function memoryKindLabel(kind: MemoryKind): string {
  return { preference: '偏好', constraint: '约束', decision: '决策', fact: '事实', lesson: '经验', procedure: '流程', task: '事项', rule: '规则' }[kind];
}

export function isRemoteMemoryProvider(provider?: ProviderConfig): boolean {
  if (!provider) return false;
  try {
    return !['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(new URL(provider.baseUrl).hostname.toLowerCase());
  } catch {
    // Invalid endpoints must never be treated as implicitly trusted local services.
    return true;
  }
}

export function buildMemorySettingsViewModel(settings: MemorySettings, status: MemoryStatusSnapshot | null, error = '') {
  const dirty = status?.scopes.some((scope) => scope.dirty) ?? false;
  const warnings = status?.scopes.some((scope) => scope.warningCount > 0) ?? false;
  const semanticIssue = settings.semantic.enabled && Boolean(status?.semantic && (
    status.semantic.failed > 0 || status.semantic.stale > 0 || status.semantic.warning
  ));
  const health = error ? { level: 'error', message: '暂时无法完成 Memory 操作，请重试或查看详情。' }
    : !status ? { level: 'unknown', message: '尚未检查 Memory 状态' }
    : dirty || semanticIssue ? { level: 'warning', message: 'Memory 搜索需要修复' }
    : warnings ? { level: 'warning', message: '部分记忆内容需要检查' }
    : { level: 'healthy', message: 'Memory 工作正常' };
  return {
    enabled: settings.enabled,
    discovery: { enabled: settings.suggestions.enabled, pendingCount: status?.pendingCandidates?.length ?? 0 },
    scopes: {
      globalEnabled: settings.globalEnabled,
      globalCount: status?.scopes.find((scope) => scope.kind === 'global')?.entryCount ?? 0,
      projectAvailable: status?.projectAvailable ?? false,
      projectEnabled: settings.projectEnabled,
      projectCount: status?.scopes.filter((scope) => scope.kind === 'project').reduce((sum, scope) => sum + scope.entryCount, 0) ?? 0
    },
    health
  };
}

import React from 'react';
import type { MemorySettings, MemoryStatusSnapshot, ModelSelection } from '@desktop-agent/contracts';
import { SettingSwitch } from './MemorySettingSwitch';
import { buildMemorySettingsViewModel, type MemoryTab } from './memory-settings-model';

export function MemoryOverview({ draft, status, error, busy, projectAvailable, utilityModel, onChange, onNavigate, onDiagnostics, onRefresh }: {
  draft: MemorySettings;
  status: MemoryStatusSnapshot | null;
  error: string;
  busy: boolean;
  projectAvailable: boolean;
  utilityModel?: ModelSelection | undefined;
  onChange: (settings: MemorySettings) => void;
  onNavigate: (tab: MemoryTab) => void;
  onDiagnostics: () => void;
  onRefresh: () => void;
}) {
  const view = buildMemorySettingsViewModel(draft, status, error);
  const update = (value: Partial<MemorySettings>) => onChange({ ...draft, ...value });
  return <>
    <section className="settings-section-card">
      <SettingSwitch id="memory-enabled-label" title="启用 Memory" description="让 Jojo 跨对话记住重要信息。关闭后停止使用记忆，已保存的内容仍会保留。" checked={draft.enabled} onChange={(enabled) => update({ enabled })} />
    </section>
    <section className="settings-section-card">
      <SettingSwitch id="memory-suggestions-label" title="从对话中发现记忆建议" description="Jojo 会发现可能值得长期保留的信息，但不会自动保存，保存前始终需要你的确认。" checked={draft.suggestions.enabled} disabled={!draft.enabled} onChange={(enabled) => update({ suggestions: { ...draft.suggestions, enabled, ...(enabled && !draft.suggestions.providerId && utilityModel ? utilityModel : {}) } })} />
      {draft.suggestions.enabled && !(draft.suggestions.providerId && draft.suggestions.model) && <p className="memory-status-hint">请在高级设置中选择建议生成模型。</p>}
      <div className="memory-overview-link"><span>待确认 {view.discovery.pendingCount} 条</span><button type="button" onClick={() => onNavigate('suggestions')}>查看并处理 →</button></div>
    </section>
    <section className="settings-section-card">
      <div className="settings-section-title"><h2>Memory 使用范围</h2></div>
      <div className="memory-scope-grid">
        <SettingSwitch id="memory-global-label" title="所有项目" description="在所有项目中使用你的语言、工具和协作偏好。" checked={draft.globalEnabled} disabled={!draft.enabled} onChange={(globalEnabled) => update({ globalEnabled })} />
        <SettingSwitch id="memory-project-label" title="当前项目" description={projectAvailable ? '记住当前项目的约束、设计决策、经验和未完成事项。' : '当前没有项目。选择一个项目后，可以单独保存该项目的约束、决策和经验。'} checked={draft.projectEnabled} disabled={!draft.enabled || !projectAvailable} onChange={(projectEnabled) => update({ projectEnabled })} />
      </div>
    </section>
    <section className="settings-section-card">
      <div className="settings-section-title"><h2>已保存的 Memory</h2></div>
      <div className="memory-overview-counts"><span>所有项目 <strong>{status ? `${view.scopes.globalCount} 条` : '尚未读取'}</strong></span><span>当前项目 <strong>{!projectAvailable ? '未选择项目' : status ? `${view.scopes.projectCount} 条` : '尚未读取'}</strong></span></div>
      <div className="memory-overview-link"><span>随时查看和删除已保存的内容。</span><button type="button" onClick={() => onNavigate('saved')}>管理 Memory →</button></div>
    </section>
    <div className={`memory-health ${view.health.level}`} role="status"><span>{view.health.message}</span><div>{!status && <button type="button" disabled={busy} onClick={onRefresh}>检查状态</button>}<button type="button" onClick={onDiagnostics}>{view.health.level === 'warning' ? '检查与修复' : '查看详情'}</button></div></div>
  </>;
}

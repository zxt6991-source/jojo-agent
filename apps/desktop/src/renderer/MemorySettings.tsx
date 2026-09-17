import React, { useState } from 'react';
import type { MemoryCandidateReviewEdit, MemorySettings, MemoryStatusSnapshot, ModelSelection, ProviderConfig } from '@desktop-agent/contracts';
import { MemoryOverview } from './MemoryOverview';
import { MemorySavedList } from './MemorySavedList';
import { MemorySuggestions } from './MemorySuggestions';
import { MemoryAdvancedSettings } from './MemoryAdvancedSettings';
import { MemoryDiagnostics } from './MemoryDiagnostics';
import type { MemoryTab } from './memory-settings-model';
export { MemoryScopeConfigDialog } from './MemorySavedList';

export function MemorySettingsPage({
  draft,
  saved,
  status,
  error,
  busy,
  workingDirectory,
  onChange,
  onSave,
  onRefresh,
  onRebuild,
  onDelete,
  onRebuildSemantic = () => undefined,
  providers = [],
  utilityModel,
  onAcceptCandidate = async () => undefined,
  onRejectCandidate = async () => undefined
}: {
  draft: MemorySettings;
  saved: MemorySettings;
  status: MemoryStatusSnapshot | null;
  error: string;
  busy: boolean;
  workingDirectory?: string;
  onChange: (settings: MemorySettings) => void;
  onSave: () => Promise<void>;
  onRefresh: () => void;
  onRebuild: (scope: 'global' | 'project') => void;
  onDelete: (scope: 'global' | 'project', entryId: string) => Promise<boolean>;
  onRebuildSemantic?: () => void;
  providers?: ProviderConfig[];
  utilityModel?: ModelSelection;
  onAcceptCandidate?: (id: string, edit?: MemoryCandidateReviewEdit) => Promise<void>;
  onRejectCandidate?: (id: string) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<MemoryTab>('overview');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(saved);
  const projectAvailable = Boolean(workingDirectory) && (status?.projectAvailable ?? true);
  const pendingCount = status?.pendingCandidates?.length ?? 0;
  const tabs: { id: MemoryTab; label: string }[] = [
    { id: 'overview', label: '概览' }, { id: 'saved', label: '已保存' },
    { id: 'suggestions', label: `待确认 ${pendingCount}` }, { id: 'advanced', label: '高级设置' }
  ];
  return <form className="settings-content model-settings-page memory-settings-page" aria-labelledby="memory-settings-title" onSubmit={(event) => {
    event.preventDefault();
    if (!busy && hasUnsavedChanges) void onSave();
  }}>
    <div className="settings-heading"><div><h1 id="memory-settings-title">Memory</h1><p>让 Jojo 在不同对话之间记住你的偏好、项目约束和重要决策。</p></div><span className={`browser-status-pill ${saved.enabled ? 'on' : ''}`}>{saved.enabled ? '已开启' : '已关闭'}</span></div>
    <div className="memory-tabs" role="tablist" aria-label="Memory 页面">
      {tabs.map((tab, index) => <button type="button" role="tab" key={tab.id} id={`memory-tab-${tab.id}`} aria-selected={activeTab === tab.id} aria-controls={`memory-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setActiveTab(tab.id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault();
        const nextTab = tabs[next];
        if (!nextTab) return;
        setActiveTab(nextTab.id);
        document.getElementById(`memory-tab-${nextTab.id}`)?.focus();
      }}>{tab.label}</button>)}
    </div>
    {error && <div className="settings-error memory-settings-error" role="alert">{error}</div>}
    <div className="memory-tab-panel" role="tabpanel" id={`memory-panel-${activeTab}`} aria-labelledby={`memory-tab-${activeTab}`}>
      {activeTab === 'overview' && <MemoryOverview draft={draft} status={status} error={error} busy={busy} projectAvailable={projectAvailable} utilityModel={utilityModel} onChange={onChange} onNavigate={setActiveTab} onRefresh={onRefresh} onDiagnostics={() => { setDiagnosticsOpen(true); setActiveTab('advanced'); }} />}
      {activeTab === 'saved' && <MemorySavedList status={status} busy={busy} projectAvailable={projectAvailable} onDelete={onDelete} onRefresh={onRefresh} />}
      {activeTab === 'suggestions' && <MemorySuggestions candidates={status?.pendingCandidates ?? []} busy={busy} projectAvailable={projectAvailable} onAccept={onAcceptCandidate} onReject={onRejectCandidate} />}
      {activeTab === 'advanced' && <>
        <MemoryAdvancedSettings draft={draft} onChange={onChange} providers={providers} utilityModel={utilityModel} />
        <section className="settings-section-card memory-diagnostics-disclosure"><button type="button" aria-expanded={diagnosticsOpen} aria-controls="memory-diagnostics" onClick={() => setDiagnosticsOpen((open) => !open)}>{diagnosticsOpen ? '收起诊断信息' : '诊断与索引修复'}</button>
          {diagnosticsOpen && <div id="memory-diagnostics"><MemoryDiagnostics draft={saved} status={status} busy={busy} workingDirectory={workingDirectory} providers={providers} onRefresh={onRefresh} onRebuild={onRebuild} onRebuildSemantic={onRebuildSemantic} /></div>}
        </section>
      </>}
    </div>
    <div className="settings-actions memory-save-actions"><span>{hasUnsavedChanges ? '有尚未保存的修改。' : '所有设置已保存。'}</span><div><button type="button" disabled={busy || !hasUnsavedChanges} onClick={() => onChange(saved)}>放弃修改</button><button className="primary" type="submit" disabled={busy || !hasUnsavedChanges}>{busy ? '处理中…' : '保存 Memory 设置'}</button></div></div>
  </form>;
}

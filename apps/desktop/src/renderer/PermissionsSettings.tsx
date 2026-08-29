import React, { useEffect, useState } from 'react';
import {
  PermissionPolicyDocumentSchema,
  type PermissionGovernanceSnapshot,
  type PermissionPolicyDocumentContract
} from '@desktop-agent/contracts';

export function parsePermissionPolicyEditor(value: string): PermissionPolicyDocumentContract {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (cause) {
    throw new Error(`Policy JSON 无效：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return PermissionPolicyDocumentSchema.parse(parsed);
}

function decisionTime(value: string): string {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)); }
  catch { return value; }
}

export function PermissionsSettingsPage({
  snapshot,
  workingDirectory,
  busy,
  error,
  onRefresh,
  onSave
}: {
  snapshot: PermissionGovernanceSnapshot | null;
  workingDirectory?: string;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onSave: (input: {
    scope: 'global' | 'workspace';
    workingDirectory?: string;
    mode: 'ask' | 'auto' | 'yolo';
    document: PermissionPolicyDocumentContract;
  }) => Promise<void>;
}) {
  const [scope, setScope] = useState<'global' | 'workspace'>('global');
  const [mode, setMode] = useState<'ask' | 'auto' | 'yolo'>('ask');
  const [documentJson, setDocumentJson] = useState('{\n  "version": 1,\n  "rules": []\n}');
  const [editorError, setEditorError] = useState('');
  const profile = scope === 'workspace' ? snapshot?.workspace : snapshot?.global;
  const effectiveProfile = profile ?? snapshot?.global;

  useEffect(() => {
    if (!effectiveProfile) return;
    setMode(effectiveProfile.mode);
    setDocumentJson(JSON.stringify(profile?.document ?? { version: 1, rules: [] }, null, 2));
    setEditorError('');
  }, [effectiveProfile, profile]);

  const save = async () => {
    setEditorError('');
    try {
      const document = parsePermissionPolicyEditor(documentJson);
      await onSave({
        scope,
        ...(scope === 'workspace' && workingDirectory ? { workingDirectory } : {}),
        mode,
        document
      });
    } catch (cause) {
      setEditorError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div className="settings-content model-settings-page permission-settings-page" aria-labelledby="permission-settings-title">
    <div className="settings-heading">
      <div>
        <h1 id="permission-settings-title">权限</h1>
        <p>管理确定性权限规则并审查最近决策。安全边界和 Mandatory Approval 不受用户规则与模式影响。</p>
      </div>
      <button type="button" disabled={busy} onClick={onRefresh}>{busy ? '刷新中…' : '刷新'}</button>
    </div>

    <section className="settings-section-card permission-policy-card">
      <div className="settings-section-title with-meta">
        <div><h2>Policy Profile</h2><p>Global 对所有项目生效；Workspace 规则仅来自本机数据，并优先于 Global 的 ALLOW/ASK。</p></div>
        <span className={`browser-status-pill permission-mode-pill ${effectiveProfile?.mode ?? 'ask'}`}>{(effectiveProfile?.mode ?? 'ask').toUpperCase()}</span>
      </div>
      <div className="permission-scope-tabs" role="tablist" aria-label="Policy Scope">
        <button type="button" role="tab" aria-selected={scope === 'global'} className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>Global</button>
        <button type="button" role="tab" aria-selected={scope === 'workspace'} className={scope === 'workspace' ? 'active' : ''} disabled={!workingDirectory} onClick={() => setScope('workspace')}>Workspace</button>
        <span>{scope === 'global' ? `revision ${snapshot?.global.revision ?? 0}` : profile ? `revision ${profile.revision}` : '继承 Global'}</span>
      </div>
      {scope === 'workspace' && workingDirectory && <code className="permission-workspace-path" title={workingDirectory}>{workingDirectory}</code>}
      <div className="browser-mode-grid permission-mode-grid" role="radiogroup" aria-label="权限模式">
        {([
          ['ask', 'ASK', '所有普通敏感操作请求确认。'],
          ['auto', 'AUTO', '自动执行确定性的低风险操作。'],
          ['yolo', 'YOLO', '取消普通审批，保留强制审批与拒绝。']
        ] as const).map(([value, title, description]) => <label key={value} className={`browser-mode-option ${mode === value ? 'selected' : ''}`}>
          <input type="radio" name="permission-mode" checked={mode === value} onChange={() => setMode(value)} />
          <span className="browser-mode-copy"><strong>{title}</strong><span>{description}</span></span>
        </label>)}
      </div>
      {mode === 'yolo' && <p className="permission-mode-warning">YOLO 不等于关闭安全：底层 Gate 的 DENY 与 Mandatory Approval 仍不可绕过。</p>}
      <div className="permission-rule-editor">
        <label htmlFor="permission-policy-json">Rules JSON</label>
        <textarea id="permission-policy-json" value={documentJson} spellCheck={false} onChange={(event) => { setDocumentJson(event.target.value); setEditorError(''); }} />
        <p>支持 actors、triggers、sources、tools、operations、risks、network、hasSecrets 和 resourceScope；不支持表达式或正则。</p>
      </div>
      {(editorError || error) && <div className="settings-error permission-settings-error" role="alert">{editorError || error}</div>}
      <div className="settings-actions"><button className="primary" type="button" disabled={busy || (scope === 'workspace' && !workingDirectory)} onClick={() => void save()}>{busy ? '保存中…' : '保存 Policy'}</button></div>
    </section>

    <section className="settings-section-card permission-audit-card">
      <div className="settings-section-title with-meta">
        <div><h2>Recent Decisions</h2><p>{workingDirectory ? '显示当前会话最近的权限判断。' : '显示最近的权限判断。'}审计只保存安全摘要和密钥变量名。</p></div>
        <span className="permission-audit-count">{snapshot?.recentDecisions.length ?? 0}</span>
      </div>
      <div className="permission-audit-list">
        {snapshot?.recentDecisions.map((item) => <article key={item.id}>
          <span className={`permission-effect ${item.effect}`}>{item.effect.toUpperCase()}</span>
          <div className="permission-audit-main">
            <strong>{item.toolName}</strong>
            <span>{item.reasonCode}</span>
            <small>{item.source} · {item.actorKind} / {item.triggerKind}{item.locked ? ' · locked' : ''}</small>
          </div>
          <div className="permission-audit-meta"><span className={`risk-${item.risk}`}>{item.risk}</span><time dateTime={item.createdAt}>{decisionTime(item.createdAt)}</time></div>
        </article>)}
        {snapshot && snapshot.recentDecisions.length === 0 && <p className="permission-audit-empty">尚无权限决策记录。</p>}
        {!snapshot && <p className="permission-audit-empty">正在加载权限治理数据…</p>}
      </div>
    </section>
  </div>;
}

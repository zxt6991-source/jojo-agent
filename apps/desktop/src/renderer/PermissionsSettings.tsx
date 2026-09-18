import React, { useEffect, useState } from 'react';
import {
  PermissionPolicyDocumentSchema, projectNameFromDirectory,
  type PermissionGovernanceSnapshot, type PermissionPolicyDocumentContract, type PermissionRuleContract
} from '@desktop-agent/contracts';
import { permissionModes, effectLabels } from './permissions/permission-copy';
import { presentRule } from './permissions/permission-rule-presenter';
import { ruleWarning } from './permissions/permission-rule-builder';
import { PermissionRuleEditor } from './permissions/PermissionRuleEditor';
import { PermissionBehaviorPreview, PermissionSystemGuards } from './permissions/PermissionBehaviorPreview';
import { PermissionActivity } from './permissions/PermissionActivity';

export function parsePermissionPolicyEditor(value: string): PermissionPolicyDocumentContract {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch (cause) { throw new Error(`Policy JSON 无效：${cause instanceof Error ? cause.message : String(cause)}`); }
  return PermissionPolicyDocumentSchema.parse(parsed);
}
const emptyDocument: PermissionPolicyDocumentContract = { version: 1, rules: [] };
export function PermissionsSettingsPage({ snapshot, workingDirectory, sessionScoped = false, busy, error, onRefresh, onSave, onReset, onDirtyChange }: {
  snapshot: PermissionGovernanceSnapshot | null;
  workingDirectory?: string;
  sessionScoped?: boolean;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onSave: (input: { scope: 'global' | 'workspace'; workingDirectory?: string; mode: 'ask' | 'auto' | 'yolo'; document: PermissionPolicyDocumentContract }) => Promise<void>;
  onReset: (workingDirectory: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [tab, setTab] = useState<'policy' | 'activity'>('policy');
  const [scope, setScope] = useState<'global' | 'workspace'>('global');
  const profile = scope === 'workspace' ? snapshot?.workspace : snapshot?.global;
  const effectiveProfile = profile ?? snapshot?.global;
  const [mode, setMode] = useState<'ask' | 'auto' | 'yolo'>(snapshot?.global.mode ?? 'ask');
  const [documentJson, setDocumentJson] = useState(JSON.stringify(snapshot?.global.document ?? emptyDocument, null, 2));
  const [override, setOverride] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingRule, setEditingRule] = useState<number | 'new' | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const inherited = scope === 'workspace' && !profile && !override;
  const savedJson = JSON.stringify(profile?.document ?? emptyDocument, null, 2);
  const dirty = override || mode !== (effectiveProfile?.mode ?? 'ask') || documentJson !== savedJson;
  const hasDraft = dirty || editingRule !== null;
  let document: PermissionPolicyDocumentContract | undefined;
  let jsonError = '';
  try { document = parsePermissionPolicyEditor(documentJson); }
  catch (cause) { jsonError = cause instanceof Error ? cause.message : String(cause); }

  useEffect(() => {
    setMode(effectiveProfile?.mode ?? 'ask'); setDocumentJson(savedJson);
    setOverride(false); setEditorError(''); setEditingRule(null);
  }, [scope, workingDirectory, effectiveProfile?.mode, profile?.revision, savedJson]);
  useEffect(() => { onDirtyChange?.(hasDraft); }, [hasDraft, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft]);
  const mayDiscard = () => !hasDraft || window.confirm('有未保存的权限更改，确定放弃吗？');
  const updateRules = (rules: PermissionRuleContract[]) => {
    setDocumentJson(JSON.stringify({ version: 1, rules }, null, 2)); setNotice('');
  };
  const save = async () => {
    setEditorError(''); setNotice('');
    try {
      const parsed = parsePermissionPolicyEditor(documentJson);
      await onSave({ scope, ...(workingDirectory ? { workingDirectory } : {}), mode, document: parsed });
      setOverride(false); setNotice('权限设置已保存。');
    } catch (cause) { setEditorError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const reset = async () => {
    if (!workingDirectory || !window.confirm('恢复继承将删除当前项目的独立确认策略和例外规则，立即使用所有项目设置。确定继续吗？')) return;
    try { setEditorError(''); await onReset(workingDirectory); setOverride(false); setNotice('已恢复继承所有项目设置。'); }
    catch (cause) { setEditorError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="settings-content model-settings-page permission-settings-page" aria-labelledby="permission-settings-title">
    <div className="settings-heading"><div><h1 id="permission-settings-title">权限</h1><p>控制 Jojo 什么时候需要先询问你。系统安全边界始终有效。</p></div>
      <button type="button" disabled={busy} onClick={() => { if (mayDiscard()) { setMode(effectiveProfile?.mode ?? 'ask'); setDocumentJson(savedJson); setOverride(false); setEditingRule(null); onRefresh(); } }}>刷新</button></div>
    <div className="permission-page-tabs" role="tablist" aria-label="权限设置分区">
      <button id="permission-policy-tab" type="button" role="tab" aria-selected={tab === 'policy'} aria-controls="permission-policy-panel" onClick={() => setTab('policy')}>权限策略</button>
      <button id="permission-activity-tab" type="button" role="tab" aria-selected={tab === 'activity'} aria-controls="permission-activity-panel" onClick={() => setTab('activity')}>活动记录</button>
    </div>
    {(editorError || error) && <div className="settings-error" role="alert">{editorError || error}</div>}
    {notice && <p role="status">{notice}</p>}
    {!snapshot ? <p role="status">正在加载权限设置…</p> : <><div hidden={tab !== 'activity'} id="permission-activity-panel" role="tabpanel" aria-labelledby="permission-activity-tab"><PermissionActivity items={snapshot.recentDecisions} sessionScoped={sessionScoped} /></div>
      <div hidden={tab !== 'policy'} id="permission-policy-panel" role="tabpanel" aria-labelledby="permission-policy-tab">
        <section className="settings-section-card permission-policy-card">
          <div className="settings-section-title"><h2>应用范围</h2><p>所有项目的阻止规则始终生效；其他规则优先使用当前项目的匹配结果。</p></div>
          <div className="permission-scope-tabs" role="group" aria-label="应用范围">{(['global', 'workspace'] as const).map((value) => <button key={value} type="button" aria-pressed={scope === value} className={scope === value ? 'active' : ''} disabled={busy || (value === 'workspace' && !workingDirectory)} title={value === 'workspace' ? workingDirectory ?? '先选择一个项目会话' : undefined} onClick={() => { if (value !== scope && mayDiscard()) { setScope(value); setNotice(''); } }}>{value === 'global' ? '所有项目' : `当前项目${workingDirectory ? `：${projectNameFromDirectory(workingDirectory)}` : ''}`}</button>)}</div>
          {scope === 'workspace' && <div className="permission-inheritance"><p>{inherited ? '正在继承“所有项目”的确认策略和例外规则。' : override ? '正在编辑当前项目的独立设置，保存后生效。' : '当前项目已单独设置；所有项目的例外规则仍参与判断。'}</p>
            {inherited ? <button type="button" disabled={busy} onClick={() => setOverride(true)}>为此项目单独设置</button> : profile ? <button type="button" disabled={busy} onClick={() => void reset()}>恢复继承所有项目设置</button> : <button type="button" disabled={busy} onClick={() => { if (mayDiscard()) { setOverride(false); setMode(snapshot.global.mode); setDocumentJson(savedJson); setEditingRule(null); } }}>取消单独设置</button>}
          </div>}
          <fieldset className="permission-editable" disabled={busy || inherited}>
            <legend>确认策略</legend>
            <div className="browser-mode-grid permission-mode-grid" role="radiogroup" aria-label="确认策略">{(Object.entries(permissionModes) as [keyof typeof permissionModes, typeof permissionModes[keyof typeof permissionModes]][]).map(([value, copy]) => <label key={value} className={`browser-mode-option ${mode === value ? 'selected' : ''}`}><input type="radio" name="permission-mode" checked={mode === value} onChange={() => { setMode(value); setNotice(''); }}/><span className="browser-mode-copy"><strong>{copy.title}</strong><span>{copy.description}</span></span></label>)}</div>
          </fieldset>
          {mode === 'yolo' && <p className="permission-mode-warning">尽量自动会通过普通审批，系统保护和阻止规则仍然有效。</p>}
          <PermissionBehaviorPreview mode={mode}/>
          <section className="permission-block"><h3>例外规则</h3><p>同一范围按顺序匹配，先匹配的自动执行或询问规则生效。任何匹配的阻止规则都优先。</p>
            {scope === 'workspace' && <details><summary>所有项目的规则（{snapshot.global.document.rules.length} 条，仍然生效）</summary>{snapshot.global.document.rules.map((rule, index) => <p key={`${index}-${rule.id}`}>{presentRule(rule)} → {effectLabels[rule.effect]}</p>)}{!snapshot.global.document.rules.length && <p>所有项目尚未设置例外规则。</p>}</details>}
            {!inherited && <fieldset className="permission-editable" disabled={busy || editingRule !== null || !document}>
              {!document && <p role="alert">高级 JSON 尚未通过校验，请先修正后再编辑可视化规则。</p>}
              {document?.rules.map((rule, index) => {
                const warning = ruleWarning(rule, index, document!.rules, scope === 'workspace' ? snapshot.global.document.rules : []);
                return <article className="permission-rule-card" key={`${index}-${rule.id}`}><div><strong>{presentRule(rule)}</strong><span className={`permission-effect ${rule.effect}`}>{effectLabels[rule.effect]}</span></div>
                  {warning && <p className="permission-rule-warning">{warning}</p>}
                  <div className="permission-row-actions"><button type="button" onClick={() => setEditingRule(index)}>编辑规则 {index + 1}</button><button type="button" aria-label={`上移规则 ${index + 1}`} disabled={index === 0} onClick={() => { const rules = [...document!.rules]; [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!]; updateRules(rules); }}>上移</button><button type="button" aria-label={`下移规则 ${index + 1}`} disabled={index === document!.rules.length - 1} onClick={() => { const rules = [...document!.rules]; [rules[index + 1], rules[index]] = [rules[index]!, rules[index + 1]!]; updateRules(rules); }}>下移</button><button type="button" aria-label={`删除规则 ${index + 1}`} onClick={() => updateRules(document!.rules.filter((_, at) => at !== index))}>删除</button></div>
                </article>;
              })}
              {document?.rules.length === 0 && <p>此范围尚无例外规则。</p>}
              <button type="button" onClick={() => setEditingRule('new')}>添加例外规则</button>
            </fieldset>}
            {editingRule !== null && document && <fieldset className="permission-editable" disabled={busy}><PermissionRuleEditor {...(typeof editingRule === 'number' ? { rule: document.rules[editingRule]! } : {})} onCancel={() => setEditingRule(null)} onApply={(rule) => { updateRules(editingRule === 'new' ? [...document!.rules, rule] : document!.rules.map((item, index) => index === editingRule ? rule : item)); setEditingRule(null); }}/></fieldset>}
          </section>
          <PermissionSystemGuards/>
          <details className="permission-block permission-advanced" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}><summary>高级设置</summary>
            <p>策略版本 v1 · 修订 {profile?.revision ?? 0} · 技术模式 {mode.toUpperCase()}{profile?.updatedAt ? ` · 更新于 ${profile.updatedAt}` : ''}</p>
            {workingDirectory && <p>项目路径：{workingDirectory}</p>}
            {snapshot.effective && <p>当前已保存的项目生效策略：{permissionModes[snapshot.effective.mode].title}，来自{snapshot.effective.modeSource === 'global' ? '所有项目' : '当前项目'}；全局规则 {snapshot.effective.globalRuleCount} 条，项目规则 {snapshot.effective.workspaceRuleCount} 条。</p>}
            <div className="permission-rule-editor"><label htmlFor="permission-policy-json">策略 JSON</label><textarea id="permission-policy-json" value={inherited ? JSON.stringify(snapshot.global.document, null, 2) : documentJson} readOnly={inherited} disabled={busy || editingRule !== null} spellCheck={false} onChange={(event) => { setDocumentJson(event.target.value); setEditorError(''); setNotice(''); }}/><p>{inherited ? '当前显示继承的所有项目规则，只读。' : '与可视化规则共用同一份策略。复杂规则的全部条件会完整保留。'}</p>{jsonError && <p role="alert">{jsonError}</p>}</div>
          </details>
          {!inherited && <div className="settings-actions permission-save-row"><span role="status">{hasDraft ? '你有未保存的更改' : '所有更改已保存'}{editingRule !== null ? '；请先应用或取消规则草稿' : ''}</span><button className="primary" type="button" disabled={busy || !dirty || !document || editingRule !== null} onClick={() => void save()}>保存更改</button></div>}
        </section>
      </div></>}
  </div>;
}

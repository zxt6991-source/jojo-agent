import React, { useState } from 'react';
import type { BrowserRecordingRegistryItem, BrowserRecordingStudioDetail } from '@desktop-agent/contracts';
import { BrowserRecordingSteps } from './BrowserRecordingSteps';
import { BrowserRecordingDeveloperTools } from '../developer/BrowserRecordingDeveloperTools';
import { recordingAction, recordingRunState, recordingScope, recordingScopeHelp } from './recording-presentation';

export function BrowserRecordingDetail({ studio, item, busy, studioJson, setStudioJson, onSave, onBack, onRefresh, onDuplicate, onTrust, onRevoke, onDelete, canManage }: {
  studio: BrowserRecordingStudioDetail;
  item: BrowserRecordingRegistryItem | undefined;
  busy: boolean;
  studioJson: string;
  setStudioJson: (value: string) => void;
  onSave: () => Promise<void>;
  onBack: () => void;
  onRefresh: () => void;
  onDuplicate: () => void;
  onTrust: () => void;
  onRevoke: () => void;
  onDelete: () => void;
  canManage: boolean;
}) {
  const [tab, setTab] = useState<'overview' | 'steps' | 'runs'>('overview');
  const [developer, setDeveloper] = useState(false);
  const [technical, setTechnical] = useState(false);
  const document = studio.document;
  const trust = item?.trust ?? studio.trust;
  const latest = studio.replay.at(-1);
  // The registry is authoritative after trust/revoke; never keep an old editable view.
  const currentStudio = { ...studio, editable: studio.editable && (studio.source !== 'project' || trust === 'trusted') };
  return <>
    <div className="settings-heading"><div><button type="button" className="secondary" disabled={busy} onClick={onBack}>返回录制任务</button><h1>{document.name}</h1><p>{document.description || '把重复网页操作保存下来，之后可以再次运行。'}</p></div><button type="button" className="secondary" disabled={busy} onClick={onRefresh}>刷新详情</button></div>
    <section className="browser-studio" aria-label="录制任务详情">
      <nav aria-label="录制任务栏目">{([['overview', '概览'], ['steps', '步骤'], ['runs', '运行记录']] as const).map(([id, label]) => <button type="button" key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {tab === 'overview' && <div className="browser-detail-overview">
        <p title={recordingScopeHelp[studio.source]}>来源：{recordingScope[studio.source]}</p><p>网站：{document.domains.join('、') || '未指定'}</p><p>{document.steps.length} 个步骤 · {item?.highRisk ? '包含敏感操作，运行时仍需按权限规则确认。' : '运行时仍遵循浏览器权限规则。'}</p>
        <p>操作类型：{[...new Set(document.steps.map((step) => recordingAction(step.action)))].join('、') || '无'}</p>
        <p>参数：{document.params.map((param) => `${param.description || param.name}${param.secret ? '（敏感参数）' : ''}${param.required ? '（必填）' : ''}`).join('、') || '无'}</p><p>输出：{document.outputs.map((output) => output.description || output.name).join('、') || '无'}</p>
        <p>最近运行：{latest ? `${recordingRunState(latest.state)} · ${new Date(latest.timestamp).toLocaleString()}` : '暂无运行记录'}</p>
        {studio.source === 'project' && <div className="browser-trust-summary"><strong>此自动化来自当前项目</strong><p>{trust === 'trusted' ? '此版本已信任。内容变化后需要重新确认。' : '此版本尚未信任，或自上次信任后发生了变化。请先查看步骤，再信任此版本。'}</p><button type="button" onClick={() => setTab('steps')}>查看步骤</button> <button type="button" disabled={busy || !canManage} onClick={trust === 'trusted' ? onRevoke : onTrust}>{trust === 'trusted' ? '撤销信任' : '信任并允许使用'}</button></div>}
      </div>}
      {tab === 'steps' && <BrowserRecordingSteps steps={document.steps} />}
      {tab === 'runs' && <div className="browser-detail-overview">{studio.replay.length ? studio.replay.map((entry, index) => <p key={`${entry.runId}-${index}`}><time>{new Date(entry.timestamp).toLocaleString()}</time> · {recordingAction(entry.action)} · {recordingRunState(entry.state)}</p>) : <p>暂无运行记录。</p>}</div>}
    </section>
    <details className="browser-recording-more"><summary>更多操作</summary><div className="browser-recording-actions"><button type="button" disabled={busy} onClick={onDuplicate}>复制</button>{studio.source !== 'builtin' && <button type="button" className="danger" disabled={busy || !canManage} onClick={onDelete}>删除</button>}<button type="button" aria-expanded={technical} onClick={() => setTechnical(!technical)}>技术信息</button><button type="button" aria-expanded={developer} onClick={() => setDeveloper(!developer)}>开发者工具</button></div></details>
    {technical && <section className="settings-section-card browser-detail-overview"><h2>技术信息</h2><p>标识：{document.id}</p><p>版本：{document.revision}</p><p>内容哈希：{document.contentHash}</p><p>覆盖来源：{item?.overriddenSources.map((source) => recordingScope[source]).join('、') || '无'}</p></section>}
    {developer && <BrowserRecordingDeveloperTools studio={currentStudio} studioJson={studioJson} setStudioJson={setStudioJson} studioBusy={busy} saveStudio={onSave} />}
  </>;
}

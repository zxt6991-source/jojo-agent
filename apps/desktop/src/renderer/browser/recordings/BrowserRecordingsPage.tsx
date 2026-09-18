import React, { useState } from 'react';
import type { BrowserRecordingRegistrySnapshot, BrowserRecordingStudioDetail } from '@desktop-agent/contracts';
import { BrowserRecordingDetail } from './BrowserRecordingDetail';
import { recordingScope, recordingScopeHelp } from './recording-presentation';

export function BrowserRecordingsPage({ recordings, recordingsBusy, workingDirectory, error, onBack, onRefreshRecordings, onTrustRecording, onRevokeRecording, onDeleteRecording }: {
  recordings: BrowserRecordingRegistrySnapshot | null;
  recordingsBusy: boolean;
  workingDirectory?: string;
  error: string;
  onBack: () => void;
  onRefreshRecordings: () => void;
  onTrustRecording: (id: string) => Promise<void>;
  onRevokeRecording: (id: string) => Promise<void>;
  onDeleteRecording: (id: string) => Promise<boolean>;
}) {
  const [studio, setStudio] = useState<BrowserRecordingStudioDetail | null>(null);
  const [studioJson, setStudioJson] = useState('');
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioError, setStudioError] = useState('');
  const [duplicateName, setDuplicateName] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pathsOpen, setPathsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const canLeave = () => !studio || studioJson === JSON.stringify(studio.document, null, 2) || window.confirm('录制任务有尚未保存的修改，确定放弃吗？');
  const studioInput = (recordingId: string) => ({ recordingId, ...(workingDirectory ? { workingDirectory } : {}) });
  const openStudio = async (recordingId: string) => {
    setStudioBusy(true); setStudioError('');
    try {
      const detail = await window.desktopAgent.getBrowserRecordingStudio(studioInput(recordingId));
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));

    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };

  const saveStudio = async () => {
    if (!studio) return;
    setStudioBusy(true); setStudioError('');
    try {
      const document = JSON.parse(studioJson) as BrowserRecordingStudioDetail['document'];
      const detail = await window.desktopAgent.saveBrowserRecording({
        ...studioInput(studio.document.id),
        expectedRevision: studio.document.revision,
        expectedHash: studio.document.contentHash,
        document
      });
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));
      onRefreshRecordings();
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };

  const duplicateStudio = async (recordingId: string) => {
    const name = duplicateName ?? '';
    setDuplicateName(null);
    setStudioBusy(true); setStudioError('');
    try {
      const detail = await window.desktopAgent.duplicateBrowserRecording({ ...studioInput(recordingId), ...(name.trim() ? { name: name.trim() } : {}) });
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));

      onRefreshRecordings();
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };


  const busy = recordingsBusy || studioBusy;
  return <section className="settings-content model-settings-page browser-recordings-page" aria-label="浏览器自动化">
    {error && <div className="settings-error" role="alert">{error}</div>}
    {studioError && <div className="settings-error" role="alert">{studioError}</div>}
    {duplicateName !== null && studio && <section className="settings-section-card browser-detail-overview" aria-label="复制录制任务"><label>新录制任务名称<input aria-label="新录制任务名称" maxLength={120} value={duplicateName} onChange={(event) => setDuplicateName(event.target.value)} /></label><div className="settings-actions"><button type="button" className="secondary" onClick={() => setDuplicateName(null)}>取消复制</button><button type="button" className="primary" disabled={busy || !duplicateName.trim()} onClick={() => { void duplicateStudio(studio.document.id); }}>确认复制</button></div></section>}
    {studio ? <BrowserRecordingDetail key={studio.document.id} studio={studio} item={recordings?.recordings.find((item) => item.id === studio.document.id)} busy={busy} studioJson={studioJson} setStudioJson={setStudioJson} onSave={saveStudio}
      onBack={() => { if (canLeave()) { setStudio(null); setDuplicateName(null); setStudioError(''); } }}
      onRefresh={() => { if (canLeave()) void openStudio(studio.document.id); }}
      onDuplicate={() => { if (canLeave()) setDuplicateName(`${studio.document.name} 副本`); }}
      onTrust={() => { void onTrustRecording(studio.document.id).then(() => openStudio(studio.document.id)); }}
      onRevoke={() => { if (canLeave()) void onRevokeRecording(studio.document.id).then(() => openStudio(studio.document.id)); }}
      onDelete={() => { if (canLeave()) void onDeleteRecording(studio.document.id).then((deleted) => { if (deleted) { setStudio(null); setStudioError(''); } }); }} canManage={Boolean(workingDirectory)}
    /> : <>
      <div className="settings-heading"><div><button type="button" className="secondary" onClick={onBack}>返回浏览器设置</button><h1>浏览器自动化</h1><p>把重复网页操作保存下来，之后可以再次运行。</p></div><button type="button" className="secondary" disabled={busy} onClick={onRefreshRecordings}>刷新</button></div>
      <div className="browser-recording-toolbar"><input type="search" aria-label="搜索录制任务" placeholder="搜索名称、描述或网站" value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="secondary" aria-expanded={guideOpen} onClick={() => setGuideOpen(!guideOpen)}>如何新建录制</button></div>
      {guideOpen && <p>在对话中告诉 Jojo 要录制的网页任务，例如“帮我录制打开后台并导出报表的操作”。开始录制前会按权限规则请求确认。</p>}
      {recordingsBusy && !recordings && <p role="status">正在读取录制任务…</p>}
      {!recordingsBusy && !recordings && <p>暂时无法读取录制任务，请刷新重试。</p>}
      {recordings?.recordings.length === 0 && <p>尚无录制任务。</p>}
      {recordings && recordings.recordings.length > 0 && !recordings.recordings.some((item) => `${item.name} ${item.description ?? ''} ${item.domains.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) && <p>没有匹配的录制任务。</p>}
      {(['user', 'project', 'builtin'] as const).map((source) => {
        const items = recordings?.recordings.filter((item) => item.source === source && `${item.name} ${item.description ?? ''} ${item.domains.join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
        return items.length > 0 && <section className="settings-section-card" key={source}><div className="settings-section-title"><h2 title={recordingScopeHelp[source]}>{recordingScope[source]}</h2></div><div className="browser-recording-list">{items.map((recording) => <article className="browser-recording-item" key={recording.id}><div className="browser-recording-main"><div className="browser-recording-title"><strong>{recording.name}</strong></div>{recording.description && <p>{recording.description}</p>}<p>{recording.stepCount} 个步骤 · {recording.domains.join('、') || '未指定网站'}</p><p>{recording.highRisk ? '包含敏感操作' : '只读 / 等待操作'}</p></div><div className="browser-recording-actions"><button type="button" disabled={busy} onClick={() => { void openStudio(recording.id); }}>打开</button></div></article>)}</div></section>;
      })}
      <button type="button" className="secondary" aria-expanded={pathsOpen} onClick={() => setPathsOpen(!pathsOpen)}>存储位置</button>
      {pathsOpen && <div className="browser-recording-paths"><p>个人：{recordings?.userDirectory ?? '暂不可用'}</p><p>项目：{recordings?.projectDirectory ?? '选择项目后显示'}</p></div>}
    </>}
  </section>;
}

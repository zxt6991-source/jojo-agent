import React, { useState } from 'react';
import type { BrowserSettings, BrowserRecordingRegistrySnapshot } from '@desktop-agent/contracts';
import { parseBrowserDomainList } from '../browser-settings';
import { BrowserSiteAccess } from './BrowserSiteAccess';
import { BrowserModeSelector } from './BrowserModeSelector';

export function BrowserSettingsPage({ enabled, mode, domains, saved, recordings, recordingsBusy, error, onEnabledChange, onModeChange, onDomainsChange, onDiscard, onPermissions, onRecordings, onSubmit }: {
  enabled: boolean;
  mode: 'sandbox' | 'chrome';
  domains: string;
  saved: BrowserSettings;
  recordings: BrowserRecordingRegistrySnapshot | null;
  recordingsBusy: boolean;
  error: string;
  onEnabledChange: (value: boolean) => void;
  onModeChange: (value: 'sandbox' | 'chrome') => void;
  onDomainsChange: (value: string) => void;
  onDiscard: () => void;
  onPermissions: () => void;
  onRecordings: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [sitesOpen, setSitesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const list = parseBrowserDomainList(domains);
  const dirty = enabled !== saved.enabled || mode !== saved.mode || JSON.stringify([...list].sort()) !== JSON.stringify([...saved.allowedDomains].sort());
  return <form className="settings-content model-settings-page browser-settings-page" aria-labelledby="browser-settings-title" onSubmit={(event) => {
    event.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    void onSubmit().finally(() => setBusy(false));
  }}>
    <div className="settings-heading"><div><h1 id="browser-settings-title">浏览器</h1><p>让 Jojo 打开和操作需要交互的网页。</p></div><span className={`browser-status-pill ${enabled ? 'on' : ''}`}>{enabled ? '已开启' : '已关闭'}{enabled !== saved.enabled ? '（待保存）' : ''}</span></div>
    <fieldset className="browser-settings-fields" disabled={busy}>
      <section className="settings-section-card"><div className="browser-toggle-row"><div className="browser-toggle-copy"><strong id="browser-enabled-label">浏览器访问</strong><span>Jojo 可以在需要时打开并操作网页。</span></div><button type="button" role="switch" aria-checked={enabled} aria-labelledby="browser-enabled-label" className={`extension-switch ${enabled ? 'on' : ''}`} onClick={() => onEnabledChange(!enabled)}><span /></button></div></section>
      <BrowserModeSelector enabled={enabled} mode={mode} onChange={onModeChange} />
      <section className="settings-section-card browser-summary-row"><div><h2>网站访问</h2><p>未加入列表的网站首次打开时会请求确认。</p><span>{list.length} 个网站无需确认即可打开</span></div><button type="button" className="secondary" onClick={() => setSitesOpen(true)}>管理网站</button></section>
      <section className="settings-section-card browser-summary-row"><div><h2>安全保护</h2><p>Jojo 可以读取已打开的网页。点击、输入、提交、下载、脚本执行和敏感数据访问等操作仍会请求确认。</p></div><button type="button" className="secondary" onClick={onPermissions}>查看权限规则</button></section>
      <section className="settings-section-card browser-summary-row"><div><h2>浏览器自动化</h2><p>{recordings ? `已保存 ${recordings.recordings.length} 个录制任务` : recordingsBusy ? '正在读取录制任务…' : '录制任务数量暂不可用'}</p></div><button type="button" className="secondary" onClick={onRecordings}>管理录制任务</button></section>
      <div className="settings-actions browser-save-actions"><span role="status">{busy ? '正在保存…' : dirty ? '有尚未保存的修改。' : '所有设置已保存。'}</span>{dirty && <><button type="button" className="secondary" onClick={onDiscard}>放弃修改</button><button className="primary" type="submit">保存</button></>}</div>
    </fieldset>
    {error && <div className="settings-error" role="alert">{error}</div>}
    {sitesOpen && <BrowserSiteAccess enabled={enabled} domains={domains} onChange={onDomainsChange} onClose={() => setSitesOpen(false)} />}
  </form>;
}

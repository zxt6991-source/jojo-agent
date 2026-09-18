import React, { useEffect, useRef, useState } from 'react';
import { browserDomainIssue, parseBrowserDomainList } from '../browser-settings';

export function BrowserSiteAccess({ enabled, domains, onChange, onClose }: { enabled: boolean; domains: string; onChange: (value: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const list = parseBrowserDomainList(domains);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const add = (raw = draft) => {
    const additions = parseBrowserDomainList(raw);
    const issue = additions.map(browserDomainIssue).find(Boolean);
    if (issue) { setError(issue); return false; }
    if (!additions.length) return true;
    onChange([...new Set([...list, ...additions])].join('\n'));
    setDraft(''); setError('');
    return true;
  };
  return <dialog ref={dialog} className="browser-site-dialog" aria-labelledby="browser-sites-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id="browser-sites-title">无需确认即可打开的网站</h2><p>这些网站可以直接打开。输入、提交、上传、下载等操作仍会单独询问。</p>
    <div className="browser-domain-editor">
      {list.map((domain) => <span className="browser-domain-chip" key={domain}>{domain}<button type="button" disabled={!enabled} aria-label={`移除 ${domain}`} onClick={() => onChange(list.filter((item) => item !== domain).join('\n'))}>×</button></span>)}
      <input autoFocus aria-label="添加网站" disabled={!enabled} placeholder="example.com 或 *.example.com" value={draft} onChange={(event) => { setDraft(event.target.value); setError(''); }} onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && (event.key === 'Enter' || event.key === ',')) { event.preventDefault(); add(); }
      }} onPaste={(event) => { const value = event.clipboardData.getData('text'); if (/[\s,;]/u.test(value)) { event.preventDefault(); add(`${draft} ${value}`); } }} />
    </div>
    <p>只填写域名，不要带 https://。*.example.com 只匹配子域，不匹配 example.com 本身。</p>
    {!enabled && <p>开启浏览器访问后可编辑网站列表。</p>}
    {error && <div className="settings-error" role="alert">{error}</div>}
    <p>完成后，请在浏览器设置页保存修改。</p>
    <div className="settings-actions"><button type="button" className="secondary" onClick={onClose}>关闭</button><button type="button" className="primary" onClick={() => { if (!enabled || add()) onClose(); }}>完成</button></div>
  </dialog>;
}

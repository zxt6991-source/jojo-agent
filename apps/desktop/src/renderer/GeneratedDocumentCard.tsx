import React, { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import type { GeneratedDocument } from '@desktop-agent/contracts';

export function GeneratedDocumentCard({ document }: { document: GeneratedDocument }) {
  const [expanded, setExpanded] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const preview = useMemo(() => {
    const html = DOMPurify.sanitize(document.content, {
      WHOLE_DOCUMENT: true,
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'form']
    });
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">${html}`;
  }, [document.content]);
  const save = async () => {
    setSaving(true);
    setStatus('');
    try {
      const result = await window.desktopAgent.saveGeneratedDocument(document);
      if (!result.canceled) setStatus('文档已保存');
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };
  return <section className="generated-document" aria-label={`生成的文档：${document.name}`}>
    <header>
      <span aria-hidden="true">▤</span>
      <strong>{document.name}</strong>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起预览' : '预览文档'}</button>
      <button type="button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '下载保存'}</button>
    </header>
    {expanded && <iframe title={`预览 ${document.name}`} sandbox="" referrerPolicy="no-referrer" srcDoc={preview} />}
    {status && <p role="status">{status}</p>}
  </section>;
}

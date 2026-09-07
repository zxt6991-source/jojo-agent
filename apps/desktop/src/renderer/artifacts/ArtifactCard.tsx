import React, { useEffect, useRef, useState } from 'react';
import { artifactRenderer, type ArtifactDescriptor } from '@desktop-agent/contracts';
import { ArtifactRenderer } from './ArtifactRenderer';

export function ArtifactCard({ artifact, sessionId, openRequest = 0 }: { artifact: ArtifactDescriptor; sessionId?: string; openRequest?: number }) {
  const [expanded, setExpanded] = useState(artifact.storage.type === 'conversation' || ['markdown', 'image'].includes(artifact.kind));
  const [panel, setPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; text: string; imageUrl: string }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const key = `${sessionId}:${artifact.id}:${artifact.version}:${artifact.metadata?.revision ?? ''}`;
  const renderer = artifactRenderer(artifact);
  useEffect(() => { if (openRequest) setPanel(true); }, [openRequest]);
  const inlineText = artifact.storage.type === 'conversation' ? artifact.storage.content : undefined;
  useEffect(() => {
    if (panel) dialog.current?.showModal();
    else dialog.current?.close();
  }, [panel]);
  useEffect(() => {
    if ((!expanded && !panel) || inlineText !== undefined || !sessionId || renderer === 'download-only') return;
    let canceled = false;
    setStatus('正在读取…');
    void window.desktopAgent.readArtifact({ sessionId, artifactId: artifact.id }).then((value) => {
      if (canceled) return;
      const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
      setLoaded({ key, text: new TextDecoder().decode(bytes), imageUrl: `data:${value.mimeType};base64,${value.data}` });
      setStatus('');
    }).catch((error: unknown) => { if (!canceled) setStatus(`读取失败：${error instanceof Error ? error.message : String(error)}`); });
    return () => { canceled = true; };
  }, [key, expanded, panel, inlineText, sessionId, artifact.id, renderer]);
  const save = async () => {
    setSaving(true); setStatus('');
    try {
      const result = sessionId
        ? await window.desktopAgent.saveArtifact({ sessionId, artifactId: artifact.id })
        : inlineText !== undefined && artifact.kind === 'html'
          ? await window.desktopAgent.saveGeneratedDocument({ name: artifact.name, content: inlineText }) : undefined;
      if (result && !result.canceled) setStatus('文档已保存');
    } catch (error) { setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setSaving(false); }
  };
  const renderPreview = () => inlineText !== undefined || loaded?.key === key || renderer === 'download-only'
    ? <ArtifactRenderer artifact={artifact} text={inlineText ?? loaded?.text ?? ''} imageUrl={loaded?.imageUrl ?? ''} /> : <p>等待内容…</p>;
  return <section className="generated-document artifact-card" aria-label={`生成的文档：${artifact.name}`} data-artifact-id={artifact.id}>
    <header>
      <span aria-hidden="true">▤</span><strong>{artifact.name}</strong><span>v{artifact.version}{artifact.size !== undefined ? ` · ${(artifact.size / 1024).toFixed(1)} KB` : ''}</span>
      <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? '收起预览' : '预览文档'}</button>
      <button type="button" onClick={() => setPanel(true)}>打开面板</button>
      <button type="button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '下载保存'}</button>
    </header>
    {artifact.kind === 'html' && <small>下载保存为原始 HTML，可能包含脚本；预览已隔离。</small>}
    {expanded && renderPreview()}
    {status && <p role="status">{status}</p>}
    <dialog ref={dialog} className="artifact-panel" onCancel={() => setPanel(false)} onClose={() => setPanel(false)} aria-label={`Artifact 预览：${artifact.name}`}>
      <header><strong>{artifact.name}</strong><button type="button" onClick={() => setPanel(false)}>关闭</button></header>
      {panel && renderPreview()}
      {status && <p role="status">{status}</p>}
    </dialog>
  </section>;
}

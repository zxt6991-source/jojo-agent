import { ArtifactResizeHandle } from './ArtifactResizeHandle';
import React, { useEffect, useState } from 'react';
import { artifactRenderer, type ArtifactDescriptor } from '@desktop-agent/contracts';
import { ArtifactRenderer } from './ArtifactRenderer';

export function ArtifactPanel({ artifact, sessionId, onClose, chatWidth, onResize }: { artifact: ArtifactDescriptor; sessionId: string; onClose: () => void; chatWidth: number; onResize: (width: number) => void }) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [loaded, setLoaded] = useState<{ key: string; text: string; imageUrl: string }>();
  const key = `${sessionId}:${artifact.id}:${artifact.version}:${artifact.metadata?.revision ?? ''}`;
  const renderer = artifactRenderer(artifact);
  const inlineText = artifact.storage.type === 'conversation' ? artifact.storage.content : undefined;
  useEffect(() => {
    if (inlineText !== undefined || !sessionId || renderer === 'download-only') return;
    let canceled = false;
    setStatus('正在读取…');
    void window.desktopAgent.readArtifact({ sessionId, artifactId: artifact.id }).then((value) => {
      if (canceled) return;
      const bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
      setLoaded({ key, text: renderer === 'image' ? '' : new TextDecoder().decode(bytes), imageUrl: `data:${value.mimeType};base64,${value.data}` });
      setStatus('');
    }).catch((error: unknown) => { if (!canceled) setStatus(`读取失败：${error instanceof Error ? error.message : String(error)}`); });
    return () => { canceled = true; };
  }, [key, inlineText, sessionId, artifact.id, renderer]);
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
  return <aside className="artifact-panel" aria-label={`文档预览：${artifact.name}`}>
    <ArtifactResizeHandle chatWidth={chatWidth} onResize={onResize} />
    <header className="artifact-panel-header">
      <span aria-hidden="true">▤</span><strong title={artifact.name}>{artifact.name}</strong>
      <button type="button" onClick={() => onResize(chatWidth === 0 ? 44 : 0)} aria-label={chatWidth === 0 ? '恢复聊天分栏' : '展开文档至整个内容区'} title={chatWidth === 0 ? '恢复聊天分栏' : '展开文档至整个内容区'}>{chatWidth === 0 ? '↙' : '↗'}</button>
      <button type="button" onClick={onClose} aria-label="关闭文档预览" title="关闭文档预览">×</button>
    </header>
    <div className="artifact-panel-toolbar">
      <span className="artifact-location" title={artifact.storage.type === 'workspace' ? artifact.storage.path : artifact.name}>{artifact.storage.type === 'workspace' ? artifact.storage.path : '对话文档'} · v{artifact.version}</span>
      <button type="button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '下载保存'}</button>
    </div>
    {artifact.kind === 'html' && <small className="artifact-save-note">保存原始 HTML；预览已隔离。</small>}
    <div className="artifact-panel-content">{renderPreview()}</div>
    {status && <p className="artifact-panel-status" role="status">{status}</p>}
  </aside>;
}

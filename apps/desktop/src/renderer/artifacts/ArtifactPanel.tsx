import { ArtifactResizeHandle } from './ArtifactResizeHandle';
import React, { useEffect, useReducer, useRef } from 'react';
import { artifactRenderer, type ArtifactDescriptor } from '@desktop-agent/contracts';
import { ArtifactRenderer } from './ArtifactRenderer';
import { ArtifactRequestGeneration, artifactContentReducer, artifactErrorMessages, canSaveArtifact, initialArtifactState, loadArtifactValue, type LoadedArtifact } from './artifact-content-state';

type Props = { artifact: ArtifactDescriptor; sessionId: string; onClose: () => void; chatWidth: number; onResize: (width: number) => void };
export function ArtifactPanel(props: Props) {
  // Remount synchronously on identity changes: no frame may display a previous session's content.
  const key = JSON.stringify([props.sessionId, props.artifact.id, props.artifact.version, props.artifact.metadata?.revision]);
  return <ArtifactPanelContent key={key} {...props} />;
}
function ArtifactPanelContent({ artifact, sessionId, onClose, chatWidth, onResize }: Props) {
  const [state, dispatch] = useReducer(artifactContentReducer, initialArtifactState);
  const generation = useRef(new ArtifactRequestGeneration());
  const reading = useRef(false);
  const saving = useRef(false);
  const renderer = artifactRenderer(artifact);
  const temporary = !sessionId && artifact.storage.type === 'conversation' && artifact.kind === 'html';
  const inlineText = temporary && artifact.storage.type === 'conversation' ? artifact.storage.content : undefined;
  const loaded = 'loaded' in state ? state.loaded : undefined;
  const compatible = typeof window.desktopAgent.readArtifactV2 === 'function' && typeof window.desktopAgent.saveArtifactV2 === 'function';
  async function read(previous?: LoadedArtifact) {
    if (reading.current || saving.current) return;
    reading.current = true;
    const requestId = generation.current.next();
    dispatch({ type: 'read', requestId });
    try {
      if (!compatible) { dispatch({ type: 'failure', requestId, error: 'INVALID_REQUEST' }); return; }
      const target = { schemaVersion: 2 as const, sessionId, artifactId: artifact.id, representation: renderer === 'download-only' ? 'metadata' as const : 'content' as const };
      const cached = previous && (renderer === 'download-only' || previous.hasBytes) ? previous : undefined;
      let result = await window.desktopAgent.readArtifactV2({ ...target, ...(cached ? { knownRevision: cached.info.currentRevision } : {}) });
      if (!generation.current.isCurrent(requestId)) return;
      if (result.ok && result.value.delivery === 'not-modified' && !loadArtifactValue(result.value, cached, renderer === 'image')) {
        result = await window.desktopAgent.readArtifactV2(target);
      }
      if (!generation.current.isCurrent(requestId)) return;
      if (!result.ok) { dispatch({ type: 'failure', requestId, error: result.error.code }); return; }
      if (result.value.info.sessionId !== sessionId || result.value.info.artifactId !== artifact.id) throw new Error('Unexpected target');
      const value = loadArtifactValue(result.value, cached, renderer === 'image');
      if (!value || (renderer !== 'download-only' && !value.hasBytes)) throw new Error('Missing content');
      dispatch({ type: 'loaded', requestId, loaded: value });
    } catch {
      if (generation.current.isCurrent(requestId)) dispatch({ type: 'failure', requestId, error: 'INVALID_REQUEST' });
    } finally { reading.current = false; }
  }
  useEffect(() => {
    if (!temporary) void read();
    const current = generation.current;
    return () => { current.invalidate(); reading.current = false; };
    // The keyed component owns one immutable artifact identity.
  }, []);
  async function save() {
    if (saving.current || (!temporary && !canSaveArtifact(state))) return;
    saving.current = true;
    const requestId = state.requestId;
    const operation = generation.current.next();
    dispatch({ type: 'saving', requestId, temporary });
    try {
      if (temporary) {
        const result = await window.desktopAgent.saveGeneratedDocument({ name: artifact.name, content: inlineText! });
        if (generation.current.isCurrent(operation)) dispatch({ type: 'saved', requestId, notice: result.canceled ? '' : '已保存此次检查的原始内容' });
      } else {
        const result = await window.desktopAgent.saveArtifactV2({ schemaVersion: 2, sessionId, artifactId: artifact.id, expectedRevision: loaded!.info.currentRevision });
        if (!generation.current.isCurrent(operation)) return;
        dispatch(result.ok ? { type: 'saved', requestId, notice: result.value.canceled ? '' : '已保存此次检查的原始内容' }
          : { type: 'saved', requestId, notice: '', error: result.error.code });
      }
    } catch {
      if (generation.current.isCurrent(operation)) dispatch({ type: 'saved', requestId, notice: '', error: 'INVALID_REQUEST' });
    } finally { saving.current = false; }
  }
  const checking = state.phase === 'loading' || (state.phase === 'ready' && state.refreshing);
  const status = state.phase === 'stale' || state.phase === 'error' ? artifactErrorMessages[state.error] : checking ? '正在检查…' : state.notice;
  return <aside className="artifact-panel" aria-label={`文档预览：${artifact.name}`}>
    <ArtifactResizeHandle chatWidth={chatWidth} onResize={onResize} />
    <header className="artifact-panel-header">
      <span aria-hidden="true">▤</span><strong title={artifact.name}>{artifact.name}</strong>
      <button type="button" onClick={() => onResize(chatWidth === 0 ? 44 : 0)} aria-label={chatWidth === 0 ? '恢复聊天分栏' : '展开文档至整个内容区'} title={chatWidth === 0 ? '恢复聊天分栏' : '展开文档至整个内容区'}>{chatWidth === 0 ? '↙' : '↗'}</button>
      <button type="button" onClick={onClose} aria-label="关闭文档预览" title="关闭文档预览">×</button>
    </header>
    <div className="artifact-panel-toolbar">
      <span className="artifact-location" title={artifact.storage.type === 'workspace' ? artifact.storage.path : artifact.name}>{artifact.storage.type === 'workspace' ? artifact.storage.path : '对话文档'}{!temporary && ` · 交付记录 v${loaded?.info.recordedVersion ?? artifact.version}`}</span>
      {!temporary && <button type="button" disabled={checking || state.saving || !compatible} onClick={() => void read(loaded)}>{state.phase === 'stale' || state.phase === 'error' ? '重试' : '刷新'}</button>}
      <button type="button" disabled={temporary ? state.saving : !compatible || !canSaveArtifact(state)} onClick={() => void save()}>{state.saving ? '正在保存…' : '下载保存'}</button>
    </div>
    {artifact.kind === 'html' && <small className="artifact-save-note">预览经过清洗与隔离；保存的是对应的原始文件。</small>}
    {loaded && <small className="artifact-content-info">{loaded.info.size} 字节 · 指纹 {loaded.info.currentRevision.slice(0, 12)} · 检查于 {new Date(loaded.info.checkedAt).toLocaleTimeString()}
      {loaded.info.recordedState === 'changed-since-recorded' && ' · 文件已在交付后修改'}
      {loaded.info.recordedState === 'recorded-revision-unknown' && ' · 历史记录未包含内容指纹'}
    </small>}
    {state.phase === 'stale' && <small className="artifact-stale-note">当前显示已读副本，刷新成功后才能保存。</small>}
    <div className="artifact-panel-content">{inlineText !== undefined || loaded
      ? <ArtifactRenderer artifact={artifact} text={inlineText ?? loaded?.text ?? ''} imageUrl={loaded?.imageUrl ?? ''} />
      : <p>{checking ? '正在读取内容…' : '内容不可用，请重试。'}</p>}</div>
    {status && <p className="artifact-panel-status" role="status">{status}</p>}
  </aside>;
}

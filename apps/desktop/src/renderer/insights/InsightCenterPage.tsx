import React, { useEffect, useReducer, useRef, useState } from 'react';
import type { DesktopApi, InsightAnalysisPerspective, InsightGenerateInput, InsightPerspective, MessageReference } from '@desktop-agent/contracts';
import { ConversationMapPage } from '../ConversationMapPage';
import { InsightEvidencePanel, type InsightSourceView } from './InsightEvidencePanel';
import { InsightResultPage } from './InsightResultPage';
import { AnalysisProgressPanel } from './AnalysisProgressPanel';
import { insightReducer, insightSelectionKey, perspectiveLabels, type InsightSelection } from './state';
import '../conversation-map.css';
import './insights.css';

type InsightApi = Pick<DesktopApi, 'generateInsight' | 'cancelInsight' | 'getInsightSource' | 'onInsightEvent'
  | 'generateConversationMap' | 'cancelConversationMap' | 'getConversationMapSource' | 'onConversationMapEvent'>
  & Partial<Pick<DesktopApi, 'onSessionsChanged'>>;
const perspectives: { id: InsightPerspective; icon: string; description: string }[] = [
  { id: 'conversation_map', icon: '⌘', description: '回顾聊过的主题、观点变化与当前结论。' },
  { id: 'reverse_thinking', icon: '⇄', description: '检验核心假设，寻找反例与可能的失败条件。' },
  { id: 'second_order', icon: '↗', description: '从一个选择出发，考虑下一层可能的影响。' },
  { id: 'blind_spots', icon: '◎', description: '发现所选聊天中的信息缺口，提出补充问题。' }
];

export function InsightCenterPage({ api, workingDirectory, currentSessionId, selection, onSelectionChange, onOpenSource, onOpenModelSettings }: {
  api: InsightApi; workingDirectory?: string; currentSessionId?: string;
  selection: InsightSelection; onSelectionChange(selection: InsightSelection): void;
  onOpenSource(sessionId: string, messageId: string): Promise<void>; onOpenModelSettings(): void;
}) {
  const [perspective, setPerspective] = useState<InsightPerspective>();
  const [state, dispatch] = useReducer(insightReducer, { status: 'idle' });
  const [source, setSource] = useState<InsightSourceView>();
  const [notice, setNotice] = useState('');
  const [cancelError, setCancelError] = useState('');
  const [jumping, setJumping] = useState(false);
  const activeRequest = useRef<string | undefined>(undefined);
  const latestRequest = useRef<string | undefined>(undefined);
  const sourceGeneration = useRef(0);
  const mounted = useRef(true);
  const projectAvailable = Boolean(workingDirectory && currentSessionId);
  const scope: InsightGenerateInput['scope'] = selection.scopeKind === 'project' && projectAvailable
    ? { kind: 'project', workingDirectory: workingDirectory! } : { kind: 'personal_main' };
  const selectedInput = { range: selection.range, scope, ...(scope.kind === 'project' && currentSessionId ? { currentSessionId } : {}),
    perspective: perspective && perspective !== 'conversation_map' ? perspective : 'reverse_thinking' as InsightAnalysisPerspective };
  const selectionKey = insightSelectionKey(selectedInput);
  const running = state.status === 'running';
  const result = state.result && state.result.request.perspective === perspective ? state.result.value : undefined;
  const stale = Boolean(state.result && insightSelectionKey(state.result.request) !== selectionKey);
  const pendingChanged = Boolean(running && state.request && insightSelectionKey(state.request) !== selectionKey);

  function clearSource() { sourceGeneration.current++; setSource(undefined); }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.onInsightEvent(event => {
      if (event.requestId !== activeRequest.current) return;
      if (event.type !== 'insight.progress') activeRequest.current = undefined;
      dispatch({ type: 'event', event });
    });
    const unsubscribeSessions = api.onSessionsChanged?.(() => {
      const requestId = activeRequest.current ?? latestRequest.current;
      if (!requestId) return;
      activeRequest.current = undefined;
      latestRequest.current = undefined;
      sourceGeneration.current++;
      setSource(undefined);
      dispatch({ type: 'invalidate' });
      setNotice('会话记录已更新，旧结果与原文已清除，请重新生成。');
      void api.cancelInsight({ requestId }).catch(() => undefined);
    });
    return () => {
      mounted.current = false;
      unsubscribe(); unsubscribeSessions?.(); sourceGeneration.current++;
      const requestId = activeRequest.current ?? latestRequest.current;
      activeRequest.current = undefined; latestRequest.current = undefined;
      if (requestId) void api.cancelInsight({ requestId }).catch(() => undefined);
    };
  }, [api]);

  useEffect(() => {
    sourceGeneration.current++; setSource(undefined);
  }, [selectionKey, state.result?.request.requestId, perspective]);

  useEffect(() => {
    const requestId = activeRequest.current;
    if (!pendingChanged || !requestId) return;
    activeRequest.current = undefined;
    dispatch({ type: 'cancel' });
    void api.cancelInsight({ requestId }).catch(() => {
      if (mounted.current) setCancelError('取消请求未成功，请重试或关闭此页面。');
    });
  }, [api, pendingChanged]);

  async function cancel() {
    const requestId = activeRequest.current;
    if (!requestId) return;
    activeRequest.current = undefined;
    clearSource(); dispatch({ type: 'cancel' });
    try { await api.cancelInsight({ requestId }); }
    catch { if (mounted.current) setCancelError('取消请求未成功，请重试或关闭此页面。'); }
  }

  async function generate(nextPerspective: InsightAnalysisPerspective) {
    if (activeRequest.current) return;
    setPerspective(nextPerspective);
    const request: InsightGenerateInput = { ...selectedInput, perspective: nextPerspective, requestId: crypto.randomUUID() };
    activeRequest.current = request.requestId; latestRequest.current = request.requestId;
    clearSource(); setNotice(''); setCancelError(''); dispatch({ type: 'start', request });
    try { await api.generateInsight(request); }
    catch (cause) {
      if (!mounted.current || activeRequest.current !== request.requestId) return;
      activeRequest.current = undefined;
      dispatch({ type: 'event', event: { type: 'insight.failed', requestId: request.requestId, code: 'request_failed', message: cause instanceof Error ? cause.message : '无法启动分析，请重试。' } });
    }
  }

  function invalidateSources() {
    const requestId = activeRequest.current ?? latestRequest.current;
    activeRequest.current = undefined; latestRequest.current = undefined;
    clearSource(); dispatch({ type: 'invalidate' });
    setNotice('引用不可用：原文可能已删除或访问权限已变化。旧结果与相关原文已清除，请重新生成。');
    if (requestId) void api.cancelInsight({ requestId }).catch(() => undefined);
  }

  async function readSource(reference: MessageReference) {
    if (!state.result || running || stale) return;
    const generation = ++sourceGeneration.current;
    const input = { requestId: state.result.request.requestId, sessionId: reference.sessionId, entryId: reference.entryId };
    setSource({ input, status: 'loading' });
    try {
      const value = await api.getInsightSource(input);
      if (!mounted.current || generation !== sourceGeneration.current) return;
      if (!value.available) { invalidateSources(); return; }
      setSource({ input, status: 'ready', value });
    } catch {
      if (mounted.current && generation === sourceGeneration.current) setSource({ input, status: 'error', error: '无法读取原始记录，请重新选择出处或重新生成。' });
    }
  }

  async function jumpToSource() {
    if (!source?.value?.available || jumping || stale || running) return;
    const generation = sourceGeneration.current;
    setJumping(true);
    try {
      const value = await api.getInsightSource(source.input);
      if (!mounted.current || generation !== sourceGeneration.current) return;
      if (!value.available) { invalidateSources(); return; }
      setSource({ input: source.input, status: 'ready', value });
      await onOpenSource(value.reference.sessionId, value.messageId);
    } catch {
      if (mounted.current && generation === sourceGeneration.current) setSource({ input: source.input, status: 'error', error: '无法打开原始对话，请重新生成后重试。' });
    } finally { if (mounted.current) setJumping(false); }
  }

  function returnToCenter() { void cancel(); clearSource(); setPerspective(undefined); }
  function selectPerspective(next: InsightPerspective) {
    if (running) return;
    if (next === 'conversation_map') {
      const requestId = latestRequest.current;
      latestRequest.current = undefined; clearSource(); dispatch({ type: 'invalidate' });
      if (requestId) void api.cancelInsight({ requestId }).catch(() => undefined);
      setPerspective(next);
    } else void generate(next);
  }

  if (perspective === 'conversation_map') return <div className="insight-map-view">
    <button className="insight-back" type="button" onClick={returnToCenter}>← 返回洞察中心</button>
    <ConversationMapPage api={api} {...(workingDirectory ? { workingDirectory } : {})} {...(currentSessionId ? { currentSessionId } : {})}
      initialRange={selection.range} initialScopeKind={scope.kind} onSelectionChange={onSelectionChange}
      onOpenSource={onOpenSource} onOpenModelSettings={onOpenModelSettings} />
  </div>;

  return <section className="settings-content conversation-map-page insight-center-page" aria-labelledby="insight-center-title" data-testid="insight-center-page">
    {perspective && <button className="insight-back" type="button" onClick={returnToCenter}>← 返回洞察中心</button>}
    <div className="settings-heading"><div><h1 id="insight-center-title">{perspective ? perspectiveLabels[perspective] : 'AI 洞察中心'}</h1>
      <p>{perspective ? perspectives.find(item => item.id === perspective)?.description : '选择不同视角，从历史对话中发现更多线索。'}</p></div><span className="conversation-map-badge">按需洞察</span></div>
    <section className="conversation-map-controls" aria-label="洞察分析选项">
      <fieldset><legend>时间范围</legend><div className="conversation-map-range">{(['7d', '30d', '90d'] as const).map(range =>
        <button type="button" key={range} aria-pressed={selection.range === range} onClick={() => onSelectionChange({ ...selection, range })}>最近{range.slice(0, -1)}天</button>)}</div></fieldset>
      <label className="conversation-map-scope">数据范围<select aria-label="数据范围" value={scope.kind} onChange={event => onSelectionChange({ ...selection, scopeKind: event.target.value as InsightSelection['scopeKind'] })}>
        <option value="personal_main">个人主对话</option>{projectAvailable && <option value="project">当前项目</option>}
      </select></label>
      {perspective && <div className="conversation-map-actions"><button className="primary" type="button" disabled={running} onClick={() => void generate(perspective)}>{running ? '正在分析…' : state.status === 'failed' ? '重试生成' : result ? '重新生成' : '生成洞察'}</button>{running && <button type="button" onClick={() => void cancel()}>取消生成</button>}</div>}
      <p className="conversation-map-consent">点击视角后才会分析所选范围。历史文本可能通过当前配置的 AI 服务提供商处理并消耗模型额度；结果不会写入聊天或长期记忆。</p>
      <p className="conversation-map-scope-note">{scope.kind === 'project' ? `当前项目：${workingDirectory}` : '仅包含有权访问的个人主对话，不包含团队、派生、定时任务或渠道对话。'}</p>
    </section>
    {!perspective && <div className="insight-perspectives" aria-label="分析视角">{perspectives.map(item => <button type="button" className="insight-perspective" key={item.id} onClick={() => selectPerspective(item.id)} disabled={running}>
      <span className="insight-perspective-icon" aria-hidden="true">{item.icon}</span><strong>{perspectiveLabels[item.id]}</strong><span>{item.description}</span><small>{item.id === 'conversation_map' ? '查看交流脉络 →' : '开始分析 →'}</small>
    </button>)}</div>}
    {notice && <p className="conversation-map-notice" role="status">{notice}</p>}
    {running && perspective && <AnalysisProgressPanel key={state.request?.requestId} perspective={perspective} progress={state.progress} history={state.progressHistory} />}
    {perspective && state.status === 'cancelled' && <p className="conversation-map-notice" role="status">已取消生成。可以调整范围后重新生成。</p>}
    {perspective && (state.error || cancelError) && <div className="settings-error conversation-map-notice" role="alert"><p>{state.error || cancelError}</p><button type="button" onClick={onOpenModelSettings}>检查模型配置</button></div>}
    {perspective && result && <InsightResultPage result={result} stale={stale} running={running} onReadSource={reference => void readSource(reference)}
      onRegenerate={() => void generate(perspective)} onOpenModelSettings={onOpenModelSettings} />}
    {perspective && source && !stale && !running && <InsightEvidencePanel source={source} jumping={jumping} onJump={() => void jumpToSource()} onClose={clearSource} />}
  </section>;
}

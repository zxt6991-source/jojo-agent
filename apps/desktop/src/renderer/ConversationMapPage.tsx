import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ConversationMapGenerateInput, ConversationMapSourceInput, ConversationMapSourceResult, DesktopApi, MessageReference } from '@desktop-agent/contracts';
import { ConversationMapDiagram } from './ConversationMapDiagram';
import { conversationFlowchart, conversationMapReducer, conversationMapSelectionKey, conversationMindmap, orderedSteps, relationLabels, stepLabels } from './conversation-map';
import './conversation-map.css';

type MapApi = Pick<DesktopApi, 'generateConversationMap' | 'cancelConversationMap' | 'getConversationMapSource' | 'onConversationMapEvent'> & Partial<Pick<DesktopApi, 'onSessionsChanged'>>;
const phases = { reading: '读取历史', extracting: '归纳主题', merging: '整理流程', rendering: '校验与绘制' } as const;
const localTime = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
type SourceView = { input: ConversationMapSourceInput; status: 'loading' | 'ready' | 'error'; value?: ConversationMapSourceResult; error?: string };

export function ConversationMapPage({ api, workingDirectory, currentSessionId, onOpenSource, onOpenModelSettings }: {
  api: MapApi;
  workingDirectory?: string;
  currentSessionId?: string;
  onOpenSource: (sessionId: string, messageId: string) => Promise<void>;
  onOpenModelSettings: () => void;
}) {
  const projectAvailable = Boolean(workingDirectory && currentSessionId);
  const [range, setRange] = useState<ConversationMapGenerateInput['range']>('30d');
  const [scopeKind, setScopeKind] = useState<'project' | 'personal_main'>(projectAvailable ? 'project' : 'personal_main');
  const [state, dispatch] = useReducer(conversationMapReducer, { status: 'idle' });
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [selectedStepId, setSelectedStepId] = useState('');
  const [source, setSource] = useState<SourceView>();
  const [cancelError, setCancelError] = useState('');
  const [historyNotice, setHistoryNotice] = useState('');
  const [jumping, setJumping] = useState(false);
  const activeRequest = useRef<string | undefined>(undefined);
  const sourceGeneration = useRef(0);
  const latestRequest = useRef<string | undefined>(undefined);
  const previousDirectory = useRef(workingDirectory);
  const mounted = useRef(true);
  const scope: ConversationMapGenerateInput['scope'] = scopeKind === 'project' && projectAvailable
    ? { kind: 'project', workingDirectory: workingDirectory! } : { kind: 'personal_main' };
  const selectionKey = conversationMapSelectionKey({ range, scope });
  const running = state.status === 'running';
  const result = state.result?.value;
  const stale = Boolean(state.result && selectionKey !== conversationMapSelectionKey(state.result.request));
  const pendingChanged = Boolean(state.request && running && selectionKey !== conversationMapSelectionKey(state.request));
  const topic = result?.topics.find((item) => item.id === selectedTopicId) ?? result?.topics[0];
  const steps = useMemo(() => topic ? orderedSteps(topic) : [], [topic]);
  const step = steps.find((item) => item.id === selectedStepId) ?? steps[0];
  const overviewCode = useMemo(() => result ? conversationMindmap(result) : '', [result]);
  const flowCode = useMemo(() => topic ? conversationFlowchart(topic) : '', [topic]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.onConversationMapEvent((event) => {
      if (event.requestId !== activeRequest.current) return;
      if (event.type !== 'conversation-map.progress') activeRequest.current = undefined;
      dispatch({ type: 'event', event });
    });
    const unsubscribeSessions = api.onSessionsChanged?.(() => {
      if (activeRequest.current || !latestRequest.current) return;
      const requestId = latestRequest.current;
      latestRequest.current = undefined;
      sourceGeneration.current++;
      setSource(undefined);
      dispatch({ type: 'invalidate' });
      setHistoryNotice('会话记录已更新，旧图已清除，请重新生成。');
      void api.cancelConversationMap({ requestId }).catch(() => undefined);
    });
    return () => {
      unsubscribeSessions?.();
      mounted.current = false;
      sourceGeneration.current++;
      unsubscribe();
      const requestId = activeRequest.current ?? latestRequest.current;
      activeRequest.current = undefined;
      if (requestId) void api.cancelConversationMap({ requestId }).catch(() => undefined);
    };
  }, [api]);

  useEffect(() => {
    if (!projectAvailable) setScopeKind('personal_main');
    if (previousDirectory.current === workingDirectory) return;
    previousDirectory.current = workingDirectory;
    const requestId = activeRequest.current;
    if (requestId) {
      activeRequest.current = undefined;
      dispatch({ type: 'cancel' });
      void api.cancelConversationMap({ requestId }).catch(() => { if (mounted.current) setCancelError('取消请求未成功，请重试或关闭此页面。'); });
    }
  }, [api, workingDirectory, projectAvailable]);

  useEffect(() => {
    sourceGeneration.current++;
    setSource(undefined);
  }, [state.result?.request.requestId, topic?.id, step?.id, workingDirectory]);

  async function generate() {
    if (activeRequest.current) return;
    const request: ConversationMapGenerateInput = { requestId: crypto.randomUUID(), range, scope, ...(scope.kind === 'project' && currentSessionId ? { currentSessionId } : {}) };
    activeRequest.current = request.requestId;
    latestRequest.current = request.requestId;
    setCancelError('');
    setHistoryNotice('');
    dispatch({ type: 'start', request });
    sourceGeneration.current++;
    setSource(undefined);
    try { await api.generateConversationMap(request); }
    catch (cause) {
      if (!mounted.current || activeRequest.current !== request.requestId) return;
      activeRequest.current = undefined;
      dispatch({ type: 'event', event: { type: 'conversation-map.failed', requestId: request.requestId, code: 'request_failed', message: cause instanceof Error ? cause.message : '无法启动分析，请重试。' } });
    }
  }

  async function cancel() {
    const requestId = activeRequest.current;
    if (!requestId) return;
    activeRequest.current = undefined;
    dispatch({ type: 'cancel' });
    try { await api.cancelConversationMap({ requestId }); }
    catch { if (mounted.current) setCancelError('取消请求未成功，请重试或关闭此页面。'); }
  }

  async function readSource(reference: MessageReference) {
    if (!state.result) return;
    const generation = ++sourceGeneration.current;
    const input = { requestId: state.result.request.requestId, sessionId: reference.sessionId, entryId: reference.entryId };
    setSource({ input, status: 'loading' });
    try {
      const value = await api.getConversationMapSource(input);
      if (mounted.current && generation === sourceGeneration.current) setSource({ input, status: 'ready', value });
    } catch {
      if (mounted.current && generation === sourceGeneration.current) setSource({ input, status: 'error', error: '无法读取原始记录，请重新选择出处或重新生成。' });
    }
  }

  async function jumpToSource() {
    if (!source?.value?.available || jumping) return;
    const generation = sourceGeneration.current;
    setJumping(true);
    try {
      // Deletion or permission changes after opening the evidence panel must invalidate the jump.
      const value = await api.getConversationMapSource(source.input);
      if (!mounted.current || generation !== sourceGeneration.current) return;
      setSource({ input: source.input, status: 'ready', value });
      if (value.available) await onOpenSource(value.reference.sessionId, value.messageId);
    } catch {
      if (mounted.current && generation === sourceGeneration.current) setSource({ input: source.input, status: 'error', error: '无法打开原始记录，请重新生成后重试。' });
    } finally { if (mounted.current) setJumping(false); }
  }

  return <section className="settings-content conversation-map-page" aria-labelledby="conversation-map-title" data-testid="conversation-map-page">
    <div className="settings-heading"><div><h1 id="conversation-map-title">交流脉络</h1><p>回顾与 Jojo 的历史讨论，查看主题和交流过程。</p></div><span className="conversation-map-badge">按需回顾</span></div>
    <section className="conversation-map-controls" aria-label="脉络分析选项">
      <fieldset><legend>时间范围</legend><div className="conversation-map-range">{(['7d', '30d', '90d'] as const).map((item) => <button type="button" key={item} aria-pressed={range === item} onClick={() => setRange(item)}>最近{item.slice(0, -1)}天</button>)}</div></fieldset>
      <label className="conversation-map-scope">数据范围<select aria-label="数据范围" value={scope.kind} onChange={(event) => setScopeKind(event.target.value as typeof scopeKind)}><option value="project" disabled={!projectAvailable}>当前项目</option><option value="personal_main">全部个人主对话</option></select></label>
      <div className="conversation-map-actions"><button className="primary" type="button" disabled={running} onClick={() => void generate()}>{running ? '正在生成…' : state.status === 'failed' ? '重试生成' : result ? '重新生成脉络图' : '生成脉络图'}</button>{running && <button type="button" onClick={() => void cancel()}>取消生成</button>}</div>
      <p className="conversation-map-consent">仅在点击「生成脉络图」后读取所选范围的历史对话。分析可能通过当前配置的 AI 服务提供商处理并产生费用。不会修改聊天或自动写入长期记忆。</p>
      <p className="conversation-map-scope-note">{scope.kind === 'project' ? `当前项目：${workingDirectory}` : `${!projectAvailable ? '当前没有有效项目，默认使用全部个人主对话。' : ''}包括有权访问的多个项目；不包含团队、派生、定时任务或渠道对话。`}</p>
    </section>
    {historyNotice && <p className="conversation-map-notice" role="status">{historyNotice}</p>}
    {running && <div className="conversation-map-notice" role="status"><div role="progressbar" aria-label="脉络生成进度" {...(state.progress?.total ? { 'aria-valuemin': 0, 'aria-valuemax': state.progress.total, 'aria-valuenow': state.progress.completed ?? 0 } : {})}>{phases[state.progress?.phase ?? 'reading']}…{state.progress?.total ? ` ${state.progress.completed ?? 0} / ${state.progress.total}` : ''}</div>{pendingChanged && <span>筛选条件已更改；本次仍按点击生成时的范围分析。</span>}</div>}
    {state.status === 'cancelled' && <p className="conversation-map-notice" role="status">已取消生成。可以调整范围后重新生成。</p>}
    {(state.error || cancelError) && <div className="settings-error conversation-map-notice" role="alert"><p>{state.error || cancelError}</p><button type="button" onClick={onOpenModelSettings}>检查模型配置</button></div>}
    {stale && <p className="conversation-map-notice warning" role="status">筛选条件或当前项目已更改，请重新生成。下方仍是上一次范围的结果。</p>}
    {!result && !running && state.status === 'idle' && <div className="conversation-map-empty"><span aria-hidden="true">⌘</span><h2>从一段历史，找到交流的线索</h2><p>选择时间与范围，手动生成主题总览。生成结果仅保留在此页面，关闭后即丢弃。</p></div>}
    {result && <>
      <div className="conversation-map-result-meta"><strong>{result.scopeKind === 'project' ? '项目对话' : '全部个人主对话'} · {state.result!.request.range.slice(0, -1)} 天</strong><span>{localTime(result.rangeStart)} — {localTime(result.rangeEnd)}</span><span>已分析 {result.analyzedTurnCount} 轮 · {result.analyzedSessionCount} 个会话{result.modelCallCount !== undefined ? ` · ${result.modelCallCount} 次模型调用` : ''}</span></div>
      {result.truncated && <p className="conversation-map-notice warning" role="status">本次回顾不完整：已分析 {result.analyzedTurnCount} 轮{result.omittedTurnCount !== undefined ? `，另有 ${result.omittedTurnCount} 轮未分析` : '，部分内容过长或超过分析上限'}。{result.omittedStepCount ? `另有 ${result.omittedStepCount} 个步骤未在图中展示。` : ''}请缩小时间范围；摘要可能不完整。</p>}
      {result.topics.length === 0 ? <div className="conversation-map-empty"><h2>暂无可展示的交流脉络</h2><p>{result.analyzedTurnCount ? '当前记录不足以形成有证据支持的主题。可以扩大时间范围后重试。' : '所选范围内暂无符合条件的文本对话。可以调整时间或数据范围后重试。'}</p></div> : <div className="conversation-map-columns">
        <section className="conversation-map-card" aria-labelledby="map-overview-title"><h2 id="map-overview-title">思维导图总览 <small>{result.topics.length} 个主题</small></h2>
          <ConversationMapDiagram code={overviewCode} label="交流主题思维导图，完整内容与选择入口见下方主题列表" testId="conversation-map-overview-diagram" />
          <ul className="conversation-map-topics" aria-label="主题列表">{result.topics.map((item) => <li key={item.id}><button type="button" aria-pressed={topic?.id === item.id} onClick={() => { setSelectedTopicId(item.id); setSelectedStepId(''); }}><strong>{item.title}</strong><span>{item.summary}</span>{item.subtopics.length > 0 && <span>{item.subtopics.join(' · ')}</span>}<small>{item.steps.length} 个交流步骤</small></button></li>)}</ul>
        </section>
        {topic && <section className="conversation-map-card" aria-labelledby="map-topic-title"><h2 id="map-topic-title">{topic.title}</h2><p>{topic.summary}</p>
          <ConversationMapDiagram code={flowCode} label="主题交流流程图，按时间排序的完整内容见下方交流步骤" testId="conversation-map-flow-diagram" />
          <p className="conversation-map-help">时间先后仅表示记录顺序；相关讨论不表示因果或已执行的决定。</p>
          <ol className="conversation-map-steps" aria-label="交流步骤">{steps.map((item) => <li key={item.id}><button type="button" aria-pressed={step?.id === item.id} onClick={() => setSelectedStepId(item.id)}><span className={`conversation-map-step-kind ${item.kind}`}>{stepLabels[item.kind]}</span><time dateTime={item.occurredAt}>{localTime(item.occurredAt)}</time><span>{item.text}</span>{topic.links.filter((link) => link.to === item.id).map((link, index) => <small key={index}>{relationLabels[link.relation]} · {steps.find((candidate) => candidate.id === link.from)?.text}</small>)}</button></li>)}</ol>
        </section>}
      </div>}
      {step && <section className="conversation-map-card conversation-map-evidence" aria-label="节点信息"><div><h2>{stepLabels[step.kind]}</h2><time dateTime={step.occurredAt}>{localTime(step.occurredAt)}</time><p>{step.text}</p></div>
        <div className="conversation-map-reference-buttons">{step.references.map((reference) => <button type="button" key={`${reference.sessionId}:${reference.entryId}`} disabled={running} onClick={() => void readSource(reference)}>{reference.role === 'user' ? '用户原文' : 'AI 回复原文'} · {localTime(reference.createdAt)}</button>)}</div>
        {source && <section className="conversation-map-source" aria-label="原始证据">
          {source.status === 'loading' && <p role="status">正在核对原始记录…</p>}
          {source.status === 'error' && <p role="alert">{source.error}</p>}
          {source.value?.available === false && <p role="status">原始记录已不可用。可能已删除或访问权限已变化，请重新生成。</p>}
          {source.value?.available && <><h3>{source.value.reference.role === 'user' ? '用户问题 / 反馈' : 'AI 观点 / 建议'}</h3><time dateTime={source.value.reference.createdAt}>{localTime(source.value.reference.createdAt)}</time><pre>{source.value.text}</pre>{source.value.truncated && <p>内容过长，此处仅展示部分原文。</p>}<button type="button" disabled={jumping} onClick={() => void jumpToSource()}>{jumping ? '正在核对…' : '查看原始对话'}</button></>}
        </section>}
      </section>}
    </>}
  </section>;
}

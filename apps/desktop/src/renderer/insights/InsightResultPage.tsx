import React, { useEffect, useState } from 'react';
import type { InsightResult, MessageReference } from '@desktop-agent/contracts';
import { InsightCard } from './InsightCard';
import { localTime, perspectiveLabels } from './state';

const perspectiveEvidence = {
  reverse_thinking: { missing: '可检验的具体问题、方案、观点或约束', scope: '具体问题、方案、观点、约束或决定' },
  second_order: { missing: '可推演影响的明确方案或探讨备选方案的问题', scope: '明确方案、计划、决定、改选，或探讨备选方案的问题' },
  blind_spots: { missing: '可分析的具体问题、观点、约束或方案', scope: '具体问题、观点、约束或方案' }
};

export function InsightResultPage({ result, stale, running, onReadSource, onRegenerate, onOpenModelSettings }: {
  result: InsightResult; stale: boolean; running: boolean; onReadSource(reference: MessageReference): void;
  onRegenerate(): void; onOpenModelSettings(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setExpanded(false); }, [result]);
  const cards = expanded ? result.cards : result.cards.slice(0, 4);
  const coverage = result.coverage;
  const hasOmittedTurns = result.omittedTurnCount > 0;
  const failedExtraction = hasOmittedTurns || (coverage?.omittedEventCount ?? 0) > 0 || !!coverage?.topicGroupingIncomplete;
  const limitedInput = !!coverage && (coverage.truncatedUserMessageCount > 0 || coverage.unknownSourceTruncation
    || coverage.selectedEventCount < coverage.eligibleEventCount);
  const incomplete = coverage ? failedExtraction || limitedInput || coverage.omittedCardCount > 0 : result.truncated || hasOmittedTurns;
  const emptyReason = result.emptyReason ?? (incomplete ? 'incomplete_analysis' : result.analyzedTurnCount ? 'no_supported_insights' : 'no_history');
  const retryable = coverage ? failedExtraction : incomplete;
  const filteredBeforeAnalysis = result.analyzedTurnCount > 0
    && !!coverage && !coverage.analysisPerformed && coverage.eligibleEventCount === 0;
  const evidence = perspectiveEvidence[result.perspective];
  const sourceNotes = coverage ? [
    coverage.truncatedUserMessageCount > 0 ? `${coverage.truncatedUserMessageCount} 条用户输入仅分析了部分内容` : '',
    coverage.truncatedAssistantMessageCount > 0 ? `${coverage.truncatedAssistantMessageCount} 条 AI 回复仅分析了部分内容` : '',
    coverage.omittedAssistantMessageCount > 0 ? `${coverage.omittedAssistantMessageCount} 条 AI 回复因内容上限未纳入` : '',
    coverage.unknownSourceTruncation ? '另有部分来源读取范围受限' : ''
  ].filter(Boolean) : [];
  const emptyHeading = emptyReason === 'no_eligible_events' ? `尚未提取到${evidence.missing}`
    : emptyReason === 'no_history' ? '所选范围内暂无足够历史内容'
      : emptyReason === 'no_supported_insights' ? '未找到有充分证据的洞察'
        : hasOmittedTurns ? '部分对话分析未完成，暂时无法形成洞察' : '分析结果不完整，暂时无法形成洞察';
  return <section aria-label="洞察结果">
    <div className="conversation-map-result-meta"><strong>{perspectiveLabels[result.perspective]} · {result.scopeKind === 'project' ? '当前项目' : '个人主对话'}</strong>
      <span>{localTime(result.rangeStart)} — {localTime(result.rangeEnd)}</span><span>已分析 {result.analyzedTurnCount} 轮 · {result.analyzedSessionCount} 个会话</span>
    </div>
    {stale && <p className="conversation-map-notice warning" role="status">筛选条件、视角或当前项目已更改。下方是上一次范围的结果，请重新生成后查看原文。</p>}
    {sourceNotes.length > 0 && <p className="conversation-map-notice insight-source-limits" role="status">{sourceNotes.join('；')}。{coverage!.truncatedUserMessageCount === 0 && !coverage!.unknownSourceTruncation ? '用户输入已完整读取。' : ''}相同范围的读取上限不会因重试而改变。</p>}
    {incomplete && <p className="conversation-map-notice warning" role="status">本次分析不完整：{hasOmittedTurns ? `另有 ${result.omittedTurnCount} 轮未分析。`
      : !coverage ? '部分来源或候选事件被截断或未通过校验。'
        : coverage.topicGroupingIncomplete ? '相关讨论的主题归并未完成。'
          : coverage.omittedEventCount > 0 ? `${coverage.omittedEventCount} 条候选事件未通过校验或超出处理上限。`
          : limitedInput ? '部分用户输入或可分析事件受到读取限制。' : '部分洞察卡片未通过校验。'}结论仅基于已分析的记录。</p>}
    {coverage && <details className="insight-analysis-details">
      <summary>分析详情</summary>
      <p>事件指从对话中提取的问题、观点、约束、方案等内容。</p>
      <dl>
        <div><dt>提取到的事件</dt><dd>{coverage.extractedEventCount}</dd></div>
        {coverage.userEventCount !== undefined && <div><dt>用户事件</dt><dd>{coverage.userEventCount}</dd></div>}
        {coverage.assistantEventCount !== undefined && <div><dt>AI 回复事件</dt><dd>{coverage.assistantEventCount}</dd></div>}
        <div><dt>符合当前视角</dt><dd>{coverage.eligibleEventCount}</dd></div>
        <div><dt>实际用于分析的用户事件</dt><dd>{coverage.selectedEventCount}</dd></div>
        <div><dt>未保留的候选事件</dt><dd>{coverage.omittedEventCount}</dd></div>
        <div><dt>未通过校验的卡片</dt><dd>{coverage.omittedCardCount}</dd></div>
        <div><dt>未分析的对话轮次</dt><dd>{result.omittedTurnCount}</dd></div>
        <div><dt>部分读取的用户输入</dt><dd>{coverage.truncatedUserMessageCount}</dd></div>
        <div><dt>部分读取的 AI 回复</dt><dd>{coverage.truncatedAssistantMessageCount}</dd></div>
        <div><dt>未纳入的 AI 回复</dt><dd>{coverage.omittedAssistantMessageCount}</dd></div>
        <div><dt>洞察生成模型</dt><dd>{coverage.analysisPerformed ? '已调用' : '未调用'}</dd></div>
        <div><dt>语义抽取缓存</dt><dd>{result.semanticCacheHit ? '已复用' : '未复用'}</dd></div>
      </dl>
    </details>}
    {!result.cards.length ? <div className="conversation-map-empty">
      <h2>{emptyHeading}</h2>
      {filteredBeforeAnalysis && <p>{coverage!.userEventCount === 0 && (coverage!.assistantEventCount ?? 0) > 0 ? '当前保留的事件均来自 AI 回复；用户输入尚未提取出可用于此视角的事件。'
        : (coverage!.userEventCount ?? 0) > 0 ? `当前保留的 ${coverage!.userEventCount} 条用户事件中，尚未找到${evidence.missing}。`
          : `尚未从用户输入中提取到${evidence.missing}。`}本次未调用洞察生成模型。</p>}
      {emptyReason === 'incomplete_analysis' ? <>
        <p>{retryable ? filteredBeforeAnalysis ? `部分来源、候选事件或主题归并未完成，暂时不能判断整个范围是否存在可分析内容。可以重新生成以重试未完成的抽取或归并，也可以选择包含${evidence.scope}的范围，或尝试其他视角。`
          : <>{hasOmittedTurns ? '重新生成会重新分析所选范围，包括本次未能分析的对话。' : '部分来源或候选事件未能完整保留，当前结果无法判断是否有充分证据支持洞察。请重新生成。'}也可以在模型设置中检查或切换分析模型后重试。</>
          : '本次仅分析了部分用户输入或候选事件，暂时无法判断该范围是否有充分证据。相同范围重复生成不会改变读取上限；可以结合原始对话查看，或选择更聚焦的范围。'}</p>
        {retryable && <><button type="button" disabled={running} onClick={onRegenerate}>{running ? '正在分析…' : '重新生成'}</button>{' '}
          {!filteredBeforeAnalysis && <button type="button" disabled={running} onClick={onOpenModelSettings}>检查模型配置</button>}</>}
      </> : emptyReason === 'no_eligible_events' ? <p>可以选择包含{evidence.scope}的时间或项目范围，也可以返回洞察中心尝试其他视角。</p>
        : <p>{emptyReason === 'no_supported_insights' ? '已分析符合当前视角的记录，未形成有充分证据的洞察，可以尝试其他视角。' : '可以调整时间或数据范围后重试。'}</p>}
    </div>
      : <><div className="insight-cards">{cards.map(card => <InsightCard key={card.id} card={card} disabled={stale || running} onReadSource={onReadSource} />)}</div>
        {result.cards.length > 4 && <button className="insight-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起更多洞察' : `展开其余 ${result.cards.length - 4} 条洞察`}</button>}</>}
  </section>;
}

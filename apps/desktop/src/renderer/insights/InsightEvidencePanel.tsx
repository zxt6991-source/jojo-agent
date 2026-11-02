import React from 'react';
import type { InsightSourceInput, InsightSourceResult } from '@desktop-agent/contracts';
import { localTime } from './state';

export type InsightSourceView = { input: InsightSourceInput; status: 'loading' | 'ready' | 'error'; value?: InsightSourceResult; error?: string };
export function InsightEvidencePanel({ source, jumping, onJump, onClose }: {
  source: InsightSourceView; jumping: boolean; onJump(): void; onClose(): void;
}) {
  return <section className="conversation-map-card conversation-map-source insight-evidence" aria-label="原始证据" aria-live="polite">
    <div className="insight-evidence-heading"><h2>原始证据</h2><button type="button" onClick={onClose}>收起原文</button></div>
    {source.status === 'loading' && <p role="status">正在核对原始记录…</p>}
    {source.status === 'error' && <p role="alert">{source.error}</p>}
    {source.value?.available === false && <p role="status">引用不可用：原文可能已删除或访问权限已变化。</p>}
    {source.value?.available && <><h3>{source.value.reference.role === 'user' ? '用户问题 / 反馈' : 'AI 观点 / 建议'}</h3>
      <time dateTime={source.value.reference.createdAt}>{localTime(source.value.reference.createdAt)}</time>
      <pre>{source.value.text}</pre>{source.value.truncated && <p>内容过长，仅展示部分原文。</p>}
      <button type="button" disabled={jumping} onClick={onJump}>{jumping ? '正在核对…' : '查看原始对话'}</button>
    </>}
  </section>;
}

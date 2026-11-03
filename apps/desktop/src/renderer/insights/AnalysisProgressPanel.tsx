import React, { useEffect, useState } from 'react';
import type { InsightPerspective } from '@desktop-agent/contracts';
import { analysisCount, analysisDuration, analysisSteps, analysisStepStatus, type AnalysisProgress, type AnalysisProgressHistory } from './analysis-progress';
import './analysis-progress.css';

/** Mount once per request. Progress comes only from worker events; the clock measures waiting time. */
export function AnalysisProgressPanel({ perspective, progress, history = {} }: {
  perspective: InsightPerspective;
  progress?: AnalysisProgress | undefined;
  history?: AnalysisProgressHistory | undefined;
}) {
  const [startedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState({ total: 0, quiet: 0 });
  useEffect(() => {
    const updatedAt = Date.now();
    const tick = () => setElapsed({ total: Math.floor((Date.now() - startedAt) / 1000), quiet: Math.floor((Date.now() - updatedAt) / 1000) });
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, progress]);
  const steps = analysisSteps(perspective);
  const phase = progress?.phase ?? 'reading';
  const current = steps.find(step => step.phase === phase) ?? steps[0]!;
  const count = analysisCount(progress);
  const hasTotal = phase !== 'analyzing' && progress?.total !== undefined && progress.total > 0 && progress.completed !== undefined;
  const fraction = hasTotal ? Math.min(1, Math.max(0, progress.completed! / progress.total!)) : undefined;

  return <section className="analysis-progress" aria-label="分析过程">
    <div className="analysis-progress-header"><span className="analysis-progress-eyebrow"><span className="analysis-progress-pulse" aria-hidden="true" />正在分析</span>
      <span className="analysis-progress-time" aria-live="off">已用时 {analysisDuration(elapsed.total)}</span></div>
    <div className="analysis-progress-current" role="status" aria-live="polite" aria-atomic="true">
      <h2>{current.label}<span aria-hidden="true">…</span></h2>
      <p>{current.description}</p>
      <div className="analysis-progress-detail">{progress?.detail && <span>{progress.detail}</span>}{count && <strong>{count}</strong>}</div>
    </div>
    <div className="analysis-progress-track" role="progressbar" aria-label={perspective === 'conversation_map' ? '脉络生成进度' : '洞察生成进度'}
      aria-valuetext={`${current.label}${count ? `，${count}` : ''}`}
      {...(hasTotal ? { 'aria-valuemin': 0, 'aria-valuemax': progress.total, 'aria-valuenow': Math.min(progress.completed!, progress.total!) } : {})}>
      <span className={hasTotal ? 'determinate' : 'indeterminate'} style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }} />
    </div>
    <ol className="analysis-progress-steps" aria-label="分析步骤">{steps.map((step, index) => {
      const status = analysisStepStatus(step.phase, phase, history, steps);
      const previous = history[step.phase];
      return <li key={step.phase} data-phase={step.phase} data-status={status} aria-current={status === 'active' ? 'step' : undefined}>
        <span className="analysis-progress-marker" aria-hidden="true">{status === 'done' ? '✓' : index + 1}</span>
        <div><div className="analysis-progress-step-heading"><strong>{step.label}</strong><small>{status === 'active' ? '进行中' : status === 'done' ? '已处理' : status === 'skipped' ? '未执行' : '待处理'}</small></div>
          {status === 'done' && (previous?.detail || analysisCount(previous)) && <p>{previous?.detail ?? analysisCount(previous)}</p>}
        </div>
      </li>;
    })}</ol>
    {elapsed.quiet >= 30 && <p className="analysis-progress-wait" role="status">此步骤耗时较长，仍在等待处理结果。你可以继续等待或取消生成。</p>}
  </section>;
}

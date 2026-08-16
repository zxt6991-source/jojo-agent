import React, { memo, useEffect, useMemo, useState } from 'react';
import type { UsageTotals, WorkflowRunSnapshot, WorkflowStepSnapshot } from '@desktop-agent/contracts';
import { Markdown } from './ConversationViews';
import { workflowStateLabel, workflowStepStateLabel } from './workflow-state';

function duration(startedAt?: string, finishedAt?: string, now = Date.now()): string {
  if (!startedAt) return '';
  const milliseconds = Math.max(0, (finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt));
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1_000;
  return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function usageText(usage: UsageTotals): string {
  const parts = [`↑${usage.inputTokens}`, `↓${usage.outputTokens}`];
  if (usage.cacheReadInputTokens) parts.push(`缓存读 ${usage.cacheReadInputTokens}`);
  if (usage.cacheWriteInputTokens) parts.push(`缓存写 ${usage.cacheWriteInputTokens}`);
  return parts.join(' · ');
}

function startedAtText(startedAt?: string): string {
  if (!startedAt) return '尚未开始';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(startedAt));
}

function StepStateIcon({ step }: { step: WorkflowStepSnapshot }) {
  const icon = step.state === 'completed' ? '✓'
    : step.state === 'running' ? '●'
      : step.state === 'failed' || step.state === 'timed_out' ? '×'
        : step.state === 'cancelled' ? '■'
          : step.state === 'blocked' ? '!'
            : '○';
  return <span className={`workflow-step-icon ${step.state}`} aria-hidden="true">{icon}</span>;
}

const WorkflowStepRow = memo(function WorkflowStepRow({ step, now }: { step: WorkflowStepSnapshot; now: number }) {
  const expandable = Boolean(step.output || step.error || step.errorCode);
  return <details className={`workflow-step ${step.state}`}>
    <summary aria-disabled={!expandable}>
      <StepStateIcon step={step} />
      <span className="workflow-step-name">{step.id}</span>
      <span className="workflow-step-state">{workflowStepStateLabel(step.state)}{step.incomplete ? ' · 不完整' : ''}</span>
      <span className="workflow-step-duration">{duration(step.startedAt, step.finishedAt, now)}</span>
      <span className="workflow-step-usage">{step.usage.inputTokens || step.usage.outputTokens ? usageText(step.usage) : ''}</span>
      {expandable && <span className="workflow-step-chevron" aria-hidden="true">›</span>}
    </summary>
    {expandable && <div className="workflow-step-detail">
      {(step.error || step.errorCode) && <div className="workflow-step-error"><strong>错误</strong><span>
        {step.errorCode && <code className={`workflow-error-code ${step.errorCode}`}>{step.errorCode}</code>}
        {step.error && <span>{step.error}</span>}
      </span></div>}
      {step.output && <div className="workflow-step-output"><strong>输出</strong><Markdown text={step.output} /></div>}
    </div>}
  </details>;
});

export function WorkflowCard({ workflow, onCancel, onResume }: {
  workflow: WorkflowRunSnapshot;
  onCancel: (workflow: WorkflowRunSnapshot) => Promise<void>;
  onResume: (workflow: WorkflowRunSnapshot) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(workflow.state === 'running');
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (workflow.state !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [workflow.state]);
  useEffect(() => {
    if (workflow.state === 'failed' || workflow.state === 'timed_out' || workflow.state === 'interrupted') setExpanded(true);
  }, [workflow.state]);

  const completed = workflow.steps.filter((step) => step.state === 'completed').length;
  const progress = workflow.steps.length ? Math.round((completed / workflow.steps.length) * 100) : 0;
  const elapsed = duration(workflow.startedAt, workflow.finishedAt, now);
  const statusClass = workflow.state.replace('_', '-');
  const summary = useMemo(() => `${completed} / ${workflow.steps.length} 步骤`, [completed, workflow.steps.length]);

  return <section className={`workflow-card ${statusClass}`} aria-label={`工作流 ${workflow.name}`}>
    <header className="workflow-card-header">
      <button type="button" className="workflow-card-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="workflow-card-mark" aria-hidden="true">{workflow.state === 'running' ? '●' : workflow.state === 'completed' ? '✓' : '!'}</span>
        <span className="workflow-card-heading">
          <strong>{workflow.name}</strong>
          <span>{workflowStateLabel(workflow.state)} · {summary}{elapsed ? ` · ${elapsed}` : ''}</span>
          <span className="workflow-card-meta">
            <code title={workflow.id}>{workflow.id}</code>
            <time dateTime={workflow.startedAt ?? workflow.createdAt}>开始于 {startedAtText(workflow.startedAt ?? workflow.createdAt)}</time>
          </span>
        </span>
        <span className="workflow-card-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>
      </button>
      {workflow.state === 'running' && <button type="button" className="workflow-cancel" disabled={cancelling} onClick={async () => {
        setCancelling(true);
        try { await onCancel(workflow); }
        finally { setCancelling(false); }
      }}>{cancelling ? '取消中…' : '取消'}</button>}
      {['interrupted', 'failed', 'timed_out', 'cancelled'].includes(workflow.state) && <button type="button" className="workflow-resume" disabled={resuming} onClick={async () => {
        setResuming(true);
        try { await onResume(workflow); }
        finally { setResuming(false); }
      }}>{resuming ? '恢复中…' : '恢复'}</button>}
    </header>
    <div className="workflow-progress" aria-label={`工作流进度 ${progress}%`}><span style={{ width: `${progress}%` }} /></div>
    {expanded && <div className="workflow-card-body">
      <div className="workflow-step-list">{workflow.steps.map((step) => <WorkflowStepRow key={step.id} step={step} now={step.state === 'running' ? now : 0} />)}</div>
      <div className="workflow-summary-row"><span>总 Usage</span><strong>{usageText(workflow.usage)}</strong></div>
      {(workflow.error || workflow.errorCode) && <div className="workflow-error"><strong>工作流错误</strong><span>
        {workflow.errorCode && <code className={`workflow-error-code ${workflow.errorCode}`}>{workflow.errorCode}</code>}
        {workflow.error && <span>{workflow.error}</span>}
      </span></div>}
      {workflow.result && <details className="workflow-result"><summary>最终结果{workflow.incomplete ? ' · 不完整' : ''}</summary><Markdown text={workflow.result} /></details>}
    </div>}
  </section>;
}

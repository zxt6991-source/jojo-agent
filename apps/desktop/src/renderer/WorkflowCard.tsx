import React, { memo, useEffect, useMemo, useState } from 'react';
import type { IsolationSnapshot, UsageTotals, WorkflowBudget, WorkflowRunSnapshot, WorkflowStepSnapshot } from '@desktop-agent/contracts';
import { Markdown } from './ConversationViews';
import { layoutWorkflowDag, layoutWorkflowTimeline } from './workflow-dag';
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

function estimatedCostUsd(budget: WorkflowBudget, usage: UsageTotals): number | undefined {
  if (budget.inputUsdPerMillion === undefined || budget.outputUsdPerMillion === undefined) return undefined;
  return (
    (usage.inputTokens + usage.cacheReadInputTokens) * budget.inputUsdPerMillion
    + (usage.outputTokens + usage.cacheWriteInputTokens) * budget.outputUsdPerMillion
  ) / 1_000_000;
}

function budgetText(budget: WorkflowBudget, usage: UsageTotals): string {
  const parts = [
    budget.maxInputTokens !== undefined ? `↑${usage.inputTokens}/${budget.maxInputTokens}` : `↑${usage.inputTokens}`,
    budget.maxOutputTokens !== undefined ? `↓${usage.outputTokens}/${budget.maxOutputTokens}` : `↓${usage.outputTokens}`
  ];
  if (budget.maxTotalTokens !== undefined) {
    parts.push(`Σ${usage.inputTokens + usage.outputTokens}/${budget.maxTotalTokens}`);
  }
  const cost = estimatedCostUsd(budget, usage);
  if (budget.maxCostUsd !== undefined && cost !== undefined) {
    parts.push(`$${cost.toFixed(4)}/$${budget.maxCostUsd}`);
  }
  return parts.join(' · ');
}

function isolationSummary(isolation?: IsolationSnapshot): string {
  if (!isolation) return '';
  if (isolation.hasChanges) {
    const files = isolation.changedFiles.length;
    return `${isolation.branch} · ${files} 个文件待审查`;
  }
  return isolation.cleanedUp ? `${isolation.branch} · 已清理` : isolation.branch;
}

function startedAtText(startedAt?: string): string {
  if (!startedAt) return '尚未开始';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(startedAt));
}

function structuredText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function StepStateIcon({ step }: { step: WorkflowStepSnapshot }) {
  const icon = step.state === 'completed' ? '✓'
    : step.state === 'running' ? '●'
      : step.state === 'failed' || step.state === 'timed_out' ? '×'
        : step.state === 'cancelled' ? '■'
          : step.state === 'blocked' ? '!'
            : step.state === 'skipped' ? '–'
              : '○';
  return <span className={`workflow-step-icon ${step.state}`} aria-hidden="true">{icon}</span>;
}

const WorkflowStepRow = memo(function WorkflowStepRow({
  step, now, nested = false, selected = false
}: {
  step: WorkflowStepSnapshot;
  now: number;
  nested?: boolean;
  selected?: boolean;
}) {
  const instances = step.instances ?? [];
  const child = step.child && typeof step.child === 'object' && 'steps' in step.child
    ? step.child as WorkflowRunSnapshot
    : undefined;
  const childSteps = child?.steps ?? [];
  const expandable = Boolean(
    step.output || step.structuredResult !== undefined || step.error || step.errorCode || step.stopReason
    || step.isolation || instances.length > 0 || childSteps.length > 0
  );
  const isolationText = isolationSummary(step.isolation);
  const completedInstances = instances.filter((instance) => instance.state === 'completed').length;
  const kind = step.type === 'foreach'
    ? (instances.length > 0 ? `foreach · ${completedInstances}/${instances.length}` : 'foreach')
    : step.type === 'condition' ? 'condition'
      : step.type === 'workflow' ? `workflow:${step.workflow ?? step.id}`
        : step.tool ? `tool:${step.tool}` : step.profile;
  const config = [
    kind,
    step.model,
    step.resourceGroup ? `group:${step.resourceGroup}` : '',
    isolationText,
    ...(step.attempt > 1 ? [`第 ${step.attempt} 次尝试`] : [])
  ].filter(Boolean).join(' · ');
  return <details className={`workflow-step ${nested ? 'workflow-step-instance ' : ''}${step.state}${selected ? ' selected' : ''}`} {...(selected ? { open: true } : {})}>
    <summary aria-disabled={!expandable}>
      <StepStateIcon step={step} />
      <span className="workflow-step-identity">
        <span className="workflow-step-name">{step.id}</span>
        {config && <span className="workflow-step-config">{config}</span>}
      </span>
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
      {step.structuredResult !== undefined && <div className="workflow-step-structured"><strong>结构化输出</strong><pre>{structuredText(step.structuredResult)}</pre></div>}
      {step.stopReason && !step.errorCode && <div className="workflow-step-meta"><strong>结束原因</strong><span>{step.stopReason}</span></div>}
      {step.isolation && <div className="workflow-step-isolation">
        <strong>隔离</strong>
        <div>
          <span>{step.isolation.hasChanges ? '待审查 · 不自动合并' : step.isolation.cleanedUp ? '无修改，已清理' : 'Worktree'}</span>
          <code>{step.isolation.branch}</code>
          {step.isolation.changedFiles.length > 0 && <span>{step.isolation.changedFiles.length} 个文件{step.isolation.truncated ? ' · 已截断' : ''}</span>}
          {step.isolation.diffStat && <pre className="workflow-step-diffstat">{step.isolation.diffStat}</pre>}
          {step.isolation.diff && <pre className="workflow-step-diff">{step.isolation.diff}</pre>}
        </div>
      </div>}
      {instances.length > 0 && <div className="workflow-step-instances">
        {instances.map((instance) => <WorkflowStepRow key={instance.id} step={instance} nested now={instance.state === 'running' ? now : 0} />)}
      </div>}
      {childSteps.length > 0 && <div className="workflow-step-child">
        {childSteps.map((child) => <WorkflowStepRow key={child.id} step={child} nested now={child.state === 'running' ? now : 0} />)}
      </div>}
    </div>}
  </details>;
});

const WorkflowDagView = memo(function WorkflowDagView({
  steps, selectedId, onSelect, now
}: {
  steps: WorkflowStepSnapshot[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
  now: number;
}) {
  const layout = useMemo(() => layoutWorkflowDag(steps), [steps]);
  const byId = useMemo(() => new Map(steps.map((step) => [step.id, step])), [steps]);
  return <div className="workflow-dag-scroll">
    <div className="workflow-dag" role="group" aria-label="工作流依赖图" style={{ width: layout.width, height: layout.height }}>
      <svg className="workflow-dag-edges" viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} aria-hidden="true">
        {layout.edges.map((edge) => (
          <path key={`${edge.from}->${edge.to}`} d={edge.d} className="workflow-dag-edge" data-from={edge.from} data-to={edge.to} />
        ))}
      </svg>
      {layout.nodes.map((node) => {
        const step = byId.get(node.id);
        if (!step) return null;
        const tokens = step.usage.inputTokens || step.usage.outputTokens ? usageText(step.usage) : '';
        const elapsed = duration(step.startedAt, step.finishedAt, now);
        return <button
          key={node.id}
          type="button"
          className={`workflow-dag-node ${step.state}${selectedId === node.id ? ' selected' : ''}`}
          style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
          onClick={() => onSelect(node.id)}
          aria-pressed={selectedId === node.id}
          aria-label={`${node.id} ${workflowStepStateLabel(step.state)}`}
        >
          <span className="workflow-dag-node-id">{node.id}</span>
          <span className="workflow-dag-node-meta">
            {workflowStepStateLabel(step.state)}
            {elapsed ? ` · ${elapsed}` : ''}
            {step.errorCode ? ` · ${step.errorCode}` : ''}
          </span>
          {(tokens || step.isolation?.branch) && <span className="workflow-dag-node-usage">
            {tokens || isolationSummary(step.isolation)}
          </span>}
        </button>;
      })}
    </div>
  </div>;
});

const WorkflowTimelineView = memo(function WorkflowTimelineView({
  workflow, now, selectedId, onSelect
}: {
  workflow: WorkflowRunSnapshot;
  now: number;
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
}) {
  const origin = workflow.startedAt ?? workflow.createdAt;
  const layout = useMemo(
    () => layoutWorkflowTimeline(workflow.steps, origin, now),
    [workflow.steps, origin, now]
  );
  const byId = useMemo(() => new Map(workflow.steps.map((step) => [step.id, step])), [workflow.steps]);
  if (layout.items.length === 0) {
    return <div className="workflow-timeline-empty">尚未开始任何步骤</div>;
  }
  return <div className="workflow-timeline" role="list" aria-label="工作流时间线">
    {layout.items.map((item) => {
      const step = byId.get(item.id);
      if (!step) return null;
      return <button
        key={item.id}
        type="button"
        className={`workflow-timeline-row ${step.state}${selectedId === item.id ? ' selected' : ''}`}
        onClick={() => onSelect(item.id)}
        aria-pressed={selectedId === item.id}
      >
        <span className="workflow-timeline-id">{item.id}</span>
        <span className="workflow-timeline-track">
          <span className={`workflow-timeline-bar ${step.state}`} style={{ left: `${item.left}%`, width: `${item.width}%` }} />
        </span>
        <span className="workflow-timeline-duration">{duration(step.startedAt, step.finishedAt, now)}</span>
      </button>;
    })}
  </div>;
});

export function WorkflowCard({ workflow, onCancel, onResume }: {
  workflow: WorkflowRunSnapshot;
  onCancel: (workflow: WorkflowRunSnapshot) => Promise<void>;
  onResume: (workflow: WorkflowRunSnapshot) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(workflow.state === 'running');
  const [view, setView] = useState<'dag' | 'timeline'>('dag');
  const [selectedStepId, setSelectedStepId] = useState<string | undefined>();
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

  const completed = workflow.steps.filter((step) => step.state === 'completed' || step.state === 'skipped').length;
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
      <div className="workflow-view-tabs view-tabs" role="tablist" aria-label="工作流视图">
        <button type="button" role="tab" className={view === 'dag' ? 'active' : ''} aria-selected={view === 'dag'} onClick={() => setView('dag')}>依赖图</button>
        <button type="button" role="tab" className={view === 'timeline' ? 'active' : ''} aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>时间线</button>
      </div>
      {view === 'dag'
        ? <WorkflowDagView steps={workflow.steps} selectedId={selectedStepId} onSelect={setSelectedStepId} now={now} />
        : <WorkflowTimelineView workflow={workflow} now={now} selectedId={selectedStepId} onSelect={setSelectedStepId} />}
      <div className="workflow-step-list">{workflow.steps.map((step) => <WorkflowStepRow
        key={step.id}
        step={step}
        now={step.state === 'running' ? now : 0}
        selected={selectedStepId === step.id}
      />)}</div>
      <div className="workflow-summary-row"><span>总 Usage</span><strong>{usageText(workflow.usage)}</strong></div>
      {workflow.budget && <div className="workflow-summary-row"><span>预算</span><strong>{budgetText(workflow.budget, workflow.usage)}</strong></div>}
      {workflow.memory && <div className="workflow-summary-row workflow-memory-binding">
        <span>Memory Snapshot</span>
        <strong><code>{workflow.memory.memorySnapshotId}</code> · frozen · {Object.entries(workflow.memory.scopeVersions)
          .map(([scope, version]) => `${scope}:${version}`).join(' · ')}</strong>
      </div>}
      {(workflow.error || workflow.errorCode) && <div className="workflow-error"><strong>工作流错误</strong><span>
        {workflow.errorCode && <code className={`workflow-error-code ${workflow.errorCode}`}>{workflow.errorCode}</code>}
        {workflow.error && <span>{workflow.error}</span>}
      </span></div>}
      {workflow.result && <details className="workflow-result"><summary>最终结果{workflow.incomplete ? ' · 不完整' : ''}</summary><Markdown text={workflow.result} /></details>}
    </div>}
  </section>;
}

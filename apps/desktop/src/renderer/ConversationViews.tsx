import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  firstLine,
  hasLiveOutput,
  type ConversationNode,
  type ConversationSnapshot,
  type ToolNode,
  type TrajectoryRecord
} from './conversation';

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function DisclosureRow({
  icon,
  title,
  summary,
  expandable,
  error,
  warning,
  running,
  children
}: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  expandable: boolean;
  error?: boolean;
  warning?: boolean;
  running?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expanded = expandable && open;
  return <div className={`disclosure ${running ? 'running' : ''} ${warning ? 'warning' : ''} ${error ? 'error' : ''}`}>
    <button
      type="button"
      className="disclosure-row"
      aria-expanded={expandable ? expanded : undefined}
      disabled={!expandable}
      onClick={() => expandable && setOpen((value) => !value)}
    >
      <span className="disclosure-leading" aria-hidden="true">{icon}</span>
      <span className="disclosure-title">{title}</span>
      {summary && <>
        <span className="disclosure-sep" aria-hidden="true" />
        <span className={`disclosure-summary ${warning ? 'warning' : ''} ${error ? 'error' : ''}`}>{summary}</span>
      </>}
      {expandable && <span className="disclosure-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span>}
    </button>
    {expanded && <div className="disclosure-body">{children}</div>}
  </div>;
}

function ToolIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
  </svg>;
}

function ToolRow({ node, onInspect }: { node: ToolNode; onInspect?: (id: string) => void }) {
  const expandable = Boolean(node.body || node.output || node.images.length);
  return <DisclosureRow
    icon={<ToolIcon />}
    title={node.title}
    summary={node.summary}
    expandable={expandable}
    error={node.state === 'error'}
    warning={node.state === 'warning'}
    running={node.state === 'running'}
  >
    <div className="tool-io">
      {node.body && <div className="tool-io-section"><span>IN</span><pre>{node.body}</pre></div>}
      {node.body && node.output && <span className="tool-io-divider" aria-hidden="true" />}
      {node.output && <div className="tool-io-section"><span>OUT</span><pre className={node.state === 'error' ? 'error' : node.state === 'warning' ? 'warning' : ''}>{node.output}</pre></div>}
      {node.images.length > 0 && <div className="rich-images tool-images">{node.images.map((image, index) => <img key={`${node.id}-${index}`} src={`data:${image.mimeType};base64,${image.data}`} alt={image.altText ?? '工具返回的图片'} />)}</div>}
    </div>
    {onInspect && <button type="button" className="tool-inspect" onClick={(event) => { event.stopPropagation(); onInspect(node.id); }}>在轨迹中查看</button>}
  </DisclosureRow>;
}

function ChatNodeView({
  node,
  onInspect,
  onOpenAutomation
}: {
  node: ConversationNode;
  onInspect?: (id: string) => void;
  onOpenAutomation?: (scheduleId: string) => void;
}) {
  if (node.kind === 'user') {
    return <article className="message user" data-node-id={node.id}>
      <div className="bubble">{node.images.length > 0 && <div className="rich-images">{node.images.map((image, index) => <figure key={`${node.id}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.altText ?? image.name ?? '用户图片'} />{image.name && <figcaption>{image.name}</figcaption>}</figure>)}</div>}{node.text && <Markdown text={node.text} />}</div>
    </article>;
  }
  if (node.kind === 'assistant') {
    return <article className={`message assistant ${node.streaming ? 'streaming' : ''} ${node.automation ? 'automation-message' : ''}`} data-node-id={node.id}>
      {node.automation && <header className="automation-message-header">
        <span aria-hidden="true">⏰</span>
        <div><strong>{node.automation.name}</strong><small>自动化 · {new Date(node.automation.triggeredAt).toLocaleString()}</small></div>
        {onOpenAutomation && <button type="button" onClick={() => onOpenAutomation(node.automation!.scheduleId)}>查看自动化</button>}
      </header>}
      <div className="bubble"><Markdown text={node.text} /></div>
    </article>;
  }
  if (node.kind === 'tool') {
    return <div className="chat-tool" data-node-id={node.id}><ToolRow node={node} {...(onInspect ? { onInspect } : {})} /></div>;
  }
  if (node.kind === 'compaction') {
    return <DisclosureRow icon={<span className="disclosure-mark">⌥</span>} title="上下文已压缩" summary={node.summary} expandable={Boolean(node.text)}>
      <pre className="system-body">{node.text}</pre>
    </DisclosureRow>;
  }
  return <DisclosureRow icon={<span className="disclosure-mark">i</span>} title={node.title} summary={firstLine(node.text)} expandable={Boolean(node.text)}>
    <pre className="system-body">{node.text}</pre>
  </DisclosureRow>;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}分${rest}秒` : `${minutes}分`;
}

function TurnStatus({ startedAt }: { startedAt: number | null }) {
  const [elapsed, setElapsed] = useState(() => startedAt ? Math.max(0, Date.now() - startedAt) : 0);
  useEffect(() => {
    const tick = () => setElapsed(startedAt ? Math.max(0, Date.now() - startedAt) : 0);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return <div className="turn-status" role="status" aria-live="polite">
    正在处理…
    {elapsed >= 15_000 && <span className="turn-status-clock">{formatElapsed(elapsed)}</span>}
  </div>;
}

export function ChatTranscript({
  snapshot,
  running,
  turnStartedAt,
  onInspect,
  onOpenAutomation,
  renderAfterTurn
}: {
  snapshot: ConversationSnapshot;
  running: boolean;
  turnStartedAt: number | null;
  onInspect?: (id: string) => void;
  onOpenAutomation?: (scheduleId: string) => void;
  renderAfterTurn?: (turn: ConversationSnapshot['turns'][number]) => React.ReactNode;
}) {
  const waiting = running && !hasLiveOutput(snapshot);
  return <div className="chat-transcript">
    {snapshot.turns.map((turn) => <React.Fragment key={turn.id}>
      {turn.nodes.map((node) => <ChatNodeView
        key={node.id}
        node={node}
        {...(onInspect ? { onInspect } : {})}
        {...(onOpenAutomation ? { onOpenAutomation } : {})}
      />)}
      {renderAfterTurn?.(turn)}
    </React.Fragment>)}
    {waiting && <TurnStatus startedAt={turnStartedAt} />}
  </div>;
}

const KIND_LABEL: Record<TrajectoryRecord['kind'], string> = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  compaction: '压缩',
  system: '系统'
};

export function TrajectoryView({
  snapshot,
  selectedId,
  onSelect
}: {
  snapshot: ConversationSnapshot;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = snapshot.records.find((record) => record.id === selectedId) ?? null;
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    const root = listRef.current;
    if (!root) return;
    for (const row of root.querySelectorAll<HTMLElement>('[data-record-id]')) {
      if (row.dataset.recordId === selectedId) {
        row.scrollIntoView({ block: 'nearest' });
        break;
      }
    }
  }, [selectedId]);
  return <div className={`trajectory ${selected ? 'inspecting' : ''}`}>
    <div className="trajectory-list" ref={listRef} role="table" aria-label="会话轨迹">
      {snapshot.turns.map((turn) => <section className="trajectory-turn" key={turn.id}>
        <header className="trajectory-turn-head">第 {turn.index} 轮</header>
        {turn.nodes.map((node) => {
          const record = snapshot.records.find((item) => item.id === node.id);
          if (!record) return null;
          return <button
            type="button"
            key={record.id}
            className={`trajectory-row ${record.id === selectedId ? 'selected' : ''}`}
            data-record-id={record.id}
            onClick={() => onSelect(record.id)}
          >
            <span className="trajectory-index">#{record.index}</span>
            <span className={`trajectory-loop ${record.finalResponseOnly ? 'final' : ''}`} aria-hidden={!record.iteration}>
              {record.iteration ? `L${record.iteration}${record.finalResponseOnly ? ' 收尾' : ''}` : ''}
            </span>
            <span className={`trajectory-tag ${record.kind}`}>{KIND_LABEL[record.kind]}</span>
            <span className="trajectory-text">{record.kind === 'tool' ? `${record.title} · ${record.summary}` : record.summary}</span>
            <span className={`trajectory-state ${record.state ?? ''}`} aria-hidden={!record.state}>{record.state === 'ok' ? '完成' : record.state === 'warning' ? '无进展' : record.state === 'error' ? '失败' : record.state === 'running' ? '进行中' : record.state === 'stopped' ? '中断' : ''}</span>
          </button>;
        })}
      </section>)}
      {snapshot.records.length === 0 && <div className="trajectory-empty">发送消息后，这里会按轮次列出用户、助手和工具记录。</div>}
    </div>
    {selected && <aside className="trajectory-inspect" aria-label="记录详情">
      <header>
        <span className={`trajectory-tag ${selected.kind}`}>{KIND_LABEL[selected.kind]}</span>
        <strong>{selected.title}</strong>
      </header>
      {selected.kind === 'assistant' || selected.kind === 'user' || selected.kind === 'compaction' || selected.kind === 'system'
        ? <div className="trajectory-inspect-body">{selected.body ? <Markdown text={selected.body} /> : <p className="trajectory-empty">没有可显示的内容。</p>}</div>
        : <div className="tool-io">
          {selected.body && <div className="tool-io-section"><span>IN</span><pre>{selected.body}</pre></div>}
          {selected.body && selected.output && <span className="tool-io-divider" aria-hidden="true" />}
          {selected.output && <div className="tool-io-section"><span>OUT</span><pre className={selected.state === 'error' ? 'error' : selected.state === 'warning' ? 'warning' : ''}>{selected.output}</pre></div>}
          {!selected.body && !selected.output && <p className="trajectory-empty">没有可显示的输入或输出。</p>}
        </div>}
    </aside>}
  </div>;
}

export function ConversationViewTabs({
  mode,
  onChange
}: {
  mode: 'chat' | 'trajectory';
  onChange: (mode: 'chat' | 'trajectory') => void;
}) {
  return <div className="view-tabs" role="tablist" aria-label="会话视图">
    <button type="button" role="tab" aria-selected={mode === 'chat'} className={mode === 'chat' ? 'active' : ''} onClick={() => onChange('chat')}>对话</button>
    <button type="button" role="tab" aria-selected={mode === 'trajectory'} className={mode === 'trajectory' ? 'active' : ''} onClick={() => onChange('trajectory')}>轨迹</button>
  </div>;
}

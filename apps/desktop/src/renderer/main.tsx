import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type {
  AgentEvent, ApprovalRequest, Message, ProviderSettings, SessionMeta, ToolResult, WorkspaceChanges
} from '@desktop-agent/contracts';
import { DEFAULT_SESSION_TITLE, projectNameFromDirectory } from '@desktop-agent/contracts';
import './styles.css';

type ToolCard = { id: string; name: string; input: unknown; progress: string; result?: ToolResult };
type DiffLine = { type: 'addition' | 'deletion' | 'context' | 'hunk' | 'meta'; oldLine?: number; newLine?: number; text: string };
type ProjectGroup = { path: string; name: string; sessions: SessionMeta[] };

const defaultSettings: ProviderSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  models: ['gpt-5-mini'],
  hasApiKey: false
};

function groupSessions(sessions: SessionMeta[]): ProjectGroup[] {
  const projects = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const existing = projects.get(session.workingDirectory);
    if (existing) existing.sessions.push(session);
    else projects.set(session.workingDirectory, {
      path: session.workingDirectory,
      name: projectNameFromDirectory(session.workingDirectory),
      sessions: [session]
    });
  }
  return [...projects.values()];
}

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function FolderIcon() {
  return <svg className="project-folder" viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2.5 5.75c0-1.1.9-2 2-2h3l1.45 1.7h6.55c1.1 0 2 .9 2 2v6.75c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V5.75Z" />
  </svg>;
}

function messageText(message: Message): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

function approvalTitle(request: ApprovalRequest): string {
  if (request.call.name === 'terminal') return '运行本地命令';
  if (request.call.name === 'read_file') return '读取工作区外的文件';
  if (request.preview) return `${request.preview.kind === 'create' ? '创建' : request.preview.kind === 'delete' ? '删除' : '修改'}文件`;
  return request.reason;
}

function approvalToolLabel(request: ApprovalRequest): string {
  if (request.call.name === 'terminal') return '终端';
  if (request.call.name === 'read_file') return '文件';
  if (request.preview) return '文件修改';
  return request.call.name;
}

function approvalQuestion(request: ApprovalRequest): string {
  if (request.call.name === 'terminal') return '是否允许运行此本地命令？';
  if (request.call.name === 'read_file') return '是否允许读取工作区外的文件？';
  if (request.preview) return `是否允许${approvalTitle(request)}？`;
  return `是否允许${approvalTitle(request)}？`;
}

function quoteCommandPart(value: string): string {
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function approvalSummary(request: ApprovalRequest): string {
  if (request.preview) return request.preview.path;
  const input = request.call.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return JSON.stringify(input);
  const record = input as Record<string, unknown>;
  if (request.call.name === 'terminal' && typeof record.command === 'string') {
    const args = Array.isArray(record.args) ? record.args.filter((part): part is string => typeof part === 'string') : [];
    return [record.command, ...args].map(quoteCommandPart).join(' ');
  }
  if (request.call.name === 'read_file' && typeof record.path === 'string') return record.path;
  return JSON.stringify(input, null, 2);
}

function ApprovalDiff({ request }: { request: ApprovalRequest }) {
  if (!request.preview) return null;
  const lines = parseDiff(request.preview.patch);
  return <div className="approval-diff-wrap">
    <div className="approval-diff-head">
      <span title={request.preview.path}>{request.preview.path}</span>
      <strong><b>+{request.preview.additions}</b><i>-{request.preview.deletions}</i></strong>
    </div>
    <div className="approval-diff diff-view" role="table" aria-label={`${request.preview.path} 的待批准差异`}>
      {lines.map((line, index) => <div className={`diff-line ${line.type}`} role="row" key={`${index}-${line.text}`}>
        <span className="diff-number">{line.oldLine ?? ''}</span><span className="diff-number">{line.newLine ?? ''}</span><code>{line.text || ' '}</code>
      </div>)}
    </div>
    {request.preview.truncated && <div className="diff-truncated">此差异过大，已截断显示。</div>}
  </div>;
}

function parseDiff(patch: string): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  return patch.split('\n').map((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { type: 'hunk', text };
    }
    if (text.startsWith('diff --git') || text.startsWith('index ') || text.startsWith('--- ') || text.startsWith('+++ ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('Binary file') || text === '[diff truncated]') {
      return { type: 'meta', text };
    }
    if (text.startsWith('+')) return { type: 'addition', newLine: newLine++, text };
    if (text.startsWith('-')) return { type: 'deletion', oldLine: oldLine++, text };
    const line = { type: 'context' as const, oldLine, newLine, text };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function changesSince(baseline: WorkspaceChanges, current: WorkspaceChanges): WorkspaceChanges {
  const previous = new Map(baseline.files.map((file) => [file.path, file.patch]));
  const files = current.files.filter((file) => previous.get(file.path) !== file.patch);
  return {
    ...current,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: current.truncated || files.some((file) => file.truncated)
  };
}

function WorkspaceChangesCard({ changes, onReview }: { changes: WorkspaceChanges; onReview: (path?: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  return <section className="changes-card" aria-label="当前文件修改">
    <div className="changes-card-head">
      <div className="changes-card-title"><span className="changes-icon">＋</span><div><strong>已编辑 {changes.files.length} 个文件</strong><span className="changes-total"><b>+{changes.additions}</b><i>-{changes.deletions}</i></span></div></div>
      <button onClick={() => onReview()}>审阅</button>
    </div>
    {expanded && <div className="changes-file-list">
      {changes.files.map((file) => <button key={file.path} onClick={() => onReview(file.path)}>
        <span title={file.path}>{file.path}</span><span className="change-counts"><b>+{file.additions}</b><i>-{file.deletions}</i></span>
      </button>)}
    </div>}
    <button className="changes-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起文件⌃' : '展开文件⌄'}</button>
  </section>;
}

function ReviewPanel({ changes, selectedPath, onSelect, onClose }: {
  changes: WorkspaceChanges;
  selectedPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const selected = changes.files.find((file) => file.path === selectedPath) ?? changes.files[0];
  if (!selected) return null;
  const lines = parseDiff(selected.patch);
  return <aside className="review-panel" aria-label="文件修改预览">
    <header className="review-header"><div><span>审阅</span><strong><b>+{changes.additions}</b> <i>-{changes.deletions}</i></strong></div><button aria-label="关闭审阅" title="关闭审阅" onClick={onClose}>×</button></header>
    <nav className="review-files" aria-label="已修改文件">
      {changes.files.map((file) => <button key={file.path} className={file.path === selected.path ? 'active' : ''} onClick={() => onSelect(file.path)}>
        <span title={file.path}>{file.path}</span><span><b>+{file.additions}</b> <i>-{file.deletions}</i></span>
      </button>)}
    </nav>
    <div className="review-file-head"><span>{selected.path}</span><strong><b>+{selected.additions}</b> <i>-{selected.deletions}</i></strong></div>
    <div className="diff-view" role="table" aria-label={`${selected.path} 的差异`}>
      {lines.map((line, index) => <div className={`diff-line ${line.type}`} role="row" key={`${index}-${line.text}`}>
        <span className="diff-number">{line.oldLine ?? ''}</span><span className="diff-number">{line.newLine ?? ''}</span><code>{line.text || ' '}</code>
      </div>)}
    </div>
    {selected.truncated && <div className="diff-truncated">此差异过大，已截断显示。</div>}
  </aside>;
}

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [tools, setTools] = useState<ToolCard[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings>(defaultSettings);
  const [settingsDraft, setSettingsDraft] = useState<ProviderSettings>(defaultSettings);
  const [selectedModel, setSelectedModel] = useState(defaultSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [modelsFresh, setModelsFresh] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChanges | null>(null);
  const [workspaceChangesError, setWorkspaceChangesError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const turnBaselineRef = useRef<WorkspaceChanges | null>(null);

  const refreshSessions = async () => {
    const next = await window.desktopAgent.listSessions();
    setSessions(next);
    if (!activeIdRef.current && next[0]) selectSession(next[0].id);
  };

  const loadWorkspaceChanges = async (id: string): Promise<WorkspaceChanges | null> => {
    try {
      const changes = await window.desktopAgent.getWorkspaceChanges(id);
      setWorkspaceChangesError('');
      return changes;
    } catch (cause) {
      setWorkspaceChangesError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };

  const selectSession = async (id: string) => {
    activeIdRef.current = id; turnBaselineRef.current = null; setActiveId(id); setError(''); setWorkspaceChangesError(''); setStreamingText(''); setTools([]); setReviewOpen(false); setWorkspaceChanges(null);
    const [nextMessages, nextChanges] = await Promise.all([
      window.desktopAgent.loadMessages(id),
      loadWorkspaceChanges(id)
    ]);
    if (activeIdRef.current !== id) return;
    setMessages(nextMessages);
    setWorkspaceChanges(nextChanges);
    setReviewPath(nextChanges?.files[0]?.path ?? '');
  };

  useEffect(() => {
    void refreshSessions();
    void window.desktopAgent.getSettings().then((saved) => {
      setSettings(saved);
      setSettingsDraft(saved);
      setSelectedModel(saved.model);
    });
    const offSessions = window.desktopAgent.onSessionsChanged(() => void refreshSessions());
    const offEvents = window.desktopAgent.onAgentEvent((event: AgentEvent) => {
      if (event.type === 'turn.started') { setRunning(true); setError(''); setStreamingText(''); setTools([]); }
      else if (event.type === 'text.delta') setStreamingText((text) => text + event.text);
      else if (event.type === 'tool.started') setTools((items) => [...items, { id: event.id, name: event.name, input: event.input, progress: '' }]);
      else if (event.type === 'tool.progress') setTools((items) => items.map((item) => item.id === event.id ? { ...item, progress: item.progress + event.text } : item));
      else if (event.type === 'tool.finished') setTools((items) => items.map((item) => item.id === event.id ? { ...item, result: event.result } : item));
      else if (event.type === 'approval.required') setApproval(event.request);
      else if (event.type === 'turn.failed') { setError(event.message); setRunning(false); setApproval(null); void reloadActive(); }
      else if (event.type === 'turn.completed' || event.type === 'turn.cancelled') { setRunning(false); setApproval(null); void reloadActive(); }
    });
    return () => { offSessions(); offEvents(); };
  }, []);

  useEffect(() => {
    const refreshVisibleChanges = () => {
      const id = activeIdRef.current;
      if (!id) return;
      void loadWorkspaceChanges(id).then((changes) => {
        if (activeIdRef.current !== id || !changes) return;
        const visibleChanges = turnBaselineRef.current ? changesSince(turnBaselineRef.current, changes) : changes;
        setWorkspaceChanges(visibleChanges);
        setReviewPath((current) => visibleChanges.files.some((file) => file.path === current) ? current : (visibleChanges.files[0]?.path ?? ''));
      });
    };
    const handleVisibility = () => { if (document.visibilityState === 'visible') refreshVisibleChanges(); };
    window.addEventListener('focus', refreshVisibleChanges);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('focus', refreshVisibleChanges);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  const reloadActive = async () => {
    const id = activeIdRef.current;
    if (id) {
      const [nextMessages, nextChanges] = await Promise.all([
        window.desktopAgent.loadMessages(id),
        loadWorkspaceChanges(id)
      ]);
      if (activeIdRef.current === id) {
        setMessages(nextMessages);
        const visibleChanges = nextChanges && turnBaselineRef.current ? changesSince(turnBaselineRef.current, nextChanges) : nextChanges;
        setWorkspaceChanges(visibleChanges);
        setReviewPath((current) => visibleChanges?.files.some((file) => file.path === current) ? current : (visibleChanges?.files[0]?.path ?? ''));
        if (!visibleChanges?.files.length) setReviewOpen(false);
      }
    }
    setStreamingText(''); setTools([]);
  };

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamingText, tools, workspaceChanges]);

  useEffect(() => {
    if (!approval) return;
    const handleApprovalShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void window.desktopAgent.resolveApproval({ requestId: approval.requestId, allow: event.key === 'Enter' });
      setApproval(null);
    };
    window.addEventListener('keydown', handleApprovalShortcut, true);
    return () => window.removeEventListener('keydown', handleApprovalShortcut, true);
  }, [approval]);

  const fetchProviderModels = async (): Promise<{ models: string[]; model: string } | null> => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const models = await window.desktopAgent.listModels({
        baseUrl: settingsDraft.baseUrl,
        ...(apiKey ? { apiKey } : {})
      });
      const model = models.includes(settingsDraft.model) ? settingsDraft.model : models[0]!;
      setSettingsDraft((current) => ({ ...current, model, models }));
      setModelsFresh(true);
      return { models, model };
    } catch (cause) {
      setModelsError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setModelsLoading(false);
    }
  };

  const createSessionForDirectory = async (directory: string) => {
    const session = await window.desktopAgent.createSession({ title: DEFAULT_SESSION_TITLE, workingDirectory: directory });
    setCollapsedProjects((items) => items.filter((path) => path !== directory));
    if (session) await selectSession(session.id);
  };

  const createProject = async () => {
    const directory = await window.desktopAgent.chooseDirectory();
    if (!directory) return;
    await createSessionForDirectory(directory);
  };

  const createSession = async () => {
    const activeSession = sessions.find((session) => session.id === activeIdRef.current);
    if (activeSession) await createSessionForDirectory(activeSession.workingDirectory);
    else await createProject();
  };

  const renameSession = async (session: SessionMeta) => {
    const title = prompt('会话名称', session.title);
    if (!title?.trim() || title.trim() === session.title) return;
    await window.desktopAgent.renameSession({ sessionId: session.id, title });
    await refreshSessions();
  };

  const deleteSession = async (session: SessionMeta) => {
    if (!confirm(`确定删除会话“${session.title}”？`)) return;
    const wasActive = activeIdRef.current === session.id;
    if (wasActive) {
      activeIdRef.current = null;
      setActiveId(null);
      setRunning(false);
      setApproval(null);
      setMessages([]);
      setWorkspaceChanges(null);
      setReviewOpen(false);
      setStreamingText('');
      setTools([]);
    }
    await window.desktopAgent.deleteSession(session.id);
    const remaining = sessions.filter((item) => item.id !== session.id);
    if (wasActive) {
      const next = remaining.find((item) => item.workingDirectory === session.workingDirectory) ?? remaining[0];
      if (next) await selectSession(next.id);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !activeId || running) return;
    setDraft(''); setError(''); setRunning(true); setStreamingText(''); setTools([]);
    setMessages((items) => [...items, { id: `pending-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), content: [{ type: 'text', text }] }]);
    try {
      turnBaselineRef.current = await loadWorkspaceChanges(activeId);
      await window.desktopAgent.startTurn({ sessionId: activeId, text, model: selectedModel });
    }
    catch (cause) { setRunning(false); setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const active = sessions.find((session) => session.id === activeId);
  const projects = useMemo(() => groupSessions(sessions), [sessions]);
  const openReview = (path?: string) => {
    if (!workspaceChanges?.files.length) return;
    setReviewPath(path ?? workspaceChanges.files[0]!.path);
    setReviewOpen(true);
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">⌁</span><span>Desktop Agent</span></div>
      <button className="new-session" onClick={() => void createSession()}><span aria-hidden="true">＋</span> 新对话</button>
      <div className="projects-heading"><span>项目</span><button aria-label="打开新项目目录" title="打开新项目目录" onClick={() => void createProject()}>＋</button></div>
      <div className="project-list">
        {projects.map((project) => {
          const collapsed = collapsedProjects.includes(project.path);
          return <section className="project-group" key={project.path}>
            <div className="project-row">
              <button className="project-toggle" title={project.path} onClick={() => setCollapsedProjects((items) => collapsed ? items.filter((path) => path !== project.path) : [...items, project.path])}>
                <FolderIcon /><span>{project.name}</span><span className="project-chevron" aria-hidden="true">{collapsed ? '›' : '⌄'}</span>
              </button>
              <button className="project-new-chat" aria-label={`在 ${project.name} 中新建会话`} title="在此项目中新建会话" onClick={() => void createSessionForDirectory(project.path)}>＋</button>
            </div>
            {!collapsed && <div className="project-sessions">
              {project.sessions.map((session) => <div key={session.id} className={`session-row ${session.id === activeId ? 'active' : ''}`}>
                <button className="session" title={session.title} onClick={() => void selectSession(session.id)}><span className="session-title">{session.title}</span></button>
                <div className="session-actions">
                  <button aria-label={`重命名 ${session.title}`} title="重命名会话" onClick={() => void renameSession(session)}>✎</button>
                  <button className="delete-session" aria-label={`删除 ${session.title}`} title="删除会话" onClick={() => void deleteSession(session)}>×</button>
                </div>
              </div>)}
            </div>}
          </section>;
        })}
        {projects.length === 0 && <div className="projects-empty">还没有项目</div>}
      </div>
      <button className="settings-button" onClick={() => { setSettingsDraft(settings); setApiKey(''); setModelsFresh(true); setModelsError(''); setSettingsOpen(true); }}>⚙ 设置</button>
    </aside>
    <main className="main-panel">
      {active ? <>
        <header className="topbar">
          <div><h1>{active.title}</h1><div className="working-directory">{active.workingDirectory}</div></div>
        </header>
        <div className={`workspace-content ${reviewOpen ? 'reviewing' : ''}`}>
        <div className="chat-pane">
        <section className="conversation">
          {messages.length === 0 && !running && <div className="empty"><div className="empty-icon">⌁</div><h2>从本地项目开始</h2><p>可以让我阅读文件、列出目录，或在你批准后执行命令。</p></div>}
          {messages.filter((message) => message.role !== 'tool').map((message) => <article key={message.id} className={`message ${message.role}`}>
            <div className="avatar">{message.role === 'user' ? '你' : 'A'}</div><div className="bubble"><Markdown text={messageText(message)} /></div>
          </article>)}
          {(streamingText || running) && <article className="message assistant"><div className="avatar">A</div><div className="bubble">
            {streamingText ? <Markdown text={streamingText} /> : tools.length === 0 && <span className="thinking">正在思考…</span>}
            {tools.map((tool) => <div className="tool-card" key={tool.id}>
              <div className="tool-head"><span>⌘ {tool.name}</span><span className={tool.result ? (tool.result.ok ? 'ok' : 'failed') : 'pending'}>{tool.result ? (tool.result.ok ? '完成' : '失败') : '进行中'}</span></div>
              <pre>{JSON.stringify(tool.input, null, 2)}</pre>{tool.progress && <pre className="tool-output">{tool.progress.slice(-5000)}</pre>}
              {tool.result && <div className="tool-result">{tool.result.content.slice(-2000)}</div>}
            </div>)}
          </div></article>}
          {error && <div className="error-banner">{error}</div>}
          {workspaceChangesError && <div className="changes-error">无法读取文件修改：{workspaceChangesError}</div>}
          {!running && messages.length > 0 && workspaceChanges && workspaceChanges.files.length > 0 && <WorkspaceChangesCard changes={workspaceChanges} onReview={openReview} />}
          <div ref={bottomRef} />
        </section>
        <footer className="composer-wrap"><div className="composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="随心输入" rows={2}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
          <div className="composer-toolbar">
            <div className="composer-context"><span className="approval-status">⌁ 文件修改与 Terminal 需批准</span></div>
            <div className="composer-actions">
              <select className="model-select" aria-label="本轮使用的模型" title="选择本轮使用的模型" value={selectedModel} disabled={running} onChange={(event) => setSelectedModel(event.target.value)}>
                {settings.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              {running
                ? <button className="stop" aria-label="停止生成" title="停止生成" onClick={() => activeId && window.desktopAgent.cancelTurn(activeId)}>■</button>
                : <button className="send" aria-label="发送消息" title="发送消息" disabled={!draft.trim()} onClick={() => void send()}>↑</button>}
            </div>
          </div>
        </div><div className="hint">Enter 发送 · Shift+Enter 换行</div></footer>
        </div>
        {reviewOpen && workspaceChanges && <ReviewPanel changes={workspaceChanges} selectedPath={reviewPath} onSelect={setReviewPath} onClose={() => setReviewOpen(false)} />}
        </div>
      </> : <section className="welcome"><div className="empty-icon">⌁</div><h1>Desktop Agent</h1><p>选择一个本地目录，开始安全、可控的 AI 协作。</p><button className="primary" onClick={() => void createProject()}>选择项目目录</button></section>}
    </main>
    {approval && <div className="approval-layer"><div className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval-tool"><span className="approval-tool-icon" aria-hidden="true">›_</span><span>{approvalToolLabel(approval)}</span></div>
      <h2 id="approval-title">{approvalQuestion(approval)}</h2>
      {approval.preview ? <ApprovalDiff request={approval} /> : <pre className="approval-command">{approvalSummary(approval)}</pre>}
      <div className="approval-actions">
        <button className="approval-reject" onClick={() => { void window.desktopAgent.resolveApproval({ requestId: approval.requestId, allow: false }); setApproval(null); }}><span>拒绝</span><kbd>Esc</kbd></button>
        <button className="approval-allow" onClick={() => { void window.desktopAgent.resolveApproval({ requestId: approval.requestId, allow: true }); setApproval(null); }}><span>允许一次</span><kbd>↵</kbd></button>
      </div>
    </div></div>}
    {settingsOpen && <div className="modal-backdrop"><form className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onSubmit={async (event) => {
      event.preventDefault();
      const fetched = modelsFresh ? { models: settingsDraft.models, model: settingsDraft.model } : await fetchProviderModels();
      if (!fetched) return;
      const saved = await window.desktopAgent.saveSettings({ baseUrl: settingsDraft.baseUrl, model: fetched.model, models: fetched.models, ...(apiKey ? { apiKey } : {}) });
      setSettings(saved);
      setSettingsDraft(saved);
      setSelectedModel((current) => saved.models.includes(current) ? current : saved.model);
      setApiKey('');
      setSettingsOpen(false);
    }}>
      <div className="modal-tag">模型配置</div><h2 id="settings-title">OpenAI 兼容 Provider</h2>
      <div className="settings-fields">
        <label>API Base URL<input required value={settingsDraft.baseUrl} onChange={(event) => { setSettingsDraft({ ...settingsDraft, baseUrl: event.target.value }); setModelsFresh(false); setModelsError(''); }} /></label>
        <label>API Key <span>{settings.hasApiKey ? '（已安全保存）' : ''}</span><input type="password" value={apiKey} placeholder={settings.hasApiKey ? '留空以保留当前密钥' : 'sk-…'} onChange={(event) => { setApiKey(event.target.value); setModelsFresh(false); setModelsError(''); }} /></label>
        <div className="model-setting">
          <div className="model-setting-head"><label htmlFor="default-model">默认模型</label><button type="button" disabled={modelsLoading} onClick={() => void fetchProviderModels()}>{modelsLoading ? '获取中…' : '刷新模型'}</button></div>
          <select id="default-model" required value={settingsDraft.model} disabled={modelsLoading} onChange={(event) => setSettingsDraft({ ...settingsDraft, model: event.target.value })}>
            {settingsDraft.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <div className={`models-status ${modelsError ? 'failed' : ''}`}>{modelsError || (modelsFresh ? `已获取 ${settingsDraft.models.length} 个模型` : 'Provider 配置已变化，保存时将自动重新获取')}</div>
        </div>
      </div>
      <p className="security-note">密钥由操作系统安全存储加密，不会写入普通配置或会话。</p>
      <div className="modal-actions"><button type="button" onClick={() => setSettingsOpen(false)}>取消</button><button className="primary" type="submit" disabled={modelsLoading}>保存</button></div>
    </form></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

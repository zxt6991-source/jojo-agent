import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionMeta } from '@desktop-agent/contracts';
import {
  COLLAPSED_SESSION_LIMIT,
  deriveSidebar,
  formatRelativeTime,
  type SidebarGroupBy,
  type SidebarSession
} from './sidebarSnapshot';

function FolderIcon({ open }: { open: boolean }) {
  return <svg className="project-folder" viewBox="0 0 20 20" aria-hidden="true">
    {open
      ? <path d="M2.5 5.75c0-1.1.9-2 2-2h3l1.45 1.7h6.55c1.1 0 2 .9 2 2v.4H4.2c-.8 0-1.5.55-1.7 1.32L2.5 14.7V5.75Z" />
      : <path d="M2.5 5.75c0-1.1.9-2 2-2h3l1.45 1.7h6.55c1.1 0 2 .9 2 2v6.75c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V5.75Z" />}
  </svg>;
}

function ViewIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3 4.5h10M3 8h10M3 11.5h10" />
  </svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.2 3.2" />
  </svg>;
}

function StatusDot({ status }: { status: SidebarSession['status'] }) {
  if (status === 'idle') return null;
  return <>
    <span className={`session-dot ${status}`} aria-hidden="true" />
    <span className="visually-hidden">{status === 'approval' ? '等待审批' : '正在运行'}</span>
  </>;
}

function SessionRow({
  session,
  active,
  now,
  flat,
  onOpen,
  onRename,
  onDelete
}: {
  session: SidebarSession;
  active: boolean;
  now: number;
  flat?: boolean;
  onOpen: (id: string) => void;
  onRename: (session: SidebarSession) => void;
  onDelete: (session: SidebarSession) => void;
}) {
  const showStatus = session.status !== 'idle';
  return <div
    className={`session-row ${active ? 'active' : ''} ${flat && !showStatus ? 'flat-no-status' : ''}`}
    title={!session.blank ? session.title : ''}
  >
    {(!flat || showStatus) && <span className="session-slot">{showStatus && <StatusDot status={session.status} />}</span>}
    <button className="session" onClick={() => onOpen(session.id)}>
      <span className="session-title">{session.title}</span>
    </button>
    {!session.blank && <span className="session-time">{formatRelativeTime(session.updatedAt, now)}</span>}
    <div className="session-actions">
      <button type="button" aria-label={`重命名 ${session.title}`} title="重命名会话" onClick={() => onRename(session)}>✎</button>
      <button type="button" className="delete-session" aria-label={`删除 ${session.title}`} title="删除会话" onClick={() => onDelete(session)}>×</button>
    </div>
  </div>;
}

export function Sidebar({
  sessions,
  activeId,
  runningSessionId,
  approvalSessionId,
  collapsedProjects,
  onToggleProject,
  onSelectSession,
  onCreateSession,
  onCreateProject,
  onCreateSessionForDirectory,
  onRenameSession,
  onDeleteSession,
  onOpenSettings
}: {
  sessions: SessionMeta[];
  activeId: string | null;
  runningSessionId: string | null;
  approvalSessionId: string | null;
  collapsedProjects: string[];
  onToggleProject: (path: string) => void;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onCreateProject: () => void;
  onCreateSessionForDirectory: (path: string) => void;
  onRenameSession: (session: SessionMeta) => void;
  onDeleteSession: (session: SessionMeta) => void;
  onOpenSettings: () => void;
}) {
  const [groupBy, setGroupBy] = useState<SidebarGroupBy>('workspace');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [overflowProjects, setOverflowProjects] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const searchRef = useRef<HTMLInputElement>(null);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);
  const snapshot = useMemo(() => deriveSidebar(sessions, {
    groupBy,
    query,
    collapsedProjects,
    overflowProjects,
    currentId: activeId,
    runningSessionId,
    approvalSessionId
  }), [sessions, groupBy, query, collapsedProjects, overflowProjects, activeId, runningSessionId, approvalSessionId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const close = (event: MouseEvent) => {
      if (query.trim() !== '') return;
      const root = searchRootRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setSearchOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [searchOpen, query]);

  useEffect(() => {
    if (!viewOpen) return;
    const close = (event: MouseEvent) => {
      const root = viewRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setViewOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [viewOpen]);

  const openSession = (id: string) => {
    const session = byId.get(id);
    if (session && collapsedProjects.includes(session.workingDirectory)) onToggleProject(session.workingDirectory);
    setQuery('');
    setSearchOpen(false);
    onSelectSession(id);
  };

  const rename = (row: SidebarSession) => {
    const session = byId.get(row.id);
    if (session) onRenameSession(session);
  };

  const remove = (row: SidebarSession) => {
    const session = byId.get(row.id);
    if (session) onDeleteSession(session);
  };

  const searching = query.trim() !== '';
  const heading = groupBy === 'flat' ? '会话' : '项目';

  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark">⌁</span><span>Desktop Agent</span></div>
    <button className="new-session" onClick={onCreateSession}><span aria-hidden="true">＋</span> 新对话</button>
    <div className={`projects-heading ${searchOpen ? 'searching' : ''}`}>
      <span className="projects-heading-label">{heading}</span>
      <div className={`sidebar-search ${searchOpen ? 'open' : ''}`} ref={searchRootRef}>
        <button type="button" className="sidebar-icon-button" aria-label="搜索会话" aria-expanded={searchOpen} title="搜索会话" onClick={() => setSearchOpen(true)}>
          <SearchIcon />
        </button>
        <input
          ref={searchRef}
          value={query}
          tabIndex={searchOpen ? 0 : -1}
          placeholder="搜索会话"
          aria-label="搜索会话"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            setQuery('');
            setSearchOpen(false);
          }}
        />
        {searchOpen && <button type="button" className="sidebar-icon-button" aria-label="清除搜索" title="清除搜索" onClick={() => { setQuery(''); setSearchOpen(false); }}>×</button>}
      </div>
      <div className="projects-heading-actions">
        <div className="sidebar-view-menu" ref={viewRef}>
          <button type="button" className="sidebar-icon-button" aria-label="视图选项" title="视图选项" aria-expanded={viewOpen} onClick={() => setViewOpen((open) => !open)}><ViewIcon /></button>
          {viewOpen && <div className="sidebar-view-pop" role="menu">
            <button type="button" role="menuitemradio" aria-checked={groupBy === 'workspace'} className={groupBy === 'workspace' ? 'active' : ''} onClick={() => { setGroupBy('workspace'); setViewOpen(false); }}>按项目分组</button>
            <button type="button" role="menuitemradio" aria-checked={groupBy === 'flat'} className={groupBy === 'flat' ? 'active' : ''} onClick={() => { setGroupBy('flat'); setViewOpen(false); }}>单列表</button>
          </div>}
        </div>
        <button type="button" className="sidebar-icon-button" aria-label="打开新项目目录" title="打开新项目目录" onClick={onCreateProject}>＋</button>
      </div>
    </div>
    <div className="project-list" role="tree" aria-label={heading}>
      {searching && snapshot.search.map((session) => <button
        type="button"
        key={session.id}
        className={`search-result ${session.id === activeId ? 'active' : ''}`}
        onClick={() => openSession(session.id)}
      >
        <span className="search-result-head">
          <span className="session-slot">{session.status !== 'idle' && <StatusDot status={session.status} />}</span>
          <span className="session-title">{session.title}</span>
        </span>
        <span className="search-result-meta">{session.workspace}</span>
      </button>)}
      {searching && snapshot.search.length === 0 && <div className="projects-empty">没有匹配的会话</div>}
      {!searching && groupBy === 'flat' && snapshot.flat.map((session) => (
        <SessionRow key={session.id} session={session} active={session.id === activeId} now={now} flat onOpen={openSession} onRename={rename} onDelete={remove} />
      ))}
      {!searching && groupBy === 'workspace' && snapshot.groups.map((group) => <section className="project-group" key={group.path}>
        <div className={`project-row ${group.containsCurrent && group.expanded ? 'current' : ''}`}>
          <button
            className="project-toggle"
            title={group.path}
            aria-expanded={group.expanded}
            onClick={() => {
              if (group.expanded) setOverflowProjects((items) => items.filter((path) => path !== group.path));
              onToggleProject(group.path);
            }}
          >
            <span className="project-lead">
              <span className="project-folder-slot"><FolderIcon open={group.expanded} /></span>
              <span className="project-chevron" aria-hidden="true">{group.expanded ? '⌄' : '›'}</span>
            </span>
            <span>{group.name}</span>
          </button>
          <button className="project-new-chat" aria-label={`在 ${group.name} 中新建会话`} title="在此项目中新建会话" onClick={() => {
            if (!group.expanded) onToggleProject(group.path);
            onCreateSessionForDirectory(group.path);
          }}>＋</button>
        </div>
        {group.expanded && <div className="project-sessions">
          {group.visibleSessions.map((session) => (
            <SessionRow key={session.id} session={session} active={session.id === activeId} now={now} onOpen={openSession} onRename={rename} onDelete={remove} />
          ))}
          {group.sessions.length > COLLAPSED_SESSION_LIMIT && (group.hiddenCount > 0 || group.userOverflow) && <button
            type="button"
            className="session-overflow"
            aria-expanded={group.overflowExpanded}
            onClick={() => setOverflowProjects((items) => items.includes(group.path) ? items.filter((path) => path !== group.path) : [...items, group.path])}
          >{group.userOverflow ? '收起' : `展开其余 ${group.hiddenCount} 个会话`}</button>}
        </div>}
      </section>)}
      {!searching && snapshot.groups.length === 0 && <div className="projects-empty">还没有项目</div>}
    </div>
    <div className="sidebar-settings">
      <button className="settings-button" onClick={onOpenSettings}>⚙ 设置</button>
    </div>
  </aside>;
}

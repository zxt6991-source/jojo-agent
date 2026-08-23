import { isPlaceholderSessionTitle, projectNameFromDirectory, sessionHasProject, type SessionMeta } from '@desktop-agent/contracts';

export const COLLAPSED_SESSION_LIMIT = 5;
export const SEARCH_RESULT_LIMIT = 20;
export const NO_PROJECT_GROUP_PATH = '';
export const NO_PROJECT_GROUP_NAME = '未选择项目';
export type SidebarGroupBy = 'workspace' | 'flat';
export type SessionRowStatus = 'idle' | 'running' | 'approval';
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years';

export type SidebarSession = {
  id: string;
  title: string;
  blank: boolean;
  updatedAt: number;
  status: SessionRowStatus;
  workspace: string;
  path: string;
};

export type SidebarGroup = {
  path: string;
  name: string;
  containsCurrent: boolean;
  expanded: boolean;
  overflowExpanded: boolean;
  userOverflow: boolean;
  sessions: SidebarSession[];
  visibleSessions: SidebarSession[];
  hiddenCount: number;
};

export type SidebarSnapshot = {
  groups: SidebarGroup[];
  flat: SidebarSession[];
  search: SidebarSession[];
};

export type SidebarView = {
  groupBy: SidebarGroupBy;
  query: string;
  collapsedProjects: readonly string[];
  overflowProjects: readonly string[];
  currentId: string | null;
  runningSessionId: string | null;
  approvalSessionId: string | null;
};

function byRecency(left: SidebarSession, right: SidebarSession): number {
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  return left.id < right.id ? -1 : 1;
}

export function relativeTime(updatedAt: number, now: number): { unit: RelativeTimeUnit; n: number } {
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  const diff = Math.max(0, now - updatedAt);
  if (diff < minute) return { unit: 'now', n: 0 };
  if (diff < hour) return { unit: 'minutes', n: Math.floor(diff / minute) };
  if (diff < day) return { unit: 'hours', n: Math.floor(diff / hour) };
  if (diff < 30 * day) return { unit: 'days', n: Math.floor(diff / day) };
  if (diff < 365 * day) return { unit: 'months', n: Math.floor(diff / (30 * day)) };
  return { unit: 'years', n: Math.floor(diff / (365 * day)) };
}

export function formatRelativeTime(updatedAt: number, now: number): string {
  const { unit, n } = relativeTime(updatedAt, now);
  if (unit === 'now') return '刚刚';
  if (unit === 'minutes') return `${n}分钟`;
  if (unit === 'hours') return `${n}小时`;
  if (unit === 'days') return `${n}天`;
  if (unit === 'months') return `${n}个月`;
  return `${n}年`;
}

export function sessionStatus(
  sessionId: string,
  runningSessionId: string | null,
  approvalSessionId: string | null
): SessionRowStatus {
  if (approvalSessionId === sessionId) return 'approval';
  if (runningSessionId === sessionId) return 'running';
  return 'idle';
}

export function toSidebarSession(
  session: SessionMeta,
  runningSessionId: string | null,
  approvalSessionId: string | null
): SidebarSession {
  return {
    id: session.id,
    title: session.title,
    blank: isPlaceholderSessionTitle(session.title, session.workingDirectory),
    updatedAt: Date.parse(session.updatedAt),
    status: sessionStatus(session.id, runningSessionId, approvalSessionId),
    workspace: sessionHasProject(session) ? projectNameFromDirectory(session.workingDirectory) : NO_PROJECT_GROUP_NAME,
    path: sessionHasProject(session) ? session.workingDirectory : NO_PROJECT_GROUP_PATH
  };
}

export function groupSidebarSessions(sessions: readonly SidebarSession[]): Pick<SidebarGroup, 'path' | 'name' | 'sessions'>[] {
  const groups = new Map<string, SidebarSession[]>();
  for (const session of sessions) {
    const existing = groups.get(session.path);
    if (existing) existing.push(session);
    else groups.set(session.path, [session]);
  }
  return [...groups.entries()].map(([path, members]) => {
    const sessionsInGroup = [...members].sort(byRecency);
    return {
      path,
      name: path === NO_PROJECT_GROUP_PATH ? NO_PROJECT_GROUP_NAME : projectNameFromDirectory(path),
      sessions: sessionsInGroup
    };
  }).sort((left, right) => {
    const delta = (right.sessions[0]?.updatedAt ?? 0) - (left.sessions[0]?.updatedAt ?? 0);
    return delta !== 0 ? delta : left.path.localeCompare(right.path);
  });
}

export function visibleGroupSessions(
  sessions: readonly SidebarSession[],
  overflowExpanded: boolean
): { visible: SidebarSession[]; hiddenCount: number } {
  if (overflowExpanded || sessions.length <= COLLAPSED_SESSION_LIMIT) {
    return { visible: [...sessions], hiddenCount: 0 };
  }
  return {
    visible: sessions.slice(0, COLLAPSED_SESSION_LIMIT),
    hiddenCount: sessions.length - COLLAPSED_SESSION_LIMIT
  };
}

function currentBeyondLimit(sessions: readonly SidebarSession[], currentId: string | null): boolean {
  if (currentId === null) return false;
  return sessions.findIndex((session) => session.id === currentId) >= COLLAPSED_SESSION_LIMIT;
}

export function deriveSidebar(sessions: readonly SessionMeta[], view: SidebarView): SidebarSnapshot {
  const rows = sessions.map((session) => toSidebarSession(session, view.runningSessionId, view.approvalSessionId));
  const query = view.query.trim().toLowerCase();
  const search = query === ''
    ? []
    : rows
      .filter((session) => !session.blank && `${session.title} ${session.workspace} ${session.path}`.toLowerCase().includes(query))
      .sort(byRecency)
      .slice(0, SEARCH_RESULT_LIMIT);
  const collapsed = new Set(view.collapsedProjects);
  const overflow = new Set(view.overflowProjects);
  const groups = groupSidebarSessions(rows).map((group) => {
    const expanded = !collapsed.has(group.path);
    const userOverflow = overflow.has(group.path);
    const overflowExpanded = userOverflow || currentBeyondLimit(group.sessions, view.currentId);
    const shown = expanded ? visibleGroupSessions(group.sessions, overflowExpanded) : { visible: [] as SidebarSession[], hiddenCount: 0 };
    return {
      ...group,
      containsCurrent: view.currentId !== null && group.sessions.some((session) => session.id === view.currentId),
      expanded,
      overflowExpanded,
      userOverflow,
      visibleSessions: shown.visible,
      hiddenCount: shown.hiddenCount
    };
  });
  return { groups, flat: [...rows].sort(byRecency), search };
}

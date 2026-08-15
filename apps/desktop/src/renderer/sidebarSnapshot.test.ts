import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@desktop-agent/contracts';
import {
  COLLAPSED_SESSION_LIMIT,
  deriveSidebar,
  formatRelativeTime,
  relativeTime,
  sessionStatus
} from './sidebarSnapshot';

const at = (stamp: string): string => stamp;

function session(id: string, title: string, directory: string, updatedAt: string): SessionMeta {
  return {
    id,
    title,
    workingDirectory: directory,
    createdAt: at('2026-08-01T00:00:00.000Z'),
    updatedAt: at(updatedAt)
  };
}

describe('sidebar snapshot', () => {
  it('groups by project, newest session first, newest project first', () => {
    const snapshot = deriveSidebar([
      session('old', '旧会话', '/repo/alpha', '2026-08-10T00:00:00.000Z'),
      session('new', '新会话', '/repo/beta', '2026-08-12T00:00:00.000Z'),
      session('mid', '中会话', '/repo/alpha', '2026-08-11T00:00:00.000Z')
    ], {
      groupBy: 'workspace',
      query: '',
      collapsedProjects: [],
      overflowProjects: [],
      currentId: 'mid',
      runningSessionId: null,
      approvalSessionId: null
    });
    expect(snapshot.groups.map((group) => group.name)).toEqual(['beta', 'alpha']);
    expect(snapshot.groups[1]?.sessions.map((item) => item.id)).toEqual(['mid', 'old']);
    expect(snapshot.groups[1]?.containsCurrent).toBe(true);
    expect(snapshot.groups[0]?.containsCurrent).toBe(false);
  });

  it('caps visible sessions until overflow is expanded', () => {
    const sessions = Array.from({ length: COLLAPSED_SESSION_LIMIT + 3 }, (_, index) => (
      session(`s${index}`, `会话 ${index}`, '/repo/app', `2026-08-15T00:00:0${index}.000Z`)
    ));
    const collapsed = deriveSidebar(sessions, {
      groupBy: 'workspace', query: '', collapsedProjects: [], overflowProjects: [],
      currentId: 's7', runningSessionId: null, approvalSessionId: null
    });
    expect(collapsed.groups[0]?.visibleSessions).toHaveLength(COLLAPSED_SESSION_LIMIT);
    expect(collapsed.groups[0]?.hiddenCount).toBe(3);

    const expanded = deriveSidebar(sessions, {
      groupBy: 'workspace', query: '', collapsedProjects: [], overflowProjects: ['/repo/app'],
      currentId: 's7', runningSessionId: null, approvalSessionId: null
    });
    expect(expanded.groups[0]?.visibleSessions).toHaveLength(sessions.length);
    expect(expanded.groups[0]?.hiddenCount).toBe(0);
  });

  it('reveals overflow when the current session sits past the cap', () => {
    const sessions = Array.from({ length: 7 }, (_, index) => (
      session(`s${index}`, `会话 ${index}`, '/repo/app', `2026-08-15T00:00:0${index}.000Z`)
    ));
    const snapshot = deriveSidebar(sessions, {
      groupBy: 'workspace', query: '', collapsedProjects: [], overflowProjects: [],
      currentId: 's0', runningSessionId: null, approvalSessionId: null
    });
    expect(snapshot.groups[0]?.overflowExpanded).toBe(true);
    expect(snapshot.groups[0]?.visibleSessions.map((item) => item.id)).toContain('s0');
  });

  it('hides sessions in a collapsed project', () => {
    const snapshot = deriveSidebar([
      session('a', 'A', '/repo/app', '2026-08-15T00:00:00.000Z')
    ], {
      groupBy: 'workspace', query: '', collapsedProjects: ['/repo/app'], overflowProjects: [],
      currentId: 'a', runningSessionId: null, approvalSessionId: null
    });
    expect(snapshot.groups[0]?.expanded).toBe(false);
    expect(snapshot.groups[0]?.visibleSessions).toEqual([]);
  });

  it('matches title and workspace in a flat search list', () => {
    const snapshot = deriveSidebar([
      session('a', '修复审批', '/repo/desktop', '2026-08-15T02:00:00.000Z'),
      session('b', '其他', '/repo/agent', '2026-08-15T01:00:00.000Z')
    ], {
      groupBy: 'workspace', query: 'desktop', collapsedProjects: [], overflowProjects: [],
      currentId: null, runningSessionId: null, approvalSessionId: null
    });
    expect(snapshot.search.map((item) => item.id)).toEqual(['a']);
    expect(snapshot.flat.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('omits placeholder sessions from search', () => {
    const snapshot = deriveSidebar([
      session('blank', '新会话', '/repo/app', '2026-08-15T02:00:00.000Z'),
      session('named', '新会话备份', '/repo/app', '2026-08-15T01:00:00.000Z')
    ], {
      groupBy: 'workspace', query: '新会话', collapsedProjects: [], overflowProjects: [],
      currentId: null, runningSessionId: null, approvalSessionId: null
    });
    expect(snapshot.search.map((item) => item.id)).toEqual(['named']);
  });

  it('caps search results', () => {
    const sessions = Array.from({ length: 25 }, (_, index) => (
      session(`s${index}`, `主题 ${index}`, '/repo/app', `2026-08-15T00:${String(index).padStart(2, '0')}:00.000Z`)
    ));
    const snapshot = deriveSidebar(sessions, {
      groupBy: 'workspace', query: '主题', collapsedProjects: [], overflowProjects: [],
      currentId: null, runningSessionId: null, approvalSessionId: null
    });
    expect(snapshot.search).toHaveLength(20);
  });

  it('marks blank placeholder rows and live status', () => {
    const snapshot = deriveSidebar([
      session('blank', '新会话', '/repo/app', '2026-08-15T00:00:00.000Z'),
      session('live', '正在跑', '/repo/app', '2026-08-15T01:00:00.000Z'),
      session('ask', '待批准', '/repo/app', '2026-08-15T02:00:00.000Z')
    ], {
      groupBy: 'workspace', query: '', collapsedProjects: [], overflowProjects: [],
      currentId: 'live', runningSessionId: 'live', approvalSessionId: 'ask'
    });
    expect(snapshot.groups[0]?.sessions.find((item) => item.id === 'blank')?.blank).toBe(true);
    expect(sessionStatus('ask', 'live', 'ask')).toBe('approval');
    expect(sessionStatus('live', 'live', null)).toBe('running');
  });
});

describe('relative time', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z');
  it('buckets compact chinese labels', () => {
    expect(relativeTime(now - 10_000, now)).toEqual({ unit: 'now', n: 0 });
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5分钟');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3小时');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2天');
  });
});

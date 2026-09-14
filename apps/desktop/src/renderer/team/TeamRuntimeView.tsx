import React from 'react';
import type { TeamSnapshot, TeamStatusSnapshot, TeamTaskSnapshot } from '@desktop-agent/contracts';
const MEMBER_STATES = { idle: '空闲', queued: '排队', running: '工作中', waiting_approval: '等待批准', disabled: '已停用', error: '异常' };
const TASK_STATES = { queued: '排队', running: '工作中', waiting_approval: '等待批准', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
export function TeamRuntimeView({ team, status, busy, onToggle }: { team: TeamSnapshot; status: TeamStatusSnapshot | null; busy: boolean; onToggle: (memberId: string, enabled: boolean) => void }) {
  const matchingStatus = status?.team.id === team.id ? status : null;
  const members = matchingStatus?.team.members ?? team.members;
  const groups: [string, TeamTaskSnapshot[]][] = matchingStatus ? [['当前任务', matchingStatus.activeTasks], ['等待中的任务', matchingStatus.queuedTasks], ['最近任务', matchingStatus.recentTasks.filter((task) => ![...matchingStatus.activeTasks, ...matchingStatus.queuedTasks].some((active) => active.id === task.id))]] : [];
  return <section className="settings-section-card team-runtime-card">
    <div className="settings-section-title"><h2>运行情况</h2><p>{matchingStatus ? `${matchingStatus.unreadMessages} 条未读消息` : '暂无运行数据，请刷新获取。'}</p></div>
    <div className="team-runtime-members">{members.map((member) => <label key={member.id}><input type="checkbox" checked={member.state !== 'disabled'} disabled={busy || ['running', 'waiting_approval'].includes(member.state)} onChange={(event) => onToggle(member.id, event.target.checked)} />{member.name} · {MEMBER_STATES[member.state]}</label>)}</div>
    {groups.map(([title, tasks]) => <div key={title}><h3 className="team-runtime-group">{title} · {tasks.length}</h3><div className="team-task-list">{tasks.map((task) => <div key={task.id} className="team-task-row"><span className={`team-task-state ${task.state}`}>{TASK_STATES[task.state]}</span><div><strong>{members.find((member) => member.id === task.memberId)?.name ?? task.memberId}</strong><span>{task.input}</span><small>{task.model} · 输入 {task.usage.inputTokens.toLocaleString()} / 输出 {task.usage.outputTokens.toLocaleString()} tokens</small></div><time>{new Date(task.startedAt ?? task.createdAt).toLocaleString()}</time></div>)}{tasks.length === 0 && <p className="team-list-empty">暂无任务</p>}</div></div>)}
  </section>;
}

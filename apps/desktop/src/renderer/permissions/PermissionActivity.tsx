import React, { useState } from 'react';
import type { PermissionDecisionAuditItem } from '@desktop-agent/contracts';
import { decisionLabels, decisionReason, riskLabels } from './permission-copy';
function decisionTime(value: string): string {
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)); }
  catch { return value; }
}
export function PermissionActivity({ items, sessionScoped }: { items: PermissionDecisionAuditItem[]; sessionScoped: boolean }) {
  const [effect, setEffect] = useState('all');
  const [query, setQuery] = useState('');
  const visible = items.filter((item) => (effect === 'all' || item.effect === effect) && `${item.toolName} ${decisionReason(item)}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="settings-section-card permission-audit-card" aria-label="权限活动">
    <div className="settings-section-title"><h2>最近的权限判断</h2><p>{sessionScoped ? '当前会话' : '所有会话'}最近加载的 {items.length} 条记录。允许表示通过权限检查，不代表操作执行成功。</p></div>
    <div className="permission-activity-summary">{Object.entries(decisionLabels).map(([value, label]) => <span key={value}>{label} <strong>{items.filter((item) => item.effect === value).length}</strong></span>)}</div>
    <div className="permission-activity-filters"><label>结果<select aria-label="结果" value={effect} onChange={(event) => setEffect(event.target.value)}><option value="all">全部结果</option>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>搜索工具或原因<input type="search" value={query} onChange={(event) => setQuery(event.target.value)}/></label></div>
    <div className="permission-audit-list">{visible.map((item) => <article key={item.id}>
      <span className={`permission-effect ${item.effect}`}>{decisionLabels[item.effect]}</span>
      <div className="permission-audit-main"><strong>{item.toolName}</strong><span>{decisionReason(item)}</span>
        {item.locked && <small>系统保护生效</small>}
        <details><summary>查看技术详情</summary><pre>{JSON.stringify(item, null, 2)}</pre></details>
      </div><div className="permission-audit-meta"><span>{riskLabels[item.risk]}</span><time dateTime={item.createdAt}>{decisionTime(item.createdAt)}</time></div>
    </article>)}{!visible.length && <p className="permission-audit-empty">{items.length ? '没有符合筛选条件的记录。' : '尚无权限判断记录。'}</p>}</div>
  </section>;
}

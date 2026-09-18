import React, { useState } from 'react';
import type { BrowserRecordingStudioDetail } from '@desktop-agent/contracts';

export function BrowserRecordingDeveloperTools({ studio, studioJson, setStudioJson, studioBusy, saveStudio }: {
  studio: BrowserRecordingStudioDetail;
  studioJson: string;
  setStudioJson: (value: string) => void;
  studioBusy: boolean;
  saveStudio: () => Promise<void>;
}) {
  const [studioTab, setStudioTab] = useState<'editor' | 'timeline' | 'debugger' | 'heals' | 'history'>('editor');
  return <section className="browser-studio" aria-label="开发者工具">
        <nav aria-label="开发者工具栏目">
          {([
            ['editor', '原始 JSON'], ['timeline', '步骤技术信息'], ['debugger', '回放调试'],
            ['heals', '选择器修复'], ['history', '版本历史']
          ] as const).map(([id, label]) => <button type="button" className={studioTab === id ? 'active' : ''} key={id} onClick={() => setStudioTab(id)}>{label}</button>)}
        </nav>
        {studioTab === 'editor' && <div className="browser-studio-editor">
          <textarea aria-label="录制任务 JSON 编辑器" value={studioJson} readOnly={!studio.editable || studioBusy} spellCheck={false} onChange={(event) => setStudioJson(event.target.value)} />
          <div className="browser-studio-actions">
            <span>{studio.editable ? '保存时校验 schema，并以 revision + content hash 防止覆盖并发修改。' : '此录制任务当前只读。项目录制任务需先信任此版本。'}</span>
            {studio.editable && <button type="button" disabled={studioBusy} onClick={() => { void saveStudio(); }}>保存新版本</button>}
          </div>
        </div>}
        {studioTab === 'timeline' && <ol className="browser-studio-timeline">
          {studio.timeline.map((step) => <li key={step.stepId}><b>{step.index}</b><div><strong>{step.label || step.action}</strong><code>{step.action} · {step.stepId}</code>{step.target && <span>{step.target}</span>}{step.frame && <small>frame: {step.frame.join(' → ')}</small>}</div></li>)}
          {studio.timeline.length === 0 && <li className="empty">没有步骤。</li>}
        </ol>}
        {studioTab === 'debugger' && <div className="browser-studio-debugger">
          {studio.replay.map((entry, index) => <article key={`${entry.runId}-${index}`}><time>{new Date(entry.timestamp).toLocaleString()}</time><code>{entry.runId}</code><strong>{entry.stepIndex}. {entry.action}</strong><span className={`state ${entry.state.includes('failed') ? 'failed' : entry.state.includes('verified') || entry.state === 'run_completed' ? 'ok' : ''}`}>{entry.state}</span>{entry.attempt && <small>尝试 {entry.attempt}</small>}</article>)}
          {studio.replay.length === 0 && <p>还没有回放记录。</p>}
        </div>}
        {studioTab === 'heals' && <div className="browser-studio-heals">
          {studio.heals.map((heal, index) => <article key={`${heal.runId}-${heal.stepId}-${index}`}><header><strong>{heal.stepId}</strong><span>{heal.verified ? '已验证' : '仅提议'}{heal.confidence !== undefined ? ` · ${(heal.confidence * 100).toFixed(0)}%` : ''}</span></header><div><del>{heal.before || '原选择器不可用'}</del><ins>{heal.after}</ins></div><small>{heal.runId} · {new Date(heal.timestamp).toLocaleString()}</small></article>)}
          {studio.heals.length === 0 && <p>还没有选择器修复记录。</p>}
        </div>}
        {studioTab === 'history' && <div className="browser-studio-history">
          {studio.revisions.map((revision) => <article className={revision.current ? 'current' : ''} key={`${revision.revision}-${revision.contentHash}`}><strong>版本 {revision.revision}</strong><code>{revision.contentHash.slice(0, 23)}…</code><time>{new Date(revision.updatedAt).toLocaleString()}</time>{revision.current && <span>当前</span>}</article>)}
        </div>}
  </section>;
}

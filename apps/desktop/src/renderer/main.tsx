import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AgentEvent, ApprovalRequest, BrowserDockState, BrowserRecordingRegistrySnapshot, BrowserRecordingStudioDetail, DesktopApi, ExtensionSettings, ExtensionStatus, HookSettingsSnapshot, ImageContentBlock, MemoryCandidateReviewEdit, MemorySettings, MemoryStatusSnapshot, Message, PermissionGovernanceSnapshot, PermissionPolicyDocumentContract, ProviderConfig, ProviderSettings, ScheduleContract, ScheduleRunContract, SessionCompactionRecord, SessionMeta, SkillDetail, SkillStatus, TeamSnapshot, TeamStatusSnapshot, WorkflowRunSnapshot, WorkspaceChanges
} from '@desktop-agent/contracts';
import { DEFAULT_BROWSER_SETTINGS, DEFAULT_MEMORY_SETTINGS, DEFAULT_PROVIDERS, DEFAULT_SESSION_TITLE, projectNameFromDirectory } from '@desktop-agent/contracts';
import {
  applyLiveEvent,
  buildConversationSnapshot,
  emptyLiveSteps,
  quoteCommandPart,
  type ConversationViewMode,
  type LiveStep
} from './conversation';
import { browserDomainIssue, parseBrowserDomainList } from './browser-settings';
import { HooksSettingsPage, hookStatusErrorMessage } from './HooksSettings';
import { MemorySettingsPage } from './MemorySettings';
import { PermissionsSettingsPage } from './PermissionsSettings';
import { SchedulerSettingsPage } from './SchedulerSettings';
import { TeamSettingsPage } from './TeamSettings';
import { ChannelsSettingsPage } from './ChannelsSettings';
import { ChatTranscript, ConversationViewTabs, Markdown, TrajectoryView } from './ConversationViews';
import { Sidebar } from './Sidebar';
import { WorkflowCard } from './WorkflowCard';
import { filterVisibleSkills } from './skill-catalog';
import { mergeWorkflowSnapshot, workflowsByConversationTurn, workflowsForSession } from './workflow-state';
import './styles.css';

type DiffLine = { type: 'addition' | 'deletion' | 'context' | 'hunk' | 'meta'; oldLine?: number; newLine?: number; text: string };
const FOLLOW_THRESHOLD = 24;
type SettingsSection = 'models' | 'permissions' | 'memory' | 'automations' | 'channels' | 'teams' | 'browser' | 'mcp' | 'skills' | 'hooks';

const defaultSettings: ProviderSettings = {
  activeProviderId: 'openai',
  providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })),
  utilityModel: { providerId: 'openai', model: 'gpt-5-mini' },
  permissions: { mode: 'ask' },
  memory: structuredClone(DEFAULT_MEMORY_SETTINGS),
  extensions: { mcpServers: [], skills: { directories: [], disabled: [] }, browser: { ...DEFAULT_BROWSER_SETTINGS } }
};

function providerById(settings: ProviderSettings, id: string): ProviderConfig {
  return settings.providers.find((provider) => provider.id === id) ?? settings.providers[0]!;
}

function skillMarkdownContent(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/u, '').trim();
}

function skillDetailErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("No handler registered for 'extensions:skill-detail'")) {
    return '应用主进程仍是旧版本。请完整退出并重新启动 Desktop Agent，然后重新打开此 Skill。';
  }
  return message;
}

function ExtensionIcon({ kind }: { kind: 'mcp' | 'skill' }) {
  return <span className={`extension-item-icon ${kind}`} aria-hidden="true">
    {kind === 'skill'
      ? <svg viewBox="0 0 24 24"><path d="m12 3 6.5 3.75v7.5L12 18l-6.5-3.75v-7.5L12 3Zm0 7.5 6.5-3.75M12 10.5 5.5 6.75M12 10.5V18" /></svg>
      : <svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="2.25" /><circle cx="17" cy="7" r="2.25" /><circle cx="12" cy="17" r="2.25" /><path d="m8.8 8.25 2.1 6.6m4.3-6.6-2.1 6.6M9.25 7h5.5" /></svg>}
  </span>;
}

function SidebarToggleIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.75" y="3.25" width="14.5" height="13.5" rx="2.25" />
    <path d="M7.25 3.75v12.5" />
  </svg>;
}

function skillScope(skill: SkillStatus): string {
  return skill.origin === 'project' ? '项目' : skill.origin === 'user' ? '个人' : skill.origin === 'default' ? '默认' : '自定义';
}

function approvalTitle(request: ApprovalRequest): string {
  if (request.security?.kind === 'mcp' || request.call.name.startsWith('mcp__') || request.call.name.startsWith('mcp_')) return '调用外部 MCP 工具';
  if (request.call.name === 'browser_open') return '打开网页';
  if (request.call.name === 'browser_download') return '下载网页文件';
  if (request.call.name === 'browser_eval') return '执行网页脚本';
  if (request.call.name === 'browser_hover') return '悬停网页';
  if (request.call.name === 'browser_cookies') return '读取网页 Cookie';
  if (request.call.name.startsWith('browser_')) return '操作网页';
  if (request.call.name === 'terminal') return '运行本地命令';
  if (request.call.name === 'read_file') return '读取工作区外的文件';
  if (request.preview) return `${request.preview.kind === 'create' ? '创建' : request.preview.kind === 'delete' ? '删除' : '修改'}文件`;
  return request.reason;
}

function approvalToolLabel(request: ApprovalRequest): string {
  if (request.call.name === 'trust_project_hooks') return 'Hooks';
  if (request.security?.kind === 'mcp' || request.call.name.startsWith('mcp__') || request.call.name.startsWith('mcp_')) return 'MCP';
  if (request.call.name.startsWith('browser_')) return '浏览器';
  if (request.call.name === 'terminal') return '终端';
  if (request.call.name === 'read_file') return '文件';
  if (request.preview) return '文件修改';
  return request.call.name;
}

function approvalQuestion(request: ApprovalRequest): string {
  if (request.call.name === 'trust_project_hooks') return '是否信任此版本的项目 Hooks？';
  if (request.call.name.startsWith('browser_')) return '是否允许执行此浏览器操作？';
  if (request.call.name === 'terminal') return '是否允许运行此本地命令？';
  if (request.call.name === 'read_file') return '是否允许读取工作区外的文件？';
  if (request.preview) return `是否允许${approvalTitle(request)}？`;
  return `是否允许${approvalTitle(request)}？`;
}

function BrowserSettingsPage({
  enabled,
  mode,
  domains,
  recordings,
  recordingsBusy,
  workingDirectory,
  error,
  onEnabledChange,
  onModeChange,
  onDomainsChange,
  onRefreshRecordings,
  onTrustRecording,
  onRevokeRecording,
  onDeleteRecording,
  onSubmit
}: {
  enabled: boolean;
  mode: 'sandbox' | 'chrome';
  domains: string;
  recordings: BrowserRecordingRegistrySnapshot | null;
  recordingsBusy: boolean;
  workingDirectory?: string;
  error: string;
  onEnabledChange: (enabled: boolean) => void;
  onModeChange: (mode: 'sandbox' | 'chrome') => void;
  onDomainsChange: (domains: string) => void;
  onRefreshRecordings: () => void;
  onTrustRecording: (recordingId: string) => void;
  onRevokeRecording: (recordingId: string) => void;
  onDeleteRecording: (recordingId: string) => void;
  onSubmit: () => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const [studio, setStudio] = useState<BrowserRecordingStudioDetail | null>(null);
  const [studioJson, setStudioJson] = useState('');
  const [studioTab, setStudioTab] = useState<'editor' | 'timeline' | 'debugger' | 'heals' | 'history'>('editor');
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioError, setStudioError] = useState('');
  const list = parseBrowserDomainList(domains);

  const studioInput = (recordingId: string) => ({ recordingId, ...(workingDirectory ? { workingDirectory } : {}) });
  const openStudio = async (recordingId: string) => {
    setStudioBusy(true); setStudioError('');
    try {
      const detail = await window.desktopAgent.getBrowserRecordingStudio(studioInput(recordingId));
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));
      setStudioTab('editor');
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };

  const saveStudio = async () => {
    if (!studio) return;
    setStudioBusy(true); setStudioError('');
    try {
      const document = JSON.parse(studioJson) as BrowserRecordingStudioDetail['document'];
      const detail = await window.desktopAgent.saveBrowserRecording({
        ...studioInput(studio.document.id),
        expectedRevision: studio.document.revision,
        expectedHash: studio.document.contentHash,
        document
      });
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));
      onRefreshRecordings();
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };

  const duplicateStudio = async (recordingId: string) => {
    const name = window.prompt('新 Recording 名称（留空自动添加 Copy）') ?? undefined;
    if (name === undefined) return;
    setStudioBusy(true); setStudioError('');
    try {
      const detail = await window.desktopAgent.duplicateBrowserRecording({ ...studioInput(recordingId), ...(name.trim() ? { name: name.trim() } : {}) });
      setStudio(detail);
      setStudioJson(JSON.stringify(detail.document, null, 2));
      setStudioTab('editor');
      onRefreshRecordings();
    } catch (cause) {
      setStudioError(cause instanceof Error ? cause.message : String(cause));
    } finally { setStudioBusy(false); }
  };

  const commitDomains = (next: string[]) => {
    onDomainsChange(next.join('\n'));
  };

  const addDraft = (raw = draft): boolean => {
    const pieces = parseBrowserDomainList(raw);
    if (!pieces.length) {
      setDraftError(raw.trim() ? browserDomainIssue(raw) ?? '域名格式无效。' : '');
      return !raw.trim();
    }
    const next = [...list];
    const existing = new Set(next);
    let added = 0;
    for (const domain of pieces) {
      const issue = browserDomainIssue(domain);
      if (issue) {
        setDraftError(issue);
        setDraft(domain);
        return false;
      }
      if (existing.has(domain)) continue;
      existing.add(domain);
      next.push(domain);
      added += 1;
    }
    commitDomains(next);
    setDraft('');
    setDraftError(added === 0 ? '该域名已在列表中。' : '');
    return true;
  };

  return <form className={`settings-content model-settings-page browser-settings-page ${enabled ? '' : 'is-disabled'}`} aria-labelledby="browser-settings-title" onSubmit={(event) => {
    event.preventDefault();
    if (draft.trim() && !addDraft()) return;
    void onSubmit();
  }}>
    <div className="settings-heading">
      <div>
        <h1 id="browser-settings-title">受控浏览器</h1>
        <p>沙箱模式在右侧栏打开隔离页面。本机浏览器会自动打开 Chrome，适合需要登录的网站。</p>
      </div>
      <span className={`browser-status-pill ${enabled ? 'on' : ''}`}>{enabled ? '已启用' : '已关闭'}</span>
    </div>
    <section className="settings-section-card">
      <div className="browser-toggle-row">
        <div className="browser-toggle-copy">
          <strong id="browser-enabled-label">启用浏览器工具</strong>
          <span>关闭后智能体不能打开或操作网页。查公开资料仍可使用网页搜索和抓取。</span>
        </div>
        <button type="button" role="switch" aria-checked={enabled} aria-labelledby="browser-enabled-label" className={`extension-switch ${enabled ? 'on' : ''}`} onClick={() => onEnabledChange(!enabled)}><span /></button>
      </div>
      <div className="browser-policy-grid">
        <article><span className="browser-policy-tag allow">自动允许</span><p>白名单导航、读取页面、等待、滚动、后退、刷新、页面诊断、Cookie 元数据、录制取消与查看</p></article>
        <article><span className="browser-policy-tag ask">每次批准</span><p>点击、悬停、脚本、输入、按键、选择、上传、下载、关闭页面、Cookie 值、录制开始/删除/回放；本机浏览器下切换已有标签</p></article>
        <article><span className="browser-policy-tag info">不走浏览器</span><p>普通搜索和已知公开网址使用网页搜索 / 抓取</p></article>
      </div>
    </section>
    <section className="settings-section-card">
      <div className="settings-section-title">
        <h2>浏览器模式</h2>
        <p>沙箱适合编码和不可信站点。需要登录时选择本机浏览器。</p>
      </div>
      <div className="browser-mode-grid" role="radiogroup" aria-label="浏览器模式">
        <label className={`browser-mode-option ${mode === 'sandbox' ? 'selected' : ''}`}>
          <input type="radio" name="browser-mode" checked={mode === 'sandbox'} disabled={!enabled} onChange={() => onModeChange('sandbox')} />
          <span className="browser-mode-copy">
            <strong>沙箱浏览器</strong>
            <span>嵌在主窗口右侧栏，Cookie 不与本机浏览器共享。</span>
          </span>
        </label>
        <label className={`browser-mode-option ${mode === 'chrome' ? 'selected' : ''}`}>
          <input type="radio" name="browser-mode" checked={mode === 'chrome'} disabled={!enabled} onChange={() => onModeChange('chrome')} />
          <span className="browser-mode-copy">
            <strong>本机浏览器</strong>
            <span>自动打开 Chrome 窗口，登录一次后可继续使用。</span>
          </span>
        </label>
      </div>
    </section>
    <section className="settings-section-card browser-domain-card">
      <div className="settings-section-title with-meta">
        <div>
          <h2>始终允许的域名</h2>
          <p>列出的主机首次打开或新建页面时自动允许。未列出的站点会先请求一次批准；点击、悬停、脚本、输入、下载和 Cookie 值仍逐次批准。</p>
        </div>
        <span className="browser-domain-count">{list.length}</span>
      </div>
      <div className="browser-domain-body">
        <div className={`browser-domain-editor ${enabled ? '' : 'is-disabled'}`}>
          {list.map((domain) => <span className={`browser-domain-chip ${browserDomainIssue(domain) ? 'invalid' : ''}`} key={domain}>
            {domain}
            <button type="button" aria-label={`移除 ${domain}`} disabled={!enabled} onClick={() => commitDomains(list.filter((item) => item !== domain))}>×</button>
          </span>)}
          <input
            value={draft}
            disabled={!enabled}
            placeholder={list.length ? '添加域名' : 'example.com 或 *.example.com'}
            aria-label="添加始终允许的域名"
            onChange={(event) => { setDraft(event.target.value); setDraftError(''); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault();
                addDraft();
              } else if (event.key === 'Backspace' && !draft && list.length) {
                commitDomains(list.slice(0, -1));
              }
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData('text');
              if (!/[\s,;]/u.test(text)) return;
              event.preventDefault();
              addDraft(`${draft} ${text}`);
            }}
            onBlur={() => { if (draft.trim()) addDraft(); }}
          />
        </div>
        <p className="browser-domain-hint">只需主机名，不要带 https://。*.example.com 只匹配子域，不匹配 example.com 本身。</p>
        {(draftError || error) && <div className="settings-error" role="alert">{draftError || error}</div>}
        {!enabled && <p className="browser-domain-hint">启用浏览器工具后可编辑白名单。</p>}
      </div>
      <div className="settings-actions"><button className="primary" type="submit">保存浏览器设置</button></div>
    </section>
    <section className="settings-section-card browser-recording-card">
      <div className="settings-section-title with-meta">
        <div>
          <h2>Recording Registry</h2>
          <p>用户级 Recording 位于 ~/.jojo/browser-recordings。项目级 Recording 可覆盖同名用户资源，高风险内容需按精确版本信任。</p>
        </div>
        <button type="button" className="secondary" disabled={recordingsBusy} onClick={onRefreshRecordings}>刷新</button>
      </div>
      <div className="browser-recording-paths">
        <span title={recordings?.userDirectory}>User · {recordings?.userDirectory ?? '~/.jojo/browser-recordings'}</span>
        <span title={recordings?.projectDirectory}>Project · {recordings?.projectDirectory ?? (workingDirectory ? `${workingDirectory}/.jojo/browser-recordings` : '选择项目后显示')}</span>
      </div>
      <div className="browser-recording-list">
        {recordingsBusy && !recordings && <p className="browser-domain-hint">正在读取 Recording Registry…</p>}
        {!recordingsBusy && recordings?.recordings.length === 0 && <p className="browser-domain-hint">尚无可用 Recording。</p>}
        {recordings?.recordings.map((recording) => <article className="browser-recording-item" key={recording.id}>
          <div className="browser-recording-main">
            <div className="browser-recording-title">
              <strong>{recording.name}</strong>
              <code>{recording.id}</code>
              <span className={`browser-policy-tag ${recording.source === 'project' ? 'info' : 'allow'}`}>{recording.source}</span>
              {recording.source === 'project' && <span className={`browser-policy-tag ${recording.trust === 'trusted' ? 'allow' : 'ask'}`}>{recording.trust === 'trusted' ? '已信任' : '未信任'}</span>}
            </div>
            {recording.description && <p>{recording.description}</p>}
            <p>{recording.stepCount} steps · revision {recording.revision} · {recording.highRisk ? '含高风险操作' : '只读/等待操作'}</p>
            <p>Domains: {recording.domains.join(', ') || 'none'} · Effects: {recording.effects.join(', ') || 'none'}</p>
            {recording.overriddenSources.length > 0 && <p>覆盖：{recording.overriddenSources.join(', ')}</p>}
          </div>
          <div className="browser-recording-actions">
            <button type="button" disabled={recordingsBusy || studioBusy} onClick={() => { void openStudio(recording.id); }}>查看 / 编辑</button>
            <button type="button" disabled={recordingsBusy || studioBusy} onClick={() => { void duplicateStudio(recording.id); }}>复制</button>
            {recording.source === 'project' && recording.trust !== 'trusted' && <button type="button" disabled={recordingsBusy} onClick={() => onTrustRecording(recording.id)}>信任此版本</button>}
            {recording.source === 'project' && recording.trust === 'trusted' && <button type="button" disabled={recordingsBusy} onClick={() => onRevokeRecording(recording.id)}>撤销信任</button>}
            {recording.source !== 'builtin' && <button type="button" className="danger" disabled={recordingsBusy} onClick={() => onDeleteRecording(recording.id)}>删除</button>}
          </div>
        </article>)}
      </div>
      {studio && <section className="browser-studio" aria-label="Browser Recording Studio">
        <header>
          <div><strong>{studio.document.name}</strong><span>{studio.document.id} · r{studio.document.revision} · {studio.source}</span></div>
          <button type="button" onClick={() => { setStudio(null); setStudioError(''); }}>关闭</button>
        </header>
        <nav aria-label="Recording Studio sections">
          {([
            ['editor', 'Recording editor'], ['timeline', 'Step Timeline'], ['debugger', 'Replay debugger'],
            ['heals', 'Heal diff'], ['history', 'Revision history']
          ] as const).map(([id, label]) => <button type="button" className={studioTab === id ? 'active' : ''} key={id} onClick={() => setStudioTab(id)}>{label}</button>)}
        </nav>
        {studioTab === 'editor' && <div className="browser-studio-editor">
          <textarea aria-label="Recording JSON editor" value={studioJson} readOnly={!studio.editable} spellCheck={false} onChange={(event) => setStudioJson(event.target.value)} />
          <div className="browser-studio-actions">
            <span>{studio.editable ? '保存时校验 schema，并以 revision + content hash 防止覆盖并发修改。' : '此 Recording 当前只读。项目 Recording 需先信任。'}</span>
            {studio.editable && <button type="button" disabled={studioBusy} onClick={() => { void saveStudio(); }}>保存新 revision</button>}
          </div>
        </div>}
        {studioTab === 'timeline' && <ol className="browser-studio-timeline">
          {studio.timeline.map((step) => <li key={step.stepId}><b>{step.index}</b><div><strong>{step.label || step.action}</strong><code>{step.action} · {step.stepId}</code>{step.target && <span>{step.target}</span>}{step.frame && <small>frame: {step.frame.join(' → ')}</small>}</div></li>)}
          {studio.timeline.length === 0 && <li className="empty">没有步骤。</li>}
        </ol>}
        {studioTab === 'debugger' && <div className="browser-studio-debugger">
          {studio.replay.map((entry, index) => <article key={`${entry.runId}-${index}`}><time>{new Date(entry.timestamp).toLocaleString()}</time><code>{entry.runId}</code><strong>{entry.stepIndex}. {entry.action}</strong><span className={`state ${entry.state.includes('failed') ? 'failed' : entry.state.includes('verified') || entry.state === 'run_completed' ? 'ok' : ''}`}>{entry.state}</span>{entry.attempt && <small>attempt {entry.attempt}</small>}</article>)}
          {studio.replay.length === 0 && <p>还没有 Replay Journal。</p>}
        </div>}
        {studioTab === 'heals' && <div className="browser-studio-heals">
          {studio.heals.map((heal, index) => <article key={`${heal.runId}-${heal.stepId}-${index}`}><header><strong>{heal.stepId}</strong><span>{heal.verified ? '已验证' : '仅提议'}{heal.confidence !== undefined ? ` · ${(heal.confidence * 100).toFixed(0)}%` : ''}</span></header><div><del>{heal.before || '原 selector 不可用'}</del><ins>{heal.after}</ins></div><small>{heal.runId} · {new Date(heal.timestamp).toLocaleString()}</small></article>)}
          {studio.heals.length === 0 && <p>还没有 selector heal 记录。</p>}
        </div>}
        {studioTab === 'history' && <div className="browser-studio-history">
          {studio.revisions.map((revision) => <article className={revision.current ? 'current' : ''} key={`${revision.revision}-${revision.contentHash}`}><strong>revision {revision.revision}</strong><code>{revision.contentHash.slice(0, 23)}…</code><time>{new Date(revision.updatedAt).toLocaleString()}</time>{revision.current && <span>当前</span>}</article>)}
        </div>}
        {studioError && <div className="settings-error" role="alert">{studioError}</div>}
      </section>}
      {!studio && studioError && <div className="settings-error" role="alert">{studioError}</div>}
    </section>
  </form>;
}

function approvalSummary(request: ApprovalRequest): string {
  if (request.preview) return request.preview.path;
  if (request.security?.kind === 'terminal') {
    const command = [request.security.command, ...request.security.argumentsPreview].map(quoteCommandPart).join(' ');
    return [command, `cwd: ${request.security.cwd}`, `risk: ${request.security.risk}`,
      `network: ${request.security.network === 'host' ? '全局网络' : '禁用'}`,
      `secrets: ${request.security.secretEnv.join(', ') || 'none'}`,
      `sandbox: ${request.security.sandbox}`, `capabilities: ${request.security.capabilities.join(', ')}`,
      ...request.security.reasons.map((reason) => `- ${reason}`)].join('\n');
  }
  if (request.security?.kind === 'mcp') {
    return [
      `${request.security.serverName} (${request.security.serverId})`,
      `tool: ${request.security.toolName}`,
      `risk: ${request.security.risk}`,
      `capabilities: ${request.security.capabilities.join(', ') || 'none'}`,
      ...request.security.reasons.map((reason) => `- ${reason}`)
    ].join('\n');
  }
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

function formatBrowserDockUrl(url: string): string {
  if (!url || url === 'about:blank') return '';
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function BrowserDock({
  sessionId,
  state,
  overlayOpen
}: {
  sessionId: string;
  state: BrowserDockState;
  overlayOpen: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const active = state.pages.find((page) => page.active) ?? state.pages[0];

  useLayoutEffect(() => {
    const report = () => {
      const rect = frameRef.current?.getBoundingClientRect();
      void window.desktopAgent.setBrowserDockLayout({
        sessionId,
        overlayOpen,
        bounds: rect && rect.width >= 2 && rect.height >= 2
          ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          : null
      });
    };
    report();
    const frame = frameRef.current;
    const observer = frame ? new ResizeObserver(report) : undefined;
    if (frame) observer?.observe(frame);
    window.addEventListener('resize', report);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', report);
      void window.desktopAgent.setBrowserDockLayout({ sessionId, overlayOpen, bounds: null });
    };
  }, [sessionId, overlayOpen]);

  const run = (type: 'back' | 'forward' | 'reload' | 'select' | 'close-tab' | 'close', pageId?: number) => {
    void window.desktopAgent.browserDockAction({ sessionId, type, ...(pageId ? { pageId } : {}) });
  };

  return <aside className="browser-dock" aria-label="沙箱浏览器">
    <div className="browser-dock-tabs">
      <div className="browser-dock-tab-list" role="tablist" aria-label="浏览器标签">
        {state.pages.map((page) => <div key={page.pageId} className={`browser-dock-tab ${page.active ? 'active' : ''}`}>
          <button type="button" role="tab" aria-selected={page.active} title={page.url} onClick={() => run('select', page.pageId)}>
            {page.title || '新标签页'}
          </button>
          <button type="button" className="browser-dock-tab-close" aria-label={`关闭 ${page.title || '标签'}`} onClick={() => run('close-tab', page.pageId)}>×</button>
        </div>)}
      </div>
      <button type="button" className="browser-dock-close" aria-label="关闭浏览器" title="关闭浏览器" onClick={() => run('close')}>×</button>
    </div>
    <div className="browser-dock-toolbar">
      <button type="button" aria-label="后退" title="后退" disabled={!state.canGoBack} onClick={() => run('back')}>←</button>
      <button type="button" aria-label="前进" title="前进" disabled={!state.canGoForward} onClick={() => run('forward')}>→</button>
      <button type="button" aria-label="刷新" title="刷新" onClick={() => run('reload')}>↻</button>
      <div className="browser-dock-url" title={active?.url}>{formatBrowserDockUrl(active?.url ?? '') || 'about:blank'}</div>
    </div>
    <div className="browser-dock-frame" ref={frameRef} />
  </aside>;
}

function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const sessionDirectoriesRef = useRef(new Map<string, string>());
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [compactions, setCompactions] = useState<SessionCompactionRecord[]>([]);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ImageContentBlock[]>([]);
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [conversationView, setConversationView] = useState<ConversationViewMode>('chat');
  const [trajectoryExportStatus, setTrajectoryExportStatus] = useState<'idle' | 'exporting' | 'done'>('idle');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [approvalMenuOpen, setApprovalMenuOpen] = useState(false);
  const [approvalResolving, setApprovalResolving] = useState(false);
  const runningRef = useRef(false);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('models');
  const [settings, setSettings] = useState<ProviderSettings>(defaultSettings);
  const [settingsDraft, setSettingsDraft] = useState<ProviderSettings>(defaultSettings);
  const [selectedModel, setSelectedModel] = useState(providerById(defaultSettings, defaultSettings.activeProviderId).model);
  const [apiKey, setApiKey] = useState('');
  const [modelsFresh, setModelsFresh] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [contextWindowInput, setContextWindowInput] = useState(String(providerById(defaultSettings, defaultSettings.activeProviderId).contextWindowTokens));
  const [maxOutputInput, setMaxOutputInput] = useState(String(providerById(defaultSettings, defaultSettings.activeProviderId).maxOutputTokens));
  const [settingsError, setSettingsError] = useState('');
  const [permissionError, setPermissionError] = useState('');
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionSnapshot, setPermissionSnapshot] = useState<PermissionGovernanceSnapshot | null>(null);
  const [teams, setTeams] = useState<TeamSnapshot[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const selectedTeamIdRef = useRef<string | null>(null);
  const [teamStatus, setTeamStatus] = useState<TeamStatusSnapshot | null>(null);
  const [teamError, setTeamError] = useState('');
  const [teamBusy, setTeamBusy] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleContract[]>([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | null>(null);
  const selectedScheduleIdRef = useRef<string | null>(null);
  const [scheduleRuns, setScheduleRuns] = useState<ScheduleRunContract[]>([]);
  const [schedulerError, setSchedulerError] = useState('');
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState<MemorySettings>(structuredClone(DEFAULT_MEMORY_SETTINGS));
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatusSnapshot | null>(null);
  const [memoryError, setMemoryError] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [extensionDraft, setExtensionDraft] = useState<ExtensionSettings>(defaultSettings.extensions);
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus>({ mcpServers: [], skills: [] });
  const [mcpServersJson, setMcpServersJson] = useState('[]');
  const [skillDirectories, setSkillDirectories] = useState('');
  const [browserDomains, setBrowserDomains] = useState('');
  const [browserRecordings, setBrowserRecordings] = useState<BrowserRecordingRegistrySnapshot | null>(null);
  const [browserRecordingsBusy, setBrowserRecordingsBusy] = useState(false);
  const [extensionError, setExtensionError] = useState('');
  const [hookStatus, setHookStatus] = useState<HookSettingsSnapshot | null>(null);
  const [hookError, setHookError] = useState('');
  const [hookBusy, setHookBusy] = useState(false);
  const [browserSecret, setBrowserSecret] = useState<{ requestId: string; name: string; description?: string } | null>(null);
  const [browserSecretValue, setBrowserSecretValue] = useState('');
  const [terminalSecret, setTerminalSecret] = useState<{ requestId: string; name: string; description?: string } | null>(null);
  const [terminalSecretValue, setTerminalSecretValue] = useState('');
  const [terminalSecretRemember, setTerminalSecretRemember] = useState(true);
  const [terminalSecretBusy, setTerminalSecretBusy] = useState(false);
  const [terminalSecretError, setTerminalSecretError] = useState('');
  const [extensionSearch, setExtensionSearch] = useState('');
  const [extensionEditorOpen, setExtensionEditorOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillStatus | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState('');
  const [skillEditing, setSkillEditing] = useState(false);
  const [skillEditorContent, setSkillEditorContent] = useState('');
  const [skillCreateOpen, setSkillCreateOpen] = useState(false);
  const [skillCreateName, setSkillCreateName] = useState('');
  const [skillCreateDescription, setSkillCreateDescription] = useState('');
  const [skillCreateInstructions, setSkillCreateInstructions] = useState('');
  const [skillOperationBusy, setSkillOperationBusy] = useState(false);
  const [oauthBusyServerId, setOauthBusyServerId] = useState('');
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChanges | null>(null);
  const [workspaceChangesError, setWorkspaceChangesError] = useState('');
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [projectBinding, setProjectBinding] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState('');
  const [browserDock, setBrowserDock] = useState<BrowserDockState | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [contextUsage, setContextUsage] = useState<{
    estimated: number;
    window: number;
    compacted: number;
    fixed: number;
    target: number;
    messageBudget: number;
    overCapacity: boolean;
    iteration: number;
    maxIterations: number;
    finalResponseOnly: boolean;
  } | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRunSnapshot[]>([]);
  const conversationRef = useRef<HTMLDivElement>(null);
  const [pendingMessageScrollId, setPendingMessageScrollId] = useState<string | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const turnBaselineRef = useRef<WorkspaceChanges | null>(null);
  const mcpLineNumbersRef = useRef<HTMLDivElement>(null);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const projectSearchRef = useRef<HTMLInputElement>(null);

  const refreshSessions = async () => {
    const next = await window.desktopAgent.listSessions();
    sessionDirectoriesRef.current = new Map(next.flatMap((session) => (
      session.projectBound === false ? [] : [[session.id, session.workingDirectory] as const]
    )));
    setSessions(next);
    if (!activeIdRef.current && next[0]) selectSession(next[0].id);
  };

  const refreshExtensionStatus = async (workingDirectory = activeIdRef.current ? sessionDirectoriesRef.current.get(activeIdRef.current) : undefined): Promise<ExtensionStatus> => {
    const next = await window.desktopAgent.getExtensionStatus(workingDirectory ? { workingDirectory } : undefined);
    setExtensionStatus(next);
    return next;
  };

  const hookDirectoryInput = () => {
    const workingDirectory = activeIdRef.current ? sessionDirectoriesRef.current.get(activeIdRef.current) : undefined;
    return workingDirectory ? { workingDirectory } : undefined;
  };

  const runHookAction = async (action: () => Promise<HookSettingsSnapshot | void>) => {
    setHookBusy(true);
    setHookError('');
    try {
      const next = await action();
      setHookStatus(next ?? await window.desktopAgent.getHookStatus(hookDirectoryInput()));
    } catch (cause) {
      setHookError(hookStatusErrorMessage(cause));
    } finally {
      setHookBusy(false);
    }
  };

  const memoryDirectoryInput = () => {
    const workingDirectory = activeIdRef.current ? sessionDirectoriesRef.current.get(activeIdRef.current) : undefined;
    return workingDirectory ? { workingDirectory } : undefined;
  };

  const refreshMemoryStatus = async (): Promise<void> => {
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.getMemoryStatus(memoryDirectoryInput()));
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  };

  const refreshPermissionGovernance = async (): Promise<void> => {
    const sessionId = activeIdRef.current ?? undefined;
    const workingDirectory = sessionId ? sessionDirectoriesRef.current.get(sessionId) : undefined;
    setPermissionBusy(true);
    setPermissionError('');
    try {
      setPermissionSnapshot(await window.desktopAgent.getPermissionGovernance({
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(sessionId ? { sessionId } : {}),
        limit: 50
      }));
    } catch (cause) {
      setPermissionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPermissionBusy(false);
    }
  };

  const teamWorkspace = (): string | undefined => {
    const sessionId = activeIdRef.current;
    return sessionId ? sessionDirectoriesRef.current.get(sessionId) : undefined;
  };

  const loadTeamStatus = async (teamId: string): Promise<void> => {
    try {
      setTeamStatus(await window.desktopAgent.getTeamStatus({ teamId }));
    } catch (cause) {
      setTeamStatus(null);
      setTeamError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refreshTeams = async (): Promise<void> => {
    const workspace = teamWorkspace();
    if (!workspace) {
      setTeams([]); setSelectedTeamId(null); setTeamStatus(null); setTeamError('');
      return;
    }
    setTeamBusy(true); setTeamError('');
    try {
      const next = await window.desktopAgent.listTeams({ workspace });
      setTeams(next);
      const nextId = next.some((team) => team.id === selectedTeamId) ? selectedTeamId : (next[0]?.id ?? null);
      setSelectedTeamId(nextId);
      if (nextId) await loadTeamStatus(nextId);
      else setTeamStatus(null);
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTeamBusy(false);
    }
  };

  const selectTeam = (teamId: string): void => {
    setSelectedTeamId(teamId); setTeamError('');
    void loadTeamStatus(teamId);
  };

  const saveTeam = async (input: Parameters<DesktopApi['saveTeam']>[0]): Promise<TeamSnapshot> => {
    setTeamBusy(true); setTeamError('');
    try {
      const saved = await window.desktopAgent.saveTeam(input);
      setTeams((current) => [...current.filter((team) => team.id !== saved.id), saved].sort((left, right) => left.name.localeCompare(right.name)));
      setSelectedTeamId(saved.id);
      await loadTeamStatus(saved.id);
      return saved;
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setTeamBusy(false);
    }
  };

  const deleteTeam = async (teamId: string): Promise<void> => {
    setTeamBusy(true); setTeamError('');
    try {
      await window.desktopAgent.deleteTeam({ teamId });
      const remaining = teams.filter((team) => team.id !== teamId);
      setTeams(remaining);
      const nextId = remaining[0]?.id ?? null;
      setSelectedTeamId(nextId);
      if (nextId) await loadTeamStatus(nextId);
      else setTeamStatus(null);
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setTeamBusy(false);
    }
  };

  const toggleTeamMember = async (teamId: string, memberId: string, enabled: boolean): Promise<TeamSnapshot> => {
    setTeamBusy(true); setTeamError('');
    try {
      const saved = await window.desktopAgent.setTeamMemberEnabled({ teamId, memberId, enabled });
      setTeams((current) => current.map((team) => team.id === saved.id ? saved : team));
      await loadTeamStatus(teamId);
      return saved;
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setTeamBusy(false);
    }
  };

  const loadScheduleRuns = async (scheduleId: string): Promise<void> => {
    const next = await window.desktopAgent.listScheduleRuns({ scheduleId });
    if (selectedScheduleIdRef.current === scheduleId) setScheduleRuns(next);
  };

  const refreshSchedules = async (): Promise<void> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      const [next, availableTeams] = await Promise.all([
        window.desktopAgent.listSchedules(),
        window.desktopAgent.listTeams()
      ]);
      setTeams(availableTeams);
      setSchedules(next);
      const currentId = selectedScheduleIdRef.current;
      const nextId = next.some((schedule) => schedule.id === currentId) ? currentId : null;
      setSelectedScheduleId(nextId);
      selectedScheduleIdRef.current = nextId;
      if (nextId) await loadScheduleRuns(nextId);
      else setScheduleRuns([]);
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSchedulerBusy(false);
    }
  };

  const selectSchedule = (scheduleId: string): void => {
    setSelectedScheduleId(scheduleId);
    selectedScheduleIdRef.current = scheduleId;
    setSchedulerError('');
    void loadScheduleRuns(scheduleId).catch((cause) => setSchedulerError(cause instanceof Error ? cause.message : String(cause)));
  };

  const saveSchedule = async (input: Parameters<DesktopApi['saveSchedule']>[0]): Promise<ScheduleContract> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      const saved = await window.desktopAgent.saveSchedule(input);
      setSchedules((current) => [...current.filter((schedule) => schedule.id !== saved.id), saved]
        .sort((left, right) => left.name.localeCompare(right.name)));
      setSelectedScheduleId(saved.id);
      selectedScheduleIdRef.current = saved.id;
      await loadScheduleRuns(saved.id);
      return saved;
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSchedulerBusy(false);
    }
  };

  const deleteSchedule = async (scheduleId: string): Promise<void> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      await window.desktopAgent.deleteSchedule({ scheduleId });
      const remaining = schedules.filter((schedule) => schedule.id !== scheduleId);
      setSchedules(remaining);
      setSelectedScheduleId(null);
      selectedScheduleIdRef.current = null;
      setScheduleRuns([]);
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSchedulerBusy(false);
    }
  };

  const setScheduleEnabled = async (schedule: ScheduleContract, enabled: boolean): Promise<ScheduleContract> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      const saved = await window.desktopAgent.setScheduleEnabled({
        scheduleId: schedule.id,
        enabled,
        expectedRevision: schedule.revision
      });
      setSchedules((current) => current.map((item) => item.id === saved.id ? saved : item));
      return saved;
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSchedulerBusy(false);
    }
  };

  const runScheduleNow = async (scheduleId: string): Promise<ScheduleRunContract> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      const run = await window.desktopAgent.runScheduleNow({ scheduleId });
      setScheduleRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      return run;
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSchedulerBusy(false);
    }
  };

  const cancelScheduleRun = async (runId: string): Promise<void> => {
    setSchedulerBusy(true); setSchedulerError('');
    try {
      await window.desktopAgent.cancelScheduleRun({ runId });
      const scheduleId = selectedScheduleIdRef.current;
      if (scheduleId) await loadScheduleRuns(scheduleId);
    } catch (cause) {
      setSchedulerError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setSchedulerBusy(false);
    }
  };

  const savePermissionPolicy = async (input: {
    scope: 'global' | 'workspace';
    workingDirectory?: string;
    mode: 'ask' | 'auto' | 'yolo';
    document: PermissionPolicyDocumentContract;
  }): Promise<void> => {
    setPermissionBusy(true);
    setPermissionError('');
    try {
      const next = await window.desktopAgent.savePermissionPolicy(input);
      setPermissionSnapshot(next);
      if (input.scope === 'global') {
        setSettings((current) => ({ ...current, permissions: { mode: input.mode } }));
        setSettingsDraft((current) => ({ ...current, permissions: { mode: input.mode } }));
      }
    } catch (cause) {
      setPermissionError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setPermissionBusy(false);
    }
  };

  const rebuildMemoryIndex = async (scope: 'global' | 'project'): Promise<void> => {
    const directory = memoryDirectoryInput();
    if (scope === 'project' && !directory) {
      setMemoryError('请先选择一个项目会话，再重建 Project Memory 索引。');
      return;
    }
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.rebuildMemoryIndex({ scope, ...directory }));
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  };

  const rebuildSemanticMemoryIndex = async (): Promise<void> => {
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.rebuildSemanticMemoryIndex(memoryDirectoryInput()));
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  };

  const deleteMemoryEntry = async (scope: 'global' | 'project', entryId: string): Promise<boolean> => {
    const directory = memoryDirectoryInput();
    if (scope === 'project' && !directory) {
      setMemoryError('请先选择一个项目会话，再删除 Project Memory 配置。');
      return false;
    }
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.deleteMemoryEntry({ scope, entryId, ...directory }));
      return true;
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setMemoryBusy(false);
    }
  };

  const acceptMemoryCandidate = async (candidateId: string, edit?: MemoryCandidateReviewEdit): Promise<void> => {
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.acceptMemoryCandidate({
        candidateId,
        userConfirmed: true,
        ...memoryDirectoryInput(),
        ...(edit ? { edit } : {})
      }));
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  };

  const rejectMemoryCandidate = async (candidateId: string): Promise<void> => {
    setMemoryBusy(true);
    setMemoryError('');
    try {
      setMemoryStatus(await window.desktopAgent.rejectMemoryCandidate({ candidateId, ...memoryDirectoryInput() }));
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemoryBusy(false);
    }
  };

  const saveExtensionDraft = async (): Promise<ExtensionSettings> => {
    let mcpServers = extensionDraft.mcpServers;
    if (settingsSection === 'mcp') {
      const parsed = JSON.parse(mcpServersJson) as unknown;
      if (!Array.isArray(parsed)) throw new Error('MCP Server 配置必须是 JSON 数组。');
      mcpServers = parsed as ExtensionSettings['mcpServers'];
    }
    const next: ExtensionSettings = {
      mcpServers,
      skills: {
        directories: skillDirectories.split(/\r?\n/u).map((directory) => directory.trim()).filter(Boolean),
        disabled: extensionDraft.skills.disabled
      },
      browser: {
        enabled: extensionDraft.browser.enabled,
        allowedDomains: parseBrowserDomainList(browserDomains),
        mode: extensionDraft.browser.mode,
        chromeDebugPort: extensionDraft.browser.chromeDebugPort,
        chromeNewTab: extensionDraft.browser.chromeNewTab
      }
    };
    const saved = await window.desktopAgent.saveExtensionSettings(next);
    setExtensionDraft(saved);
    setSettings((current) => ({ ...current, extensions: saved }));
    setSettingsDraft((current) => ({ ...current, extensions: saved }));
    return saved;
  };

  const refreshBrowserRecordings = async (workingDirectory?: string): Promise<void> => {
    setBrowserRecordingsBusy(true);
    try {
      setBrowserRecordings(await window.desktopAgent.listBrowserRecordings(
        workingDirectory ? { workingDirectory } : undefined
      ));
    } catch (cause) {
      setExtensionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowserRecordingsBusy(false);
    }
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
    activeIdRef.current = id; turnBaselineRef.current = null; setActiveId(id); setError(''); setWorkspaceChangesError(''); setLiveSteps([]); setTurnStartedAt(null); setInspectedId(null); setReviewOpen(false); setWorkspaceChanges(null); setAttachments([]); setTrajectoryExportStatus('idle');
    setMessages([]);
    setCompactions([]);
    const directory = sessionDirectoriesRef.current.get(id);
    if (directory) setCollapsedProjects((items) => items.filter((path) => path !== directory));
    setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    setContextUsage(null);
    const [nextMessages, nextCompactions, nextChanges, nextWorkflows] = await Promise.all([
      window.desktopAgent.loadMessages(id),
      window.desktopAgent.loadSessionCompactions(id),
      loadWorkspaceChanges(id),
      window.desktopAgent.listWorkflowRuns(id)
    ]);
    if (activeIdRef.current !== id) return;
    setMessages(nextMessages);
    setCompactions(nextCompactions);
    setWorkspaceChanges(nextChanges);
    setWorkflows((items) => [
      ...items.filter((workflow) => workflow.sessionId !== id),
      ...nextWorkflows
    ]);
    setReviewPath(nextChanges?.files[0]?.path ?? '');
  };

  useEffect(() => {
    void refreshSessions();
    void window.desktopAgent.getSettings().then((saved) => {
      setSettings(saved);
      setSettingsDraft(saved);
      setSelectedModel(providerById(saved, saved.activeProviderId).model);
      setExtensionDraft(saved.extensions);
      setMemoryDraft(saved.memory);
    });
    void refreshExtensionStatus();
    const offSessions = window.desktopAgent.onSessionsChanged(() => void refreshSessions());
    const offExtensions = window.desktopAgent.onExtensionsChanged(() => void refreshExtensionStatus());
    const offSecret = window.desktopAgent.onBrowserSecretRequest((request) => {
      setBrowserSecret(request);
      setBrowserSecretValue('');
    });
    const offTerminalSecret = window.desktopAgent.onTerminalSecretRequest((request) => {
      setTerminalSecret(request);
      setTerminalSecretValue('');
      setTerminalSecretRemember(true);
      setTerminalSecretBusy(false);
      setTerminalSecretError('');
    });
    const offDock = window.desktopAgent.onBrowserDockState((state) => setBrowserDock(state));
    const offOrchestration = window.desktopAgent.onOrchestrationEvent((event) => {
      if (event.type === 'workflow.changed') {
        setWorkflows((current) => mergeWorkflowSnapshot(current, event.workflow));
      }
      else if (event.type === 'team.changed') {
        const sessionId = activeIdRef.current;
        const workspace = sessionId ? sessionDirectoriesRef.current.get(sessionId) : undefined;
        if (event.team.workspace === workspace) {
          setTeams((current) => [...current.filter((team) => team.id !== event.team.id), event.team].sort((left, right) => left.name.localeCompare(right.name)));
        }
      }
      else if (event.type === 'team.deleted') {
        setTeams((current) => current.filter((team) => team.id !== event.teamId));
        if (selectedTeamIdRef.current === event.teamId) setTeamStatus(null);
      }
      else if (event.type === 'team.member.changed') {
        setTeams((current) => current.map((team) => team.id === event.teamId
          ? { ...team, members: team.members.map((member) => member.id === event.member.id ? event.member : member) }
          : team));
        if (selectedTeamIdRef.current === event.teamId) void loadTeamStatus(event.teamId);
      }
      else if (event.type === 'team.task.changed' && selectedTeamIdRef.current === event.task.teamId) {
        void loadTeamStatus(event.task.teamId);
      }
      else if (event.type === 'team.message.created' && selectedTeamIdRef.current === event.message.teamId) {
        void loadTeamStatus(event.message.teamId);
      }
    });
    const offScheduler = window.desktopAgent.onScheduleEvent((event) => {
      if (event.type === 'schedule.changed') {
        setSchedules((current) => [...current.filter((schedule) => schedule.id !== event.schedule.id), event.schedule]
          .sort((left, right) => left.name.localeCompare(right.name)));
      } else if (event.type === 'schedule.deleted') {
        setSchedules((current) => current.filter((schedule) => schedule.id !== event.scheduleId));
        if (selectedScheduleIdRef.current === event.scheduleId) {
          selectedScheduleIdRef.current = null;
          setSelectedScheduleId(null);
          setScheduleRuns([]);
        }
      } else if (event.run.scheduleId === selectedScheduleIdRef.current) {
        setScheduleRuns((current) => [event.run, ...current.filter((run) => run.id !== event.run.id)]);
      }
    });
    const offConversationMessage = window.desktopAgent.onConversationMessageCreated((event) => {
      void refreshSessions();
      if (activeIdRef.current !== event.sessionId) return;
      void window.desktopAgent.loadMessages(event.sessionId).then((next) => {
        if (activeIdRef.current === event.sessionId) setMessages(next);
      }).catch(() => undefined);
    });
    const offEvents = window.desktopAgent.onAgentEvent((event: AgentEvent) => {
      if (event.type === 'turn.started') {
        runningRef.current = true; setRunningSessionId(event.sessionId); setError(''); setLiveSteps(emptyLiveSteps()); setTurnStartedAt(Date.now()); setProjectPickerOpen(false); setProjectQuery('');
        setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        setContextUsage(null);
      }
      else if (event.type === 'text.delta' || event.type === 'tool.started' || event.type === 'tool.progress' || event.type === 'tool.finished') {
        setLiveSteps((steps) => applyLiveEvent(steps, event));
      }
      else if (event.type === 'approval.required') { setApprovalMenuOpen(false); setApprovalResolving(false); setApproval(event.request); }
      else if (event.type === 'usage') setUsage((current) => ({
        input: current.input + (event.inputTokens ?? 0), output: current.output + (event.outputTokens ?? 0),
        cacheRead: current.cacheRead + (event.cacheReadInputTokens ?? 0), cacheWrite: current.cacheWrite + (event.cacheWriteInputTokens ?? 0)
      }));
      else if (event.type === 'context.updated') setContextUsage({
        estimated: event.estimatedTokens,
        window: event.contextWindowTokens,
        compacted: event.compactedMessages,
        fixed: event.fixedTokens ?? 0,
        target: event.targetTokens ?? event.contextWindowTokens,
        messageBudget: event.messageBudgetTokens ?? event.contextWindowTokens,
        overCapacity: event.overCapacity === true,
        iteration: event.iteration ?? 0,
        maxIterations: event.maxIterations ?? 0,
        finalResponseOnly: event.finalResponseOnly === true
      });
      else if (event.type === 'memory.candidate' && event.event === 'memory.candidate.created') {
        void window.desktopAgent.getMemoryStatus(memoryDirectoryInput()).then(setMemoryStatus).catch(() => undefined);
      }
      else if (event.type === 'memory.semantic'
        && (event.event === 'memory.embedding.completed' || event.event === 'memory.embedding.failed')) {
        void window.desktopAgent.getMemoryStatus(memoryDirectoryInput()).then(setMemoryStatus).catch(() => undefined);
      }
      else if (event.type === 'turn.failed') { setError(event.message); runningRef.current = false; setRunningSessionId(null); setTurnStartedAt(null); setApproval(null); setTerminalSecret(null); void reloadActive(); }
      else if (event.type === 'turn.completed' || event.type === 'turn.cancelled') { runningRef.current = false; setRunningSessionId(null); setTurnStartedAt(null); setApproval(null); setTerminalSecret(null); void reloadActive(); }
    });
    return () => { offSessions(); offExtensions(); offSecret(); offTerminalSecret(); offDock(); offOrchestration(); offScheduler(); offConversationMessage(); offEvents(); };
  }, []);

  useEffect(() => { selectedTeamIdRef.current = selectedTeamId; }, [selectedTeamId]);
  useEffect(() => { selectedScheduleIdRef.current = selectedScheduleId; }, [selectedScheduleId]);

  useEffect(() => {
    const toggleSidebar = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'b' || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      setSidebarOpen((open) => !open);
    };
    window.addEventListener('keydown', toggleSidebar);
    return () => window.removeEventListener('keydown', toggleSidebar);
  }, []);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== 'hooks') return;
    let cancelled = false;
    setHookBusy(true);
    setHookError('');
    void window.desktopAgent.getHookStatus(hookDirectoryInput())
      .then((next) => { if (!cancelled) setHookStatus(next); })
      .catch((cause) => { if (!cancelled) setHookError(hookStatusErrorMessage(cause)); })
      .finally(() => { if (!cancelled) setHookBusy(false); });
    return () => { cancelled = true; };
  }, [settingsOpen, settingsSection, activeId]);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== 'memory') return;
    void refreshMemoryStatus();
  }, [settingsOpen, settingsSection, activeId]);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== 'teams') return;
    void refreshTeams();
  }, [settingsOpen, settingsSection, activeId]);

  useEffect(() => {
    if (!settingsOpen || settingsSection !== 'automations') return;
    void refreshSchedules();
  }, [settingsOpen, settingsSection]);

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
      const [nextMessages, nextCompactions, nextChanges] = await Promise.all([
        window.desktopAgent.loadMessages(id),
        window.desktopAgent.loadSessionCompactions(id),
        loadWorkspaceChanges(id)
      ]);
      if (activeIdRef.current === id) {
        setMessages(nextMessages);
        setCompactions(nextCompactions);
        const visibleChanges = nextChanges && turnBaselineRef.current ? changesSince(turnBaselineRef.current, nextChanges) : nextChanges;
        setWorkspaceChanges(visibleChanges);
        setReviewPath((current) => visibleChanges?.files.some((file) => file.path === current) ? current : (visibleChanges?.files[0]?.path ?? ''));
        if (!visibleChanges?.files.length) setReviewOpen(false);
      }
    }
    setLiveSteps([]);
  };

  const resolveApprovalChoice = useCallback(async (
    request: ApprovalRequest,
    allow: boolean,
    scope: 'once' | 'similar' | 'conversation' = 'once'
  ): Promise<void> => {
    setApprovalResolving(true);
    setError('');
    try {
      await window.desktopAgent.resolveApproval({ requestId: request.requestId, allow, scope });
      setApprovalMenuOpen(false);
      setApproval((current) => current?.requestId === request.requestId ? null : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApprovalResolving(false);
    }
  }, []);

  useEffect(() => {
    if (!approval) return;
    const handleApprovalShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape' && approvalMenuOpen) { setApprovalMenuOpen(false); return; }
      if (!approvalResolving) void resolveApprovalChoice(approval, event.key === 'Enter');
    };
    window.addEventListener('keydown', handleApprovalShortcut, true);
    return () => window.removeEventListener('keydown', handleApprovalShortcut, true);
  }, [approval, approvalMenuOpen, approvalResolving, resolveApprovalChoice]);

  useEffect(() => {
    if (!selectedSkill) return;
    const handleSkillDetailShortcut = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSkillDetail();
    };
    window.addEventListener('keydown', handleSkillDetailShortcut);
    return () => window.removeEventListener('keydown', handleSkillDetailShortcut);
  }, [selectedSkill]);

  const fetchProviderModels = async (): Promise<{ models: string[]; model: string } | null> => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const draftProvider = providerById(settingsDraft, settingsDraft.activeProviderId);
      const models = await window.desktopAgent.listModels({
        protocol: draftProvider.protocol,
        baseUrl: draftProvider.baseUrl,
        ...(apiKey ? { apiKey } : {})
      });
      const model = models.includes(draftProvider.model) ? draftProvider.model : models[0]!;
      setSettingsDraft((current) => ({
        ...current,
        providers: current.providers.map((provider) => provider.id === current.activeProviderId ? { ...provider, model, models } : provider),
        utilityModel: { providerId: current.activeProviderId, model }
      }));
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

  const createSession = async () => {
    const session = await window.desktopAgent.createSession({ title: DEFAULT_SESSION_TITLE });
    if (session) await selectSession(session.id);
  };

  const createProject = async () => {
    const directory = await window.desktopAgent.chooseDirectory();
    if (!directory) return;
    await createSessionForDirectory(directory);
  };

  const bindActiveSessionToProject = async (selectedDirectory?: string) => {
    const sessionId = activeIdRef.current;
    if (!sessionId || projectBinding || runningRef.current) return;
    const directory = selectedDirectory ?? await window.desktopAgent.chooseDirectory();
    if (!directory) return;
    setProjectBinding(true);
    setError('');
    try {
      await window.desktopAgent.bindSessionProject({ sessionId, workingDirectory: directory });
      setProjectPickerOpen(false);
      setProjectQuery('');
      setCollapsedProjects((items) => items.filter((path) => path !== directory));
      await refreshSessions();
      await selectSession(sessionId);
      await refreshExtensionStatus(directory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectBinding(false);
    }
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
      runningRef.current = false;
      setRunningSessionId(null);
      setApproval(null);
      setMessages([]);
      setCompactions([]);
      setWorkspaceChanges(null);
      setReviewOpen(false);
      setLiveSteps([]);
      setTurnStartedAt(null);
      setInspectedId(null);
      setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      setContextUsage(null);
      setWorkflows((items) => items.filter((workflow) => workflow.sessionId !== session.id));
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
    const images = attachments;
    if ((!text && images.length === 0) || !activeId || runningRef.current) return;
    runningRef.current = true;
    setDraft(''); setAttachments([]); setError(''); setRunningSessionId(activeId); setLiveSteps(emptyLiveSteps()); setTurnStartedAt(Date.now()); setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); setContextUsage(null); setTrajectoryExportStatus('idle'); atBottomRef.current = true; setAtBottom(true);
    setMessages((items) => [...items, { id: `pending-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), content: [...(text ? [{ type: 'text' as const, text }] : []), ...images] }]);
    try {
      turnBaselineRef.current = await loadWorkspaceChanges(activeId);
      await window.desktopAgent.startTurn({ sessionId: activeId, text, images, providerId: settings.activeProviderId, model: selectedModel });
    }
    catch (cause) { setDraft(text); setAttachments(images); runningRef.current = false; setRunningSessionId(null); setTurnStartedAt(null); setLiveSteps([]); setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const active = sessions.find((session) => session.id === activeId);
  const recentProjects = useMemo(() => {
    const unique = new Map<string, { path: string; name: string }>();
    for (const session of sessions) {
      if (session.projectBound === false || unique.has(session.workingDirectory)) continue;
      unique.set(session.workingDirectory, {
        path: session.workingDirectory,
        name: projectNameFromDirectory(session.workingDirectory)
      });
    }
    const query = projectQuery.trim().toLowerCase();
    return [...unique.values()].filter((project) => (
      query === '' || `${project.name} ${project.path}`.toLowerCase().includes(query)
    ));
  }, [sessions, projectQuery]);
  const selectedProvider = providerById(settings, settings.activeProviderId);
  const draftProvider = providerById(settingsDraft, settingsDraft.activeProviderId);
  const updateDraftProvider = (update: Partial<ProviderConfig>) => setSettingsDraft((current) => ({
    ...current,
    providers: current.providers.map((provider) => provider.id === current.activeProviderId ? { ...provider, ...update } : provider)
  }));
  const sessionBusy = runningSessionId === activeId;
  const showProjectPicker = active?.projectBound === false && messages.length === 0 && !sessionBusy;
  const overlayOpen = settingsOpen || Boolean(approval) || Boolean(browserSecret) || Boolean(terminalSecret) || skillCreateOpen || Boolean(selectedSkill) || projectPickerOpen;
  const visibleDock = browserDock && activeId && browserDock.sessionId === activeId ? browserDock : null;
  const browsing = Boolean(visibleDock);
  const visibleWorkflows = useMemo(() => workflowsForSession(workflows, activeId), [workflows, activeId]);
  const visibleSkills = useMemo(() => filterVisibleSkills(extensionStatus.skills), [extensionStatus.skills]);
  const filteredVisibleSkills = useMemo(() => filterVisibleSkills(extensionStatus.skills, extensionSearch), [extensionStatus.skills, extensionSearch]);
  const snapshot = useMemo(() => buildConversationSnapshot({
    messages,
    compactions,
    liveSteps: sessionBusy ? liveSteps : [],
    running: sessionBusy,
    ...(active?.workingDirectory ? { workingDirectory: active.workingDirectory } : {})
  }), [messages, compactions, liveSteps, sessionBusy, active?.workingDirectory]);
  const workflowsByTurn = useMemo(
    () => workflowsByConversationTurn(visibleWorkflows, snapshot.turns),
    [visibleWorkflows, snapshot.turns]
  );

  useLayoutEffect(() => {
    const el = conversationRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot, workspaceChanges, visibleWorkflows, conversationView, error]);

  useLayoutEffect(() => {
    if (!pendingMessageScrollId || conversationView !== 'chat') return;
    const root = conversationRef.current;
    const message = root?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(pendingMessageScrollId)}"]`);
    if (!message) return;
    message.scrollIntoView({ block: 'center' });
    setPendingMessageScrollId(null);
  }, [pendingMessageScrollId, snapshot, conversationView]);

  useLayoutEffect(() => {
    if (!activeId || visibleDock) return;
    void window.desktopAgent.setBrowserDockLayout({ sessionId: activeId, overlayOpen, bounds: null });
  }, [activeId, overlayOpen, visibleDock]);

  useEffect(() => {
    if (!projectPickerOpen) return;
    projectSearchRef.current?.focus();
    const close = (event: MouseEvent) => {
      const root = projectPickerRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) return;
      setProjectPickerOpen(false);
      setProjectQuery('');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setProjectPickerOpen(false);
      setProjectQuery('');
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [projectPickerOpen]);

  const onConversationScroll = () => {
    const el = conversationRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD;
    atBottomRef.current = pinned;
    setAtBottom(pinned);
  };

  const inspectRecord = (id: string) => {
    atBottomRef.current = false;
    setAtBottom(false);
    setInspectedId(id);
    setConversationView('trajectory');
  };

  const exportTrajectory = async () => {
    if (!activeId || sessionBusy || messages.length === 0 || trajectoryExportStatus === 'exporting') return;
    setTrajectoryExportStatus('exporting');
    setError('');
    try {
      const result = await window.desktopAgent.exportSessionTrajectory(activeId);
      setTrajectoryExportStatus(result.canceled ? 'idle' : 'done');
    } catch (cause) {
      setTrajectoryExportStatus('idle');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openReview = (path?: string) => {
    if (!workspaceChanges?.files.length) return;
    setReviewPath(path ?? workspaceChanges.files[0]!.path);
    setReviewOpen(true);
  };

  const openSettings = (section: SettingsSection = 'models') => {
    const provider = providerById(settings, settings.activeProviderId);
    setSettingsDraft(settings); setApiKey(''); setModelsFresh(true); setModelsError(''); setSettingsError(''); setPermissionError('');
    setContextWindowInput(String(provider.contextWindowTokens));
    setMaxOutputInput(String(provider.maxOutputTokens));
    setExtensionDraft(settings.extensions);
    setMcpServersJson(JSON.stringify(settings.extensions.mcpServers, null, 2));
    setSkillDirectories(settings.extensions.skills.directories.join('\n'));
    setBrowserDomains(settings.extensions.browser.allowedDomains.join('\n'));
    setMemoryDraft(structuredClone(settings.memory));
    setMemoryStatus(null); setMemoryError('');
    setExtensionError(''); setExtensionSearch(''); setExtensionEditorOpen(false);
    void refreshExtensionStatus(active?.workingDirectory);
    if (section === 'permissions') void refreshPermissionGovernance();
    if (section === 'automations') {
      setSelectedScheduleId(null);
      selectedScheduleIdRef.current = null;
      setScheduleRuns([]);
      void refreshSchedules();
    }
    if (section === 'teams') void refreshTeams();
    if (section === 'browser') void refreshBrowserRecordings(active?.workingDirectory);
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const openAutomation = (scheduleId: string) => {
    openSettings('automations');
    selectSchedule(scheduleId);
  };

  const openConversationMessage = async (sessionId: string, messageId: string) => {
    setSettingsOpen(false);
    setConversationView('chat');
    setPendingMessageScrollId(messageId);
    await selectSession(sessionId);
  };

  const openSkillDetail = async (skill: SkillStatus) => {
    setSelectedSkill(skill); setSkillDetail(null); setSkillDetailError(''); setSkillDetailLoading(true); setSkillEditing(false); setSkillEditorContent('');
    try {
      const detail = await window.desktopAgent.getSkillDetail({ path: skill.path });
      setSkillDetail(detail); setSkillEditorContent(detail.content);
    } catch (cause) {
      setSkillDetailError(skillDetailErrorMessage(cause));
    } finally {
      setSkillDetailLoading(false);
    }
  };

  const closeSkillDetail = () => {
    setSelectedSkill(null); setSkillDetail(null); setSkillDetailError(''); setSkillDetailLoading(false); setSkillEditing(false); setSkillEditorContent('');
  };

  const importSkill = async (replacePath?: string) => {
    setExtensionError(''); setSkillDetailError(''); setSkillOperationBusy(true);
    try {
      const result = await window.desktopAgent.importSkill(replacePath ? { replacePath } : undefined);
      if (!result.canceled) { closeSkillDetail(); await refreshExtensionStatus(active?.workingDirectory); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (replacePath) setSkillDetailError(message); else setExtensionError(message);
    } finally { setSkillOperationBusy(false); }
  };

  const sidebarToggle = <button
    type="button"
    className="sidebar-toggle"
    aria-label={sidebarOpen ? '收起左侧对话栏' : '打开左侧对话栏'}
    aria-controls="conversation-sidebar"
    aria-expanded={sidebarOpen}
    title={`${sidebarOpen ? '收起' : '打开'}左侧对话栏（⌘/Ctrl+B）`}
    onClick={() => setSidebarOpen((open) => !open)}
  ><SidebarToggleIcon /></button>;

  return <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
    <Sidebar
      sessions={sessions}
      activeId={activeId}
      runningSessionId={runningSessionId}
      approvalSessionId={approval?.sessionId ?? null}
      collapsedProjects={collapsedProjects}
      onToggleProject={(path) => setCollapsedProjects((items) => items.includes(path) ? items.filter((item) => item !== path) : [...items, path])}
      onSelectSession={(id) => void selectSession(id)}
      onCreateSession={() => void createSession()}
      onCreateProject={() => void createProject()}
      onCreateSessionForDirectory={(path) => void createSessionForDirectory(path)}
      onRenameSession={(session) => void renameSession(session)}
      onDeleteSession={(session) => void deleteSession(session)}
      onOpenSettings={() => openSettings()}
    />
    <main className="main-panel">
      {active ? <>
        <header className="topbar">
          <div className="topbar-leading">
            {sidebarToggle}
            <div className="topbar-title"><h1>{active.title}</h1><div className="working-directory">{active.projectBound === false ? '未选择项目' : active.workingDirectory}</div></div>
          </div>
          <div className="topbar-actions">
            <ConversationViewTabs mode={conversationView} onChange={setConversationView} />
            <button
              type="button"
              className={`trajectory-export ${trajectoryExportStatus === 'done' ? 'done' : ''}`}
              disabled={sessionBusy || messages.length === 0 || trajectoryExportStatus === 'exporting'}
              title={sessionBusy ? '当前轮次结束后可导出完整轨迹' : '将当前会话的完整轨迹导出为 Markdown'}
              onClick={() => void exportTrajectory()}
            >{trajectoryExportStatus === 'exporting' ? '导出中…' : trajectoryExportStatus === 'done' ? '已导出' : '导出轨迹'}</button>
          </div>
        </header>
        <div className={`workspace-content ${browsing ? 'browsing' : reviewOpen ? 'reviewing' : ''}`}>
        <div className="chat-pane">
        <div className="conversation" ref={conversationRef} onScroll={onConversationScroll} role="region" aria-label="对话记录">
          {snapshot.nodes.length === 0 && !sessionBusy && conversationView === 'chat' && <div className="empty"><div className="empty-icon">⌁</div><h2>{active.projectBound === false ? '开始一段新对话' : '从本地项目开始'}</h2><p>{active.projectBound === false ? '直接提问，或从侧边栏选择项目后处理本地文件。' : '可以让我阅读文件、列出目录，或在你批准后执行命令。'}</p></div>}
          {conversationView === 'chat'
            ? <ChatTranscript
              snapshot={snapshot}
              running={sessionBusy}
              turnStartedAt={turnStartedAt}
              onInspect={inspectRecord}
              onOpenAutomation={openAutomation}
              renderAfterTurn={(turn) => workflowsByTurn.get(turn.id)?.map((workflow) => <WorkflowCard
                key={workflow.id}
                workflow={workflow}
                onCancel={async (item) => {
                  try { await window.desktopAgent.cancelWorkflow({ sessionId: item.sessionId, workflowId: item.id }); }
                  catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                }}
                onResume={async (item) => {
                  try { await window.desktopAgent.resumeWorkflow({ sessionId: item.sessionId, workflowId: item.id }); }
                  catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
                }}
              />)}
            />
            : <TrajectoryView snapshot={snapshot} selectedId={inspectedId} onSelect={setInspectedId} />}
          {error && <div className="error-banner">{error}</div>}
          {workspaceChangesError && <div className="changes-error">无法读取文件修改：{workspaceChangesError}</div>}
          {!sessionBusy && messages.length > 0 && workspaceChanges && workspaceChanges.files.length > 0 && <WorkspaceChangesCard changes={workspaceChanges} onReview={openReview} />}
          {!atBottom && <button type="button" className="to-bottom" aria-label="回到底部" title="回到底部" onClick={() => { const el = conversationRef.current; if (!el) return; el.scrollTop = el.scrollHeight; atBottomRef.current = true; setAtBottom(true); }}>↓</button>}
        </div>
        <footer className="composer-wrap">
          {showProjectPicker && <div className="composer-project-picker" ref={projectPickerRef}>
            <button
              type="button"
              className="composer-project-trigger"
              aria-haspopup="listbox"
              aria-expanded={projectPickerOpen}
              disabled={sessionBusy || projectBinding}
              onClick={() => setProjectPickerOpen((open) => !open)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.75c0-1.1.9-2 2-2h3l1.45 1.7h6.55c1.1 0 2 .9 2 2v6.75c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V5.75Z" /></svg>
              <span>{projectBinding ? '正在选择项目…' : '选择项目'}</span>
              <span className="composer-project-chevron" aria-hidden="true">⌄</span>
            </button>
            {projectPickerOpen && <div className="composer-project-menu">
              <label className="composer-project-search">
                <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.25" /><path d="m12.4 12.4 4 4" /></svg>
                <input
                  ref={projectSearchRef}
                  value={projectQuery}
                  placeholder="搜索项目"
                  aria-label="搜索项目"
                  disabled={sessionBusy || projectBinding}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && recentProjects[0]) {
                      event.preventDefault();
                      void bindActiveSessionToProject(recentProjects[0].path);
                    }
                  }}
                />
              </label>
              <div className="composer-project-options" role="listbox" aria-label="最近项目">
                {recentProjects.slice(0, 8).map((project) => <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={project.path}
                  title={project.path}
                  disabled={sessionBusy || projectBinding}
                  onClick={() => void bindActiveSessionToProject(project.path)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.75c0-1.1.9-2 2-2h3l1.45 1.7h6.55c1.1 0 2 .9 2 2v6.75c0 1.1-.9 2-2 2h-11c-1.1 0-2-.9-2-2V5.75Z" /></svg>
                  <span><strong>{project.name}</strong><small>{project.path}</small></span>
                </button>)}
                {recentProjects.length === 0 && <div className="composer-project-empty">没有匹配的最近项目</div>}
              </div>
              <button type="button" className="composer-project-browse" disabled={sessionBusy || projectBinding} onClick={() => void bindActiveSessionToProject()}><span aria-hidden="true">＋</span> 打开其他项目…</button>
            </div>}
          </div>}
          <div className="composer">
          {attachments.length > 0 && <div className="composer-attachments" aria-label="待发送图片">{attachments.map((image, index) => <figure key={`${image.name ?? 'image'}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? '待发送图片'} /><button type="button" aria-label={`移除 ${image.name ?? '图片'}`} onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button><figcaption>{image.name ?? '图片'}</figcaption></figure>)}</div>}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="随心输入" rows={2}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
          <div className="composer-toolbar">
            <div className="composer-context"><span className="approval-status">⌁ 权限 {settings.permissions.mode.toUpperCase()}</span>{contextUsage && <span className={`context-status ${contextUsage.overCapacity ? 'over-capacity' : ''}`} title={contextUsage.overCapacity ? `固定指令与工具定义约 ${contextUsage.fixed} tokens，已超过可用目标 ${contextUsage.target} tokens。请提高上下文窗口或减少工具。` : contextUsage.compacted ? `已压缩 ${contextUsage.compacted} 条历史消息；消息预算 ${contextUsage.messageBudget} tokens` : `上下文估算；消息预算 ${contextUsage.messageBudget} tokens`}>{contextUsage.overCapacity ? '容量不足 · ' : ''}{Math.round(contextUsage.estimated / 1000)}k / {Math.round(contextUsage.window / 1000)}k{contextUsage.maxIterations > 0 ? ` · Loop ${contextUsage.iteration}/${contextUsage.maxIterations}${contextUsage.finalResponseOnly ? ' 收尾' : ''}` : ''}</span>}{(usage.input > 0 || usage.output > 0) && <span className="context-status" title={`缓存读取 ${usage.cacheRead} · 缓存写入 ${usage.cacheWrite}`}>↑{usage.input} ↓{usage.output}</span>}</div>
            <div className="composer-actions">
              <button className="attach" type="button" aria-label="添加图片" title="添加图片（最多 4 张，每张 10 MB）" disabled={sessionBusy || attachments.length >= 4} onClick={async () => {
                try {
                  const selected = await window.desktopAgent.chooseImages();
                  setAttachments((items) => [...items, ...selected].slice(0, 4));
                } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              }}>＋</button>
              <select className="model-select" aria-label="本轮使用的模型" title="选择本轮使用的模型" value={selectedModel} disabled={sessionBusy} onChange={(event) => setSelectedModel(event.target.value)}>
                {selectedProvider.models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              {sessionBusy
                ? <button className="stop" aria-label="停止生成" title="停止生成" onClick={() => activeId && window.desktopAgent.cancelTurn(activeId)}>■</button>
                : <button className="send" aria-label="发送消息" title="发送消息" disabled={!draft.trim() && attachments.length === 0} onClick={() => void send()}>↑</button>}
            </div>
          </div>
        </div><div className="hint">Enter 发送 · Shift+Enter 换行</div></footer>
        </div>
        {visibleDock && activeId
          ? <BrowserDock key={activeId} sessionId={activeId} state={visibleDock} overlayOpen={overlayOpen} />
          : reviewOpen && workspaceChanges && <ReviewPanel changes={workspaceChanges} selectedPath={reviewPath} onSelect={setReviewPath} onClose={() => setReviewOpen(false)} />}
        </div>
      </> : <section className="welcome"><div className="welcome-sidebar-toggle">{sidebarToggle}</div><div className="empty-icon">⌁</div><h1>Desktop Agent</h1><p>直接开始对话，或选择本地项目进行协作。</p><div className="welcome-actions"><button className="primary" onClick={() => void createSession()}>新建对话</button><button onClick={() => void createProject()}>选择项目目录</button></div></section>}
    </main>
    {approval && <div className="approval-layer"><div className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval-tool"><span className="approval-tool-icon" aria-hidden="true">›_</span><span>{approvalToolLabel(approval)}</span></div>
      <h2 id="approval-title">{approvalQuestion(approval)}</h2>
      {approval.governance && <div className={`approval-governance ${approval.governance.locked ? 'locked' : ''}`}>
        <span><strong>原因</strong>{approval.governance.reasonCode}</span>
        <span><strong>风险</strong>{approval.governance.risk}</span>
        <span><strong>来源</strong>{approval.governance.source}</span>
        {approval.governance.locked && <span><strong>约束</strong>强制审批</span>}
      </div>}
      {approval.security?.kind === 'terminal' && (approval.security.network === 'host' || approval.security.secretEnv.length > 0) && <div className="approval-security-warning">
        {approval.security.network === 'host' && <span>此命令将使用主机全局网络。</span>}
        {approval.security.secretEnv.length > 0 && <span>批准后注入密钥：{approval.security.secretEnv.join(', ')}</span>}
      </div>}
      {approval.preview ? <ApprovalDiff request={approval} /> : <pre className="approval-command">{approvalSummary(approval)}</pre>}
      <div className="approval-actions">
        <button className="approval-reject" disabled={approvalResolving} onClick={() => void resolveApprovalChoice(approval, false)}><span>{approval.call.name === 'trust_project_hooks' ? '禁用项目 Hooks' : '拒绝'}</span><kbd>Esc</kbd></button>
        <div className="approval-allow-wrap">
          {approvalMenuOpen && approval.grant && approval.grant.options.length > 1 && <div className="approval-allow-menu" role="menu" aria-label="选择允许范围">
            <button type="button" role="menuitem" disabled={approvalResolving} onClick={() => void resolveApprovalChoice(approval, true, 'once')}>允许一次</button>
            {approval.grant.options.includes('similar') && <button type="button" role="menuitem" disabled={approvalResolving} onClick={() => void resolveApprovalChoice(approval, true, 'similar')}>允许类似命令</button>}
            {approval.grant.options.includes('conversation') && <button type="button" role="menuitem" disabled={approvalResolving} onClick={() => void resolveApprovalChoice(approval, true, 'conversation')}>本次对话都允许</button>}
          </div>}
          <div className="approval-allow-split">
            <button className="approval-allow approval-allow-main" disabled={approvalResolving} onClick={() => void resolveApprovalChoice(approval, true)}><span>{approval.call.name === 'trust_project_hooks' ? '信任此版本' : '允许一次'}</span><kbd>↵</kbd></button>
            {approval.grant && approval.grant.options.length > 1 && <button type="button" className="approval-allow approval-allow-toggle" disabled={approvalResolving} aria-label="选择允许范围" aria-haspopup="menu" aria-expanded={approvalMenuOpen} onClick={() => setApprovalMenuOpen((open) => !open)}><span aria-hidden="true">⌄</span></button>}
          </div>
        </div>
      </div>
    </div></div>}
    {browserSecret && <div className="modal-backdrop"><form className="modal browser-secret-modal" role="dialog" aria-modal="true" aria-labelledby="browser-secret-title" onSubmit={(event) => {
      event.preventDefault();
      void window.desktopAgent.resolveBrowserSecret({ requestId: browserSecret.requestId, value: browserSecretValue });
      setBrowserSecret(null);
      setBrowserSecretValue('');
    }}>
      <div className="modal-tag">浏览器密钥</div>
      <h2 id="browser-secret-title">输入 {browserSecret.name}</h2>
      <p>此值不会进入模型上下文或工具参数。也可预先设置环境变量 JOJO_BROWSER_SECRET_{browserSecret.name.replace(/[^a-zA-Z0-9]+/gu, '_').toUpperCase()}。</p>
      {browserSecret.description && <p>{browserSecret.description}</p>}
      <label>密钥
        <input type="password" autoFocus value={browserSecretValue} onChange={(event) => setBrowserSecretValue(event.target.value)} />
      </label>
      <div className="modal-actions">
        <button type="button" onClick={() => {
          void window.desktopAgent.resolveBrowserSecret({ requestId: browserSecret.requestId });
          setBrowserSecret(null);
          setBrowserSecretValue('');
        }}>取消</button>
        <button className="primary" type="submit">继续回放</button>
      </div>
    </form></div>}
    {terminalSecret && <div className="modal-backdrop"><form className="modal browser-secret-modal" role="dialog" aria-modal="true" aria-labelledby="terminal-secret-title" onSubmit={(event) => {
      event.preventDefault();
      setTerminalSecretBusy(true);
      setTerminalSecretError('');
      void window.desktopAgent.resolveTerminalSecret({
        requestId: terminalSecret.requestId,
        action: 'submit',
        value: terminalSecretValue,
        remember: terminalSecretRemember
      }).then(() => {
        setTerminalSecret(null);
        setTerminalSecretValue('');
      }).catch((cause) => setTerminalSecretError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setTerminalSecretBusy(false));
    }}>
      <div className="modal-tag">Secret Broker</div>
      <h2 id="terminal-secret-title">终端或 MCP 需要 {terminalSecret.name}</h2>
      <p>密钥只会在批准后注入目标进程，不会进入模型上下文、命令参数或授权规则。</p>
      {terminalSecret.description && <p>{terminalSecret.description}</p>}
      <label>密钥
        <input type="password" autoFocus value={terminalSecretValue} disabled={terminalSecretBusy} onChange={(event) => setTerminalSecretValue(event.target.value)} />
      </label>
      <label className="terminal-secret-remember"><input type="checkbox" checked={terminalSecretRemember} disabled={terminalSecretBusy} onChange={(event) => setTerminalSecretRemember(event.target.checked)} /> 使用系统安全存储记住此密钥</label>
      {terminalSecretError && <div className="settings-error" role="alert">{terminalSecretError}</div>}
      <div className="modal-actions terminal-secret-actions">
        <button type="button" disabled={terminalSecretBusy} onClick={() => {
          setTerminalSecretBusy(true);
          void window.desktopAgent.resolveTerminalSecret({ requestId: terminalSecret.requestId, action: 'cancel', remember: false })
            .then(() => { setTerminalSecret(null); setTerminalSecretValue(''); })
            .catch((cause) => setTerminalSecretError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setTerminalSecretBusy(false));
        }}>取消</button>
        <button type="button" disabled={terminalSecretBusy} onClick={() => {
          setTerminalSecretBusy(true);
          setTerminalSecretError('');
          void window.desktopAgent.resolveTerminalSecret({ requestId: terminalSecret.requestId, action: 'import', remember: terminalSecretRemember })
            .then(() => { setTerminalSecret(null); setTerminalSecretValue(''); })
            .catch((cause) => setTerminalSecretError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setTerminalSecretBusy(false));
        }}>从 Shell 配置导入</button>
        <button className="primary" type="submit" disabled={terminalSecretBusy || !terminalSecretValue}>注入并继续</button>
      </div>
    </form></div>}
    {settingsOpen && <section className="settings-screen" aria-label="设置">
      <aside className="settings-navigation">
        <button className="settings-back" type="button" onClick={() => setSettingsOpen(false)}><span aria-hidden="true">←</span> 返回</button>
        <nav aria-label="设置分类">
          <button type="button" className={settingsSection === 'models' ? 'active' : ''} onClick={() => { setSettingsSection('models'); setExtensionEditorOpen(false); }}><span aria-hidden="true">◇</span> 模型</button>
          <button type="button" className={settingsSection === 'permissions' ? 'active' : ''} onClick={() => { setSettingsSection('permissions'); setExtensionEditorOpen(false); void refreshPermissionGovernance(); }}><span aria-hidden="true">⌁</span> 权限</button>
          <button type="button" className={settingsSection === 'memory' ? 'active' : ''} onClick={() => { setSettingsSection('memory'); setExtensionEditorOpen(false); }}><span aria-hidden="true">◈</span> Memory</button>
          <button type="button" className={settingsSection === 'automations' ? 'active' : ''} onClick={() => { setSettingsSection('automations'); setExtensionEditorOpen(false); setSelectedScheduleId(null); selectedScheduleIdRef.current = null; setScheduleRuns([]); void refreshSchedules(); }}><span aria-hidden="true">◷</span> Automations</button>
          <button type="button" className={settingsSection === 'channels' ? 'active' : ''} onClick={() => { setSettingsSection('channels'); setExtensionEditorOpen(false); }}><span aria-hidden="true">◉</span> Channels</button>
          <button type="button" className={settingsSection === 'teams' ? 'active' : ''} onClick={() => { setSettingsSection('teams'); setExtensionEditorOpen(false); void refreshTeams(); }}><span aria-hidden="true">♙</span> 团队</button>
          <button type="button" className={settingsSection === 'browser' ? 'active' : ''} onClick={() => { setSettingsSection('browser'); setExtensionEditorOpen(false); void refreshBrowserRecordings(active?.workingDirectory); }}><span aria-hidden="true">◎</span> 浏览器</button>
          <button type="button" className={settingsSection === 'skills' ? 'active' : ''} onClick={() => { setSettingsSection('skills'); setExtensionSearch(''); setExtensionEditorOpen(false); }}><span aria-hidden="true">⬡</span> 技能</button>
          <button type="button" className={settingsSection === 'mcp' ? 'active' : ''} onClick={() => { setSettingsSection('mcp'); setExtensionSearch(''); setExtensionEditorOpen(false); }}><span aria-hidden="true">⌘</span> MCP 服务</button>
          <button type="button" className={settingsSection === 'hooks' ? 'active' : ''} onClick={() => { setSettingsSection('hooks'); setExtensionEditorOpen(false); }}><span aria-hidden="true">⌥</span> Hooks</button>
        </nav>
      </aside>
      <main className={`settings-main ${settingsSection === 'automations' ? 'automations-settings-main' : ''}`}>
        <header className="settings-topbar"><strong>{settingsSection === 'models' ? '模型' : settingsSection === 'permissions' ? '权限' : settingsSection === 'memory' ? 'Memory' : settingsSection === 'automations' ? 'Automations' : settingsSection === 'channels' ? 'Channels' : settingsSection === 'teams' ? '团队' : settingsSection === 'browser' ? '浏览器' : settingsSection === 'skills' ? '技能' : settingsSection === 'hooks' ? 'Hooks' : 'MCP 服务'}</strong></header>
        <div className="settings-page-body">
    {settingsSection === 'models' && <form className="settings-content model-settings-page" aria-labelledby="settings-title" onSubmit={async (event) => {
      event.preventDefault();
      setSettingsError('');
      const contextWindowTokens = Number(contextWindowInput);
      const maxOutputTokens = Number(maxOutputInput);
      if (!Number.isInteger(contextWindowTokens) || contextWindowTokens < 8_192 || contextWindowTokens > 2_000_000) {
        setSettingsError('上下文窗口必须是 8,192 到 2,000,000 之间的整数。');
        return;
      }
      if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 128_000) {
        setSettingsError('最大输出必须是 256 到 128,000 之间的整数。');
        return;
      }
      if (maxOutputTokens >= contextWindowTokens) {
        setSettingsError('最大输出必须小于上下文窗口。');
        return;
      }
      const fetched = modelsFresh ? { models: draftProvider.models, model: draftProvider.model } : await fetchProviderModels();
      if (!fetched) return;
      const provider = { ...draftProvider, model: fetched.model, models: fetched.models, contextWindowTokens, maxOutputTokens };
      const providerInput = {
        id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl,
        model: provider.model, models: provider.models, contextWindowTokens: provider.contextWindowTokens,
        maxOutputTokens: provider.maxOutputTokens
      };
      const saved = await window.desktopAgent.saveSettings({
        activeProviderId: settingsDraft.activeProviderId,
        provider: providerInput,
        utilityModel: { providerId: provider.id, model: provider.model },
        ...(apiKey ? { apiKey } : {})
      });
      setSettings(saved);
      setSettingsDraft(saved);
      const activeProvider = providerById(saved, saved.activeProviderId);
      setSelectedModel((current) => activeProvider.models.includes(current) ? current : activeProvider.model);
      setApiKey('');
    }}>
      <div className="settings-heading"><div><h1 id="settings-title">模型</h1><p>配置模型服务、默认模型与上下文容量。</p></div></div>
      <section className="settings-section-card">
      <div className="settings-section-title"><h2>模型服务</h2><p>连接兼容的模型 API，配置将应用于新的智能体回合。</p></div>
      <div className="settings-fields">
        <label>API Base URL<input required value={draftProvider.baseUrl} onChange={(event) => { updateDraftProvider({ baseUrl: event.target.value }); setModelsFresh(false); setModelsError(''); }} /></label>
        <label>API Key <span>{draftProvider.hasApiKey ? '（已安全保存）' : ''}</span><input type="password" value={apiKey} placeholder={draftProvider.hasApiKey ? '留空以保留当前密钥' : '输入 API Key'} onChange={(event) => { setApiKey(event.target.value); setModelsFresh(false); setModelsError(''); }} /></label>
        <div className="model-setting">
          <div className="model-setting-head"><label htmlFor="default-model">默认模型</label><button type="button" disabled={modelsLoading} onClick={() => void fetchProviderModels()}>{modelsLoading ? '获取中…' : '刷新模型'}</button></div>
          <select id="default-model" required value={draftProvider.model} disabled={modelsLoading} onChange={(event) => updateDraftProvider({ model: event.target.value })}>
            {draftProvider.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <div className={`models-status ${modelsError ? 'failed' : ''}`}>{modelsError || (modelsFresh ? `已配置 ${draftProvider.models.length} 个模型` : 'Provider 配置已变化，保存时将自动重新获取')}</div>
        </div>
        <div className="settings-grid">
          <label>上下文窗口（tokens）<input type="number" required min="8192" max="2000000" step="1" value={contextWindowInput} onChange={(event) => { setContextWindowInput(event.target.value); setSettingsError(''); }} /></label>
          <label>最大输出（tokens）<input type="number" required min="256" max="128000" step="1" value={maxOutputInput} onChange={(event) => { setMaxOutputInput(event.target.value); setSettingsError(''); }} /></label>
        </div>
        {settingsError && <div className="settings-error" role="alert">{settingsError}</div>}
      </div>
      <p className="security-note">密钥由操作系统安全存储加密，不会写入普通配置或会话。</p>
      <div className="settings-actions"><button className="primary" type="submit" disabled={modelsLoading}>保存模型设置</button></div>
      </section>
    </form>}
    {settingsSection === 'permissions' && <PermissionsSettingsPage
      snapshot={permissionSnapshot}
      busy={permissionBusy}
      error={permissionError}
      {...(active?.workingDirectory ? { workingDirectory: active.workingDirectory } : {})}
      onRefresh={() => { void refreshPermissionGovernance(); }}
      onSave={savePermissionPolicy}
    />}
    {settingsSection === 'memory' && <MemorySettingsPage
      draft={memoryDraft}
      saved={settings.memory}
      status={memoryStatus}
      error={memoryError}
      busy={memoryBusy}
      {...(active?.workingDirectory ? { workingDirectory: active.workingDirectory } : {})}
      onChange={(next) => { setMemoryDraft(next); setMemoryError(''); }}
      onRefresh={() => { void refreshMemoryStatus(); }}
      onRebuild={(scope) => { void rebuildMemoryIndex(scope); }}
      onRebuildSemantic={() => { void rebuildSemanticMemoryIndex(); }}
      onDelete={deleteMemoryEntry}
      providers={settings.providers}
      utilityModel={settings.utilityModel}
      onAcceptCandidate={acceptMemoryCandidate}
      onRejectCandidate={rejectMemoryCandidate}
      onSave={async () => {
        setMemoryBusy(true);
        setMemoryError('');
        try {
          const saved = await window.desktopAgent.saveMemorySettings(memoryDraft);
          setMemoryDraft(saved);
          setSettings((current) => ({ ...current, memory: saved }));
          setSettingsDraft((current) => ({ ...current, memory: saved }));
          setMemoryStatus(await window.desktopAgent.getMemoryStatus(memoryDirectoryInput()));
        } catch (cause) {
          setMemoryError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setMemoryBusy(false);
        }
      }}
    />}
    {settingsSection === 'automations' && <SchedulerSettingsPage
      sessions={sessions}
      providers={settings.providers}
      teams={teams}
      schedules={schedules}
      selectedScheduleId={selectedScheduleId}
      runs={scheduleRuns}
      busy={schedulerBusy}
      error={schedulerError}
      onSelect={selectSchedule}
      onClose={() => { setSelectedScheduleId(null); selectedScheduleIdRef.current = null; setScheduleRuns([]); }}
      onRefresh={() => { void refreshSchedules(); }}
      onSave={saveSchedule}
      onDelete={deleteSchedule}
      onEnabled={setScheduleEnabled}
      onRunNow={runScheduleNow}
      onCancelRun={cancelScheduleRun}
      onOpenConversation={(sessionId, messageId) => { void openConversationMessage(sessionId, messageId); }}
    />}
    {settingsSection === 'channels' && <ChannelsSettingsPage api={window.desktopAgent} />}
    {settingsSection === 'teams' && <TeamSettingsPage
      {...(active?.workingDirectory ? { workspace: active.workingDirectory } : {})}
      teams={teams}
      selectedTeamId={selectedTeamId}
      status={teamStatus}
      busy={teamBusy}
      error={teamError}
      onSelect={selectTeam}
      onRefresh={() => { void refreshTeams(); }}
      onSave={saveTeam}
      onDelete={deleteTeam}
      onToggleMember={toggleTeamMember}
    />}
    {settingsSection === 'browser' && <BrowserSettingsPage
      enabled={extensionDraft.browser.enabled}
      mode={extensionDraft.browser.mode}
      domains={browserDomains}
      recordings={browserRecordings}
      recordingsBusy={browserRecordingsBusy}
      {...(active?.workingDirectory ? { workingDirectory: active.workingDirectory } : {})}
      error={extensionError}
      onEnabledChange={(enabled) => setExtensionDraft((current) => ({ ...current, browser: { ...current.browser, enabled } }))}
      onModeChange={(mode) => setExtensionDraft((current) => ({ ...current, browser: { ...current.browser, mode } }))}
      onDomainsChange={setBrowserDomains}
      onRefreshRecordings={() => { void refreshBrowserRecordings(active?.workingDirectory); }}
      onTrustRecording={(recordingId) => {
        if (!active?.workingDirectory) return;
        setBrowserRecordingsBusy(true); setExtensionError('');
        void window.desktopAgent.trustProjectBrowserRecording({ recordingId, workingDirectory: active.workingDirectory })
          .then(setBrowserRecordings)
          .catch((cause) => setExtensionError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBrowserRecordingsBusy(false));
      }}
      onRevokeRecording={(recordingId) => {
        if (!active?.workingDirectory) return;
        setBrowserRecordingsBusy(true); setExtensionError('');
        void window.desktopAgent.revokeProjectBrowserRecordingTrust({ recordingId, workingDirectory: active.workingDirectory })
          .then(setBrowserRecordings)
          .catch((cause) => setExtensionError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBrowserRecordingsBusy(false));
      }}
      onDeleteRecording={(recordingId) => {
        if (!active?.workingDirectory || !window.confirm(`删除 Recording ${recordingId}？此操作会删除当前生效的 user/project YAML。`)) return;
        setBrowserRecordingsBusy(true); setExtensionError('');
        void window.desktopAgent.deleteBrowserRecording({ recordingId, workingDirectory: active.workingDirectory })
          .then(setBrowserRecordings)
          .catch((cause) => setExtensionError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBrowserRecordingsBusy(false));
      }}
      onSubmit={async () => {
        setExtensionError('');
        try { await saveExtensionDraft(); }
        catch (cause) { setExtensionError(cause instanceof Error ? cause.message : String(cause)); }
      }}
    />}
    {settingsSection === 'hooks' && <HooksSettingsPage
      workingDirectory={active?.workingDirectory}
      snapshot={hookStatus}
      error={hookError}
      busy={hookBusy}
      onReload={() => { void runHookAction(() => window.desktopAgent.reloadHooks(hookDirectoryInput())); }}
      onOpenConfig={(source) => {
        void runHookAction(async () => {
          await window.desktopAgent.openHookConfig({ source, ...(source === 'project' ? hookDirectoryInput() : {}) });
          return window.desktopAgent.getHookStatus(hookDirectoryInput());
        });
      }}
      onTrust={() => {
        const input = hookDirectoryInput();
        if (!input) return;
        void runHookAction(() => window.desktopAgent.trustProjectHooks(input));
      }}
      onDisable={() => {
        const input = hookDirectoryInput();
        if (!input) return;
        void runHookAction(() => window.desktopAgent.disableProjectHooks(input));
      }}
    />}
    {(settingsSection === 'mcp' || settingsSection === 'skills') && <form className={`settings-content extensions-settings-page ${extensionEditorOpen && settingsSection === 'mcp' ? 'mcp-editor-visible' : ''}`} aria-labelledby="extensions-title" onSubmit={async (event) => {
      event.preventDefault();
      setExtensionError('');
      try {
        await saveExtensionDraft();
      } catch (cause) {
        setExtensionError(cause instanceof Error ? cause.message : String(cause));
      }
    }}>
      <div className="extensions-workspace">
      <section className="extensions-page">
      <header className="extensions-titlebar">
        <strong>MCP 服务</strong>
        <button type="button" aria-label="返回会话" title="返回会话" onClick={() => setSettingsOpen(false)}>×</button>
      </header>
      <div className="extensions-page-body">
        <div className="extensions-page-heading">
          <div><h2 id="extensions-title">{settingsSection === 'mcp' ? 'MCP 服务' : '技能'}</h2><p>{settingsSection === 'mcp' ? '安装新的 MCP 服务，为智能体扩展更多工具。' : '管理本地 Skills 和额外目录。'}</p></div>
          {settingsSection === 'mcp'
            ? <button className="extension-add-button" type="button" onClick={() => setExtensionEditorOpen(true)}><span aria-hidden="true">＋</span>添加</button>
            : <div className="extension-heading-actions">
              <button className="extension-add-button" type="button" disabled={skillOperationBusy} onClick={() => void importSkill()}><span aria-hidden="true">⇧</span>导入</button>
              <button className="extension-add-button primary" type="button" onClick={() => { setSkillCreateOpen(true); setExtensionError(''); }}><span aria-hidden="true">＋</span>创建</button>
              <button className="extension-add-button" type="button" onClick={() => setExtensionEditorOpen(true)}>目录设置</button>
            </div>}
        </div>
        <div className="extensions-toolbar">
          <span className="extension-scope">{settingsSection === 'skills' ? `${visibleSkills.length} 个已发现技能` : '用户级服务'}</span>
          {(extensionDraft.mcpServers.length > 0 || settingsSection === 'skills') && <label className="extension-search"><span aria-hidden="true">⌕</span><input value={extensionSearch} onChange={(event) => setExtensionSearch(event.target.value)} placeholder={settingsSection === 'skills' ? '搜索技能' : '搜索 MCP'} aria-label={settingsSection === 'skills' ? '搜索技能' : '搜索 MCP'} /></label>}
        </div>
        {extensionEditorOpen && settingsSection === 'skills' && <section className="extension-editor skill-editor" aria-label="Skill 目录设置">
          <div className="extension-editor-head"><div><strong>额外 Skill 目录</strong><span>每行一个绝对路径；项目和用户级目录会自动发现</span></div><button type="button" onClick={() => setExtensionEditorOpen(false)}>完成</button></div>
          <textarea className="skill-directories" value={skillDirectories} onChange={(event) => setSkillDirectories(event.target.value)} placeholder="/absolute/path/to/skills" aria-label="Skill 目录" />
        </section>}
      <section className="extension-catalog" aria-live="polite">
        {settingsSection === 'skills' && filteredVisibleSkills.map((skill) => {
          const enabled = !extensionDraft.skills.disabled.includes(skill.id) && !skill.error;
          return <article className="extension-item skill-item" key={`${skill.id}-${skill.path}`} title={skill.path} onClick={() => void openSkillDetail(skill)}>
            <ExtensionIcon kind="skill" />
            <div className="extension-item-copy"><strong>{skill.name}</strong><span>{skill.error || skill.description}</span></div>
            <span className={`extension-item-meta ${skill.error ? 'failed' : ''}`}>{skill.error ? '错误' : skillScope(skill)}</span>
            <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? '停用' : '启用'} ${skill.name}`} className={`extension-switch ${enabled ? 'on' : ''}`} disabled={Boolean(skill.error)} onClick={(event) => { event.stopPropagation(); setExtensionDraft((current) => ({
              ...current,
              skills: {
                ...current.skills,
                disabled: enabled
                  ? [...new Set([...current.skills.disabled, skill.id])]
                  : current.skills.disabled.filter((id) => id !== skill.id)
              }
            })); }}><span /></button>
          </article>;
        })}
        {settingsSection === 'mcp' && extensionDraft.mcpServers.filter((server) => {
          const query = extensionSearch.trim().toLowerCase();
          const target = server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url;
          return !query || `${server.name} ${server.id} ${target}`.toLowerCase().includes(query);
        }).map((server) => {
          const status = extensionStatus.mcpServers.find((item) => item.serverId === server.id);
          const detail = server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url;
          const oauth = server.transport === 'streamable_http' && server.auth?.type === 'oauth';
          const capabilityText = `工作区 ${server.security?.workspaceAccess ?? 'none'} · 网络 ${server.security?.network ?? 'none'} · 沙箱 ${server.security?.sandboxMode ?? 'fallback'}`;
          const statusText = status?.state === 'connected'
            ? [`${status.toolCount} 个工具`, ...(status.resourceCount ? [`${status.resourceCount} 个资源`] : []), ...(status.promptCount ? [`${status.promptCount} 个提示词`] : [])].join(' · ')
            : status?.state === 'connecting' ? '连接中' : status?.state === 'trust_required' ? `需要信任此配置 · ${capabilityText}${status.fingerprint ? ` · ${status.fingerprint.slice(0, 12)}` : ''}${server.transport === 'stdio' && ['npx', 'uvx'].includes(server.command) ? ' · 可能下载并执行代码' : ''}` : status?.state === 'authorizing' ? '等待登录' : status?.state === 'auth_required' ? '需要登录' : status?.state === 'error' ? (status.error || '连接失败') : server.enabled ? '等待连接' : '已停用';
          return <article className="extension-item" key={server.id} title={detail}>
            <ExtensionIcon kind="mcp" />
            <div className="extension-item-copy"><strong>{server.name}</strong><span>{detail}</span></div>
            <span className={`extension-item-meta ${status?.state === 'error' ? 'failed' : ''}`}>{server.transport === 'stdio' ? '本地' : '远程'} · {statusText}</span>
            <div className="extension-item-actions">
            {status?.state === 'trust_required' && server.enabled && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id} onClick={async () => {
              setExtensionError(''); setOauthBusyServerId(server.id);
              try {
                await saveExtensionDraft();
                await window.desktopAgent.trustMcpServer({ serverId: server.id });
                await refreshExtensionStatus();
              } catch (cause) {
                setExtensionError(cause instanceof Error ? cause.message : String(cause));
              } finally { setOauthBusyServerId(''); }
            }}>{oauthBusyServerId === server.id ? '处理中…' : '信任并连接'}</button>}
            {oauth && server.enabled && status?.state !== 'trust_required' && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id || status?.state === 'authorizing'} onClick={async () => {
              setExtensionError(''); setOauthBusyServerId(server.id);
              try {
                await saveExtensionDraft();
                if (status?.state === 'connected') await window.desktopAgent.disconnectMcpOAuth({ serverId: server.id });
                else await window.desktopAgent.connectMcpOAuth({ serverId: server.id });
                await refreshExtensionStatus();
              } catch (cause) {
                setExtensionError(cause instanceof Error ? cause.message : String(cause));
              } finally { setOauthBusyServerId(''); }
            }}>{oauthBusyServerId === server.id || status?.state === 'authorizing' ? '处理中…' : status?.state === 'connected' ? '断开账号' : '连接账号'}</button>}
            {server.enabled && status?.state !== 'auth_required' && status?.state !== 'trust_required' && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id || status?.state === 'connecting' || status?.state === 'authorizing'} onClick={async () => {
              setExtensionError(''); setOauthBusyServerId(server.id);
              try {
                await saveExtensionDraft();
                await window.desktopAgent.reconnectMcp({ serverId: server.id });
                await refreshExtensionStatus();
              } catch (cause) {
                setExtensionError(cause instanceof Error ? cause.message : String(cause));
              } finally { setOauthBusyServerId(''); }
            }}>{status?.state === 'connecting' ? '重连中…' : '重新连接'}</button>}
            {server.enabled && status && status.state !== 'trust_required' && status.state !== 'disabled' && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id} onClick={async () => {
              setExtensionError(''); setOauthBusyServerId(server.id);
              try {
                await window.desktopAgent.revokeMcpServerTrust({ serverId: server.id });
                await refreshExtensionStatus();
              } catch (cause) {
                setExtensionError(cause instanceof Error ? cause.message : String(cause));
              } finally { setOauthBusyServerId(''); }
            }}>撤销信任</button>}
            <button type="button" role="switch" aria-checked={server.enabled} aria-label={`${server.enabled ? '停用' : '启用'} ${server.name}`} className={`extension-switch ${server.enabled ? 'on' : ''}`} onClick={() => {
              const servers = extensionDraft.mcpServers.map((item) => item.id === server.id ? { ...item, enabled: !server.enabled } : item);
              setExtensionDraft((current) => ({ ...current, mcpServers: servers }));
              setMcpServersJson(JSON.stringify(servers, null, 2));
            }}><span /></button>
            </div>
          </article>;
        })}
        {((settingsSection === 'skills' && filteredVisibleSkills.length === 0)
          || (settingsSection === 'mcp' && extensionDraft.mcpServers.filter((server) => `${server.name} ${server.id} ${server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}`.toLowerCase().includes(extensionSearch.trim().toLowerCase())).length === 0))
          && <div className="extension-empty-state"><span className="mcp-empty-illustration" aria-hidden="true"><i /><b /><em /></span><strong>{extensionSearch ? '没有匹配结果' : settingsSection === 'skills' ? '尚未发现 Skill' : '暂无 MCP 服务'}</strong><span>{extensionSearch ? '尝试其他关键词' : settingsSection === 'skills' ? '可通过 install_skill 或目录设置添加' : '点击右上角“添加”，在数据输入栏中配置服务'}</span></div>}
      </section>
      {extensionError && <div className="settings-error extension-error" role="alert">{extensionError}</div>}
      <footer className="extensions-footer"><p>{settingsSection === 'mcp' ? 'MCP Server 配置需先按指纹信任；配置变化后会自动失效。工具默认逐次批准，也可仅授权当前会话。' : 'Skill 完整内容仅在模型调用 load_skill 后进入上下文。'}</p><div><button className="primary" type="submit">保存更改</button></div></footer>
      </div>
      </section>
      {extensionEditorOpen && settingsSection === 'mcp' && <aside className="mcp-data-panel" aria-label="MCP 数据输入栏">
        <header className="mcp-data-tabs"><div><span aria-hidden="true">{'{ }'}</span><strong>mcp.json</strong></div><button type="button" aria-label="关闭数据输入栏" title="关闭" onClick={() => setExtensionEditorOpen(false)}>×</button></header>
        <div className="mcp-data-path"><span>用户级</span><b>›</b><span>mcp.json</span></div>
        <div className="mcp-code-editor">
          <div className="mcp-line-numbers" ref={mcpLineNumbersRef} aria-hidden="true">{mcpServersJson.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div>
          <textarea className="extension-json" spellCheck={false} value={mcpServersJson} onChange={(event) => {
            const value = event.target.value;
            setMcpServersJson(value);
            try {
              const parsed = JSON.parse(value) as unknown;
              if (Array.isArray(parsed)) setExtensionDraft((current) => ({ ...current, mcpServers: parsed as ExtensionSettings['mcpServers'] }));
            } catch { /* Keep the last valid list while JSON is being edited. */ }
          }} onScroll={(event) => { if (mcpLineNumbersRef.current) mcpLineNumbersRef.current.scrollTop = event.currentTarget.scrollTop; }} aria-label="MCP Server JSON 配置" />
        </div>
        <details className="extension-example"><summary>查看配置格式</summary><pre>{`[
  { "id": "local", "name": "Local MCP", "enabled": true,
    "transport": "stdio", "command": "npx", "args": ["-y", "server-package"],
    "security": { "workspaceAccess": "none", "network": "none", "sandboxMode": "fallback" } },
  { "id": "remote", "name": "Remote MCP", "enabled": true,
    "transport": "streamable_http", "url": "https://example.com/mcp",
    "headers": { "Authorization": { "secretRef": { "provider": "env", "key": "MCP_AUTH" } } },
    "security": { "network": "outbound", "trustedReadTools": ["search"] } }
]`}</pre></details>
      </aside>}
      </div>
    </form>}
        </div>
      </main>
    </section>}
    {skillCreateOpen && <div className="skill-detail-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSkillCreateOpen(false); }}>
      <form className="skill-create-modal" role="dialog" aria-modal="true" aria-labelledby="skill-create-title" onSubmit={async (event) => {
        event.preventDefault(); setExtensionError(''); setSkillOperationBusy(true);
        try {
          await window.desktopAgent.createSkill({ name: skillCreateName, description: skillCreateDescription, instructions: skillCreateInstructions });
          setSkillCreateOpen(false); setSkillCreateName(''); setSkillCreateDescription(''); setSkillCreateInstructions('');
          await refreshExtensionStatus(active?.workingDirectory);
        } catch (cause) { setExtensionError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setSkillOperationBusy(false); }
      }}>
        <header><div><h2 id="skill-create-title">创建 Skill</h2><p>将创建标准根目录，并初始化 scripts、templates、references。</p></div><button type="button" aria-label="关闭" onClick={() => setSkillCreateOpen(false)}>×</button></header>
        <label>名称<input autoFocus value={skillCreateName} onChange={(event) => setSkillCreateName(event.target.value)} placeholder="例如 code-reviewer" required /></label>
        <label>描述<textarea value={skillCreateDescription} onChange={(event) => setSkillCreateDescription(event.target.value)} placeholder="说明何时应使用这个 Skill" required /></label>
        <label>初始说明<textarea className="skill-create-instructions" value={skillCreateInstructions} onChange={(event) => setSkillCreateInstructions(event.target.value)} placeholder="# Workflow\n\n写下执行步骤（可稍后编辑）" /></label>
        {extensionError && <div className="settings-error" role="alert">{extensionError}</div>}
        <footer><button type="button" onClick={() => setSkillCreateOpen(false)}>取消</button><button className="primary" type="submit" disabled={skillOperationBusy}>{skillOperationBusy ? '创建中…' : '创建 Skill'}</button></footer>
      </form>
    </div>}
    {selectedSkill && <div className="skill-detail-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) closeSkillDetail(); }}>
      <article className="skill-detail-modal" role="dialog" aria-modal="true" aria-labelledby="skill-detail-title">
        <header className="skill-detail-header">
          <ExtensionIcon kind="skill" />
          <div className="skill-detail-controls">
            {skillDetail && !skillEditing && <button className="skill-action-button" type="button" onClick={() => setSkillEditing(true)}>编辑</button>}
            <button className="skill-action-button" type="button" disabled={skillOperationBusy} onClick={() => void importSkill(selectedSkill.path)}>更新</button>
            <button className="skill-action-button" type="button" disabled={skillOperationBusy} onClick={async () => {
              setSkillDetailError(''); setSkillOperationBusy(true);
              try { await window.desktopAgent.exportSkill({ path: selectedSkill.path }); }
              catch (cause) { setSkillDetailError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setSkillOperationBusy(false); }
            }}>导出</button>
            <button type="button" role="switch" aria-checked={!extensionDraft.skills.disabled.includes(selectedSkill.id) && !selectedSkill.error && !selectedSkill.overriddenBy} aria-label={`${extensionDraft.skills.disabled.includes(selectedSkill.id) ? '启用' : '停用'} ${selectedSkill.name}`} className={`extension-switch ${!extensionDraft.skills.disabled.includes(selectedSkill.id) && !selectedSkill.error && !selectedSkill.overriddenBy ? 'on' : ''}`} disabled={Boolean(selectedSkill.error || selectedSkill.overriddenBy)} onClick={() => setExtensionDraft((current) => {
              const enabled = !current.skills.disabled.includes(selectedSkill.id);
              return { ...current, skills: { ...current.skills, disabled: enabled ? [...new Set([...current.skills.disabled, selectedSkill.id])] : current.skills.disabled.filter((id) => id !== selectedSkill.id) } };
            })}><span /></button>
            <button className="skill-detail-close" type="button" aria-label="关闭技能详情" title="关闭" onClick={closeSkillDetail}>×</button>
          </div>
        </header>
        <div className="skill-detail-heading">
          <h2 id="skill-detail-title">{selectedSkill.name} <span>Skill</span></h2>
          <p>{selectedSkill.description}</p>
          <div className="skill-resource-summary">
            {(['scripts', 'templates', 'references'] as const).map((name) => <span key={name}><b>{name}</b>{selectedSkill.resources[name].length} 个文件</span>)}
            {selectedSkill.overriddenBy && <span className="overridden">此版本已被 {selectedSkill.overriddenBy} 覆盖</span>}
          </div>
        </div>
        <section className="skill-detail-content">
          {skillDetailLoading && <div className="skill-detail-state">正在载入 Skill 内容…</div>}
          {skillDetailError && <div className="skill-detail-state failed"><span>{skillDetailError}</span><button type="button" onClick={() => void openSkillDetail(selectedSkill)}>重新加载内容</button></div>}
          {skillDetail && !skillDetailError && (skillEditing
            ? <textarea className="skill-source-editor" spellCheck={false} value={skillEditorContent} onChange={(event) => setSkillEditorContent(event.target.value)} aria-label="SKILL.md 内容" />
            : <Markdown text={skillMarkdownContent(skillDetail.content)} />)}
        </section>
        <footer className="skill-detail-footer">
          <div className="skill-detail-path"><span title={selectedSkill.rootPath}>{selectedSkill.rootPath}</span><small>Skill 根目录</small></div>
          <div className="skill-detail-footer-actions">
            <button className="danger" type="button" disabled={skillOperationBusy || selectedSkill.origin === 'default'} title={selectedSkill.origin === 'default' ? '默认 Skill 不能删除，可用同名用户 Skill 覆盖' : undefined} onClick={async () => {
              if (!window.confirm(`将“${selectedSkill.name}”整个根目录移入废纸篓？`)) return;
              setSkillDetailError(''); setSkillOperationBusy(true);
              try { await window.desktopAgent.trashSkill({ path: selectedSkill.path }); closeSkillDetail(); await refreshExtensionStatus(active?.workingDirectory); }
              catch (cause) { setSkillDetailError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setSkillOperationBusy(false); }
            }}>移到废纸篓</button>
            {skillEditing && <button type="button" onClick={() => { setSkillEditing(false); setSkillEditorContent(skillDetail?.content ?? ''); }}>取消编辑</button>}
            <button className="primary" type="button" disabled={skillOperationBusy} onClick={async () => {
              setSkillDetailError(''); setSkillOperationBusy(true);
              try {
                if (skillEditing) await window.desktopAgent.updateSkill({ path: selectedSkill.path, content: skillEditorContent });
                await saveExtensionDraft(); closeSkillDetail(); await refreshExtensionStatus(active?.workingDirectory);
              } catch (cause) { setSkillDetailError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setSkillOperationBusy(false); }
            }}>{skillOperationBusy ? '处理中…' : skillEditing ? '保存 Skill' : '保存启停设置'}</button>
          </div>
        </footer>
      </article>
    </div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

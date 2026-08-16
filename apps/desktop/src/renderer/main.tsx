import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AgentEvent, ApprovalRequest, BrowserDockState, ExtensionSettings, ExtensionStatus, ImageContentBlock, Message, ProviderConfig, ProviderSettings, SessionMeta, SkillDetail, SkillStatus, WorkspaceChanges
} from '@desktop-agent/contracts';
import { DEFAULT_BROWSER_SETTINGS, DEFAULT_PROVIDERS, DEFAULT_SESSION_TITLE } from '@desktop-agent/contracts';
import {
  applyLiveEvent,
  buildConversationSnapshot,
  emptyLiveSteps,
  quoteCommandPart,
  type ConversationViewMode,
  type LiveStep
} from './conversation';
import { browserDomainIssue, parseBrowserDomainList } from './browser-settings';
import { ChatTranscript, ConversationViewTabs, Markdown, TrajectoryView } from './ConversationViews';
import { Sidebar } from './Sidebar';
import './styles.css';

type DiffLine = { type: 'addition' | 'deletion' | 'context' | 'hunk' | 'meta'; oldLine?: number; newLine?: number; text: string };
const FOLLOW_THRESHOLD = 24;

const defaultSettings: ProviderSettings = {
  activeProviderId: 'openai',
  providers: DEFAULT_PROVIDERS.map((provider) => ({ ...provider })),
  utilityModel: { providerId: 'openai', model: 'gpt-5-mini' },
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

function skillScope(skill: SkillStatus): string {
  return skill.origin === 'project' ? '项目' : skill.origin === 'user' ? '个人' : skill.origin === 'default' ? '默认' : '自定义';
}

function approvalTitle(request: ApprovalRequest): string {
  if (request.call.name.startsWith('mcp__')) return '调用外部 MCP 工具';
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
  if (request.call.name.startsWith('mcp__')) return 'MCP';
  if (request.call.name.startsWith('browser_')) return '浏览器';
  if (request.call.name === 'terminal') return '终端';
  if (request.call.name === 'read_file') return '文件';
  if (request.preview) return '文件修改';
  return request.call.name;
}

function approvalQuestion(request: ApprovalRequest): string {
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
  error,
  onEnabledChange,
  onModeChange,
  onDomainsChange,
  onSubmit
}: {
  enabled: boolean;
  mode: 'sandbox' | 'chrome';
  domains: string;
  error: string;
  onEnabledChange: (enabled: boolean) => void;
  onModeChange: (mode: 'sandbox' | 'chrome') => void;
  onDomainsChange: (domains: string) => void;
  onSubmit: () => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [draftError, setDraftError] = useState('');
  const list = parseBrowserDomainList(domains);

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
  </form>;
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
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ImageContentBlock[]>([]);
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [conversationView, setConversationView] = useState<ConversationViewMode>('chat');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [running, setRunning] = useState(false);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'models' | 'browser' | 'mcp' | 'skills'>('models');
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
  const [extensionDraft, setExtensionDraft] = useState<ExtensionSettings>(defaultSettings.extensions);
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus>({ mcpServers: [], skills: [] });
  const [mcpServersJson, setMcpServersJson] = useState('[]');
  const [skillDirectories, setSkillDirectories] = useState('');
  const [browserDomains, setBrowserDomains] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [browserSecret, setBrowserSecret] = useState<{ requestId: string; name: string; description?: string } | null>(null);
  const [browserSecretValue, setBrowserSecretValue] = useState('');
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
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChanges | null>(null);
  const [workspaceChangesError, setWorkspaceChangesError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewPath, setReviewPath] = useState('');
  const [browserDock, setBrowserDock] = useState<BrowserDockState | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [contextUsage, setContextUsage] = useState<{ estimated: number; window: number; compacted: number } | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const turnBaselineRef = useRef<WorkspaceChanges | null>(null);
  const mcpLineNumbersRef = useRef<HTMLDivElement>(null);

  const refreshSessions = async () => {
    const next = await window.desktopAgent.listSessions();
    sessionDirectoriesRef.current = new Map(next.map((session) => [session.id, session.workingDirectory]));
    setSessions(next);
    if (!activeIdRef.current && next[0]) selectSession(next[0].id);
  };

  const refreshExtensionStatus = async (workingDirectory = activeIdRef.current ? sessionDirectoriesRef.current.get(activeIdRef.current) : undefined): Promise<ExtensionStatus> => {
    const next = await window.desktopAgent.getExtensionStatus(workingDirectory ? { workingDirectory } : undefined);
    setExtensionStatus(next);
    return next;
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
    activeIdRef.current = id; turnBaselineRef.current = null; setActiveId(id); setError(''); setWorkspaceChangesError(''); setLiveSteps([]); setTurnStartedAt(null); setInspectedId(null); setReviewOpen(false); setWorkspaceChanges(null); setAttachments([]);
    const directory = sessionDirectoriesRef.current.get(id);
    if (directory) setCollapsedProjects((items) => items.filter((path) => path !== directory));
    setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    setContextUsage(null);
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
      setSelectedModel(providerById(saved, saved.activeProviderId).model);
      setExtensionDraft(saved.extensions);
    });
    void refreshExtensionStatus();
    const offSessions = window.desktopAgent.onSessionsChanged(() => void refreshSessions());
    const offExtensions = window.desktopAgent.onExtensionsChanged(() => void refreshExtensionStatus());
    const offSecret = window.desktopAgent.onBrowserSecretRequest((request) => {
      setBrowserSecret(request);
      setBrowserSecretValue('');
    });
    const offDock = window.desktopAgent.onBrowserDockState((state) => setBrowserDock(state));
    const offEvents = window.desktopAgent.onAgentEvent((event: AgentEvent) => {
      if (event.type === 'turn.started') {
        setRunning(true); setRunningSessionId(event.sessionId); setError(''); setLiveSteps(emptyLiveSteps()); setTurnStartedAt(Date.now());
        setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        setContextUsage(null);
      }
      else if (event.type === 'text.delta' || event.type === 'tool.started' || event.type === 'tool.progress' || event.type === 'tool.finished') {
        setLiveSteps((steps) => applyLiveEvent(steps, event));
      }
      else if (event.type === 'approval.required') setApproval(event.request);
      else if (event.type === 'usage') setUsage((current) => ({
        input: current.input + (event.inputTokens ?? 0), output: current.output + (event.outputTokens ?? 0),
        cacheRead: current.cacheRead + (event.cacheReadInputTokens ?? 0), cacheWrite: current.cacheWrite + (event.cacheWriteInputTokens ?? 0)
      }));
      else if (event.type === 'context.updated') setContextUsage({ estimated: event.estimatedTokens, window: event.contextWindowTokens, compacted: event.compactedMessages });
      else if (event.type === 'turn.failed') { setError(event.message); setRunning(false); setRunningSessionId(null); setTurnStartedAt(null); setApproval(null); void reloadActive(); }
      else if (event.type === 'turn.completed' || event.type === 'turn.cancelled') { setRunning(false); setRunningSessionId(null); setTurnStartedAt(null); setApproval(null); void reloadActive(); }
    });
    return () => { offSessions(); offExtensions(); offSecret(); offDock(); offEvents(); };
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
    setLiveSteps([]);
  };

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
      setRunningSessionId(null);
      setApproval(null);
      setMessages([]);
      setWorkspaceChanges(null);
      setReviewOpen(false);
      setLiveSteps([]);
      setTurnStartedAt(null);
      setInspectedId(null);
      setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      setContextUsage(null);
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
    if ((!text && images.length === 0) || !activeId || running) return;
    setDraft(''); setAttachments([]); setError(''); setRunning(true); setRunningSessionId(activeId); setLiveSteps(emptyLiveSteps()); setTurnStartedAt(Date.now()); setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); setContextUsage(null); atBottomRef.current = true; setAtBottom(true);
    setMessages((items) => [...items, { id: `pending-${Date.now()}`, role: 'user', createdAt: new Date().toISOString(), content: [...(text ? [{ type: 'text' as const, text }] : []), ...images] }]);
    try {
      turnBaselineRef.current = await loadWorkspaceChanges(activeId);
      await window.desktopAgent.startTurn({ sessionId: activeId, text, images, providerId: settings.activeProviderId, model: selectedModel });
    }
    catch (cause) { setDraft(text); setAttachments(images); setRunning(false); setRunningSessionId(null); setTurnStartedAt(null); setLiveSteps([]); setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const active = sessions.find((session) => session.id === activeId);
  const selectedProvider = providerById(settings, settings.activeProviderId);
  const draftProvider = providerById(settingsDraft, settingsDraft.activeProviderId);
  const updateDraftProvider = (update: Partial<ProviderConfig>) => setSettingsDraft((current) => ({
    ...current,
    providers: current.providers.map((provider) => provider.id === current.activeProviderId ? { ...provider, ...update } : provider)
  }));
  const sessionBusy = runningSessionId === activeId;
  const overlayOpen = settingsOpen || Boolean(approval) || Boolean(browserSecret) || skillCreateOpen || Boolean(selectedSkill);
  const visibleDock = browserDock && activeId && browserDock.sessionId === activeId ? browserDock : null;
  const browsing = Boolean(visibleDock);
  const snapshot = useMemo(() => buildConversationSnapshot({
    messages,
    liveSteps: sessionBusy ? liveSteps : [],
    running: sessionBusy,
    ...(active?.workingDirectory ? { workingDirectory: active.workingDirectory } : {})
  }), [messages, liveSteps, sessionBusy, active?.workingDirectory]);

  useLayoutEffect(() => {
    const el = conversationRef.current;
    if (!el || !atBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot, workspaceChanges, conversationView, error]);

  useLayoutEffect(() => {
    if (!activeId || visibleDock) return;
    void window.desktopAgent.setBrowserDockLayout({ sessionId: activeId, overlayOpen, bounds: null });
  }, [activeId, overlayOpen, visibleDock]);

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

  const openReview = (path?: string) => {
    if (!workspaceChanges?.files.length) return;
    setReviewPath(path ?? workspaceChanges.files[0]!.path);
    setReviewOpen(true);
  };

  const openSettings = (section: 'models' | 'browser' | 'mcp' | 'skills' = 'models') => {
    const provider = providerById(settings, settings.activeProviderId);
    setSettingsDraft(settings); setApiKey(''); setModelsFresh(true); setModelsError(''); setSettingsError('');
    setContextWindowInput(String(provider.contextWindowTokens));
    setMaxOutputInput(String(provider.maxOutputTokens));
    setExtensionDraft(settings.extensions);
    setMcpServersJson(JSON.stringify(settings.extensions.mcpServers, null, 2));
    setSkillDirectories(settings.extensions.skills.directories.join('\n'));
    setBrowserDomains(settings.extensions.browser.allowedDomains.join('\n'));
    setExtensionError(''); setExtensionSearch(''); setExtensionEditorOpen(false);
    void refreshExtensionStatus(active?.workingDirectory);
    setSettingsSection(section);
    setSettingsOpen(true);
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

  return <div className="app-shell">
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
          <div><h1>{active.title}</h1><div className="working-directory">{active.workingDirectory}</div></div>
          <ConversationViewTabs mode={conversationView} onChange={setConversationView} />
        </header>
        <div className={`workspace-content ${browsing ? 'browsing' : reviewOpen ? 'reviewing' : ''}`}>
        <div className="chat-pane">
        <div className="conversation" ref={conversationRef} onScroll={onConversationScroll} role="region" aria-label="对话记录">
          {snapshot.nodes.length === 0 && !sessionBusy && conversationView === 'chat' && <div className="empty"><div className="empty-icon">⌁</div><h2>从本地项目开始</h2><p>可以让我阅读文件、列出目录，或在你批准后执行命令。</p></div>}
          {conversationView === 'chat'
            ? <ChatTranscript snapshot={snapshot} running={sessionBusy} turnStartedAt={turnStartedAt} onInspect={inspectRecord} />
            : <TrajectoryView snapshot={snapshot} selectedId={inspectedId} onSelect={setInspectedId} />}
          {error && <div className="error-banner">{error}</div>}
          {workspaceChangesError && <div className="changes-error">无法读取文件修改：{workspaceChangesError}</div>}
          {!sessionBusy && messages.length > 0 && workspaceChanges && workspaceChanges.files.length > 0 && <WorkspaceChangesCard changes={workspaceChanges} onReview={openReview} />}
          {!atBottom && <button type="button" className="to-bottom" aria-label="回到底部" title="回到底部" onClick={() => { const el = conversationRef.current; if (!el) return; el.scrollTop = el.scrollHeight; atBottomRef.current = true; setAtBottom(true); }}>↓</button>}
        </div>
        <footer className="composer-wrap"><div className="composer">
          {attachments.length > 0 && <div className="composer-attachments" aria-label="待发送图片">{attachments.map((image, index) => <figure key={`${image.name ?? 'image'}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? '待发送图片'} /><button type="button" aria-label={`移除 ${image.name ?? '图片'}`} onClick={() => setAttachments((items) => items.filter((_, itemIndex) => itemIndex !== index))}>×</button><figcaption>{image.name ?? '图片'}</figcaption></figure>)}</div>}
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="随心输入" rows={2}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
          <div className="composer-toolbar">
            <div className="composer-context"><span className="approval-status">⌁ 文件修改与 Terminal 需批准</span>{contextUsage && <span className="context-status" title={contextUsage.compacted ? `已压缩 ${contextUsage.compacted} 条历史消息` : '上下文估算'}>{Math.round(contextUsage.estimated / 1000)}k / {Math.round(contextUsage.window / 1000)}k</span>}{(usage.input > 0 || usage.output > 0) && <span className="context-status" title={`缓存读取 ${usage.cacheRead} · 缓存写入 ${usage.cacheWrite}`}>↑{usage.input} ↓{usage.output}</span>}</div>
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
    {settingsOpen && <section className="settings-screen" aria-label="设置">
      <aside className="settings-navigation">
        <button className="settings-back" type="button" onClick={() => setSettingsOpen(false)}><span aria-hidden="true">←</span> 返回</button>
        <nav aria-label="设置分类">
          <button type="button" className={settingsSection === 'models' ? 'active' : ''} onClick={() => { setSettingsSection('models'); setExtensionEditorOpen(false); }}><span aria-hidden="true">◇</span> 模型</button>
          <button type="button" className={settingsSection === 'browser' ? 'active' : ''} onClick={() => { setSettingsSection('browser'); setExtensionEditorOpen(false); }}><span aria-hidden="true">◎</span> 浏览器</button>
          <button type="button" className={settingsSection === 'skills' ? 'active' : ''} onClick={() => { setSettingsSection('skills'); setExtensionSearch(''); setExtensionEditorOpen(false); }}><span aria-hidden="true">⬡</span> 技能</button>
          <button type="button" className={settingsSection === 'mcp' ? 'active' : ''} onClick={() => { setSettingsSection('mcp'); setExtensionSearch(''); setExtensionEditorOpen(false); }}><span aria-hidden="true">⌘</span> MCP 服务</button>
        </nav>
      </aside>
      <main className="settings-main">
        <header className="settings-topbar"><strong>{settingsSection === 'models' ? '模型' : settingsSection === 'browser' ? '浏览器' : settingsSection === 'skills' ? '技能' : 'MCP 服务'}</strong></header>
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
    {settingsSection === 'browser' && <BrowserSettingsPage
      enabled={extensionDraft.browser.enabled}
      mode={extensionDraft.browser.mode}
      domains={browserDomains}
      error={extensionError}
      onEnabledChange={(enabled) => setExtensionDraft((current) => ({ ...current, browser: { ...current.browser, enabled } }))}
      onModeChange={(mode) => setExtensionDraft((current) => ({ ...current, browser: { ...current.browser, mode } }))}
      onDomainsChange={setBrowserDomains}
      onSubmit={async () => {
        setExtensionError('');
        try { await saveExtensionDraft(); }
        catch (cause) { setExtensionError(cause instanceof Error ? cause.message : String(cause)); }
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
          <span className="extension-scope">{settingsSection === 'skills' ? `${extensionStatus.skills.length} 个已发现技能` : '用户级服务'}</span>
          {(extensionDraft.mcpServers.length > 0 || settingsSection === 'skills') && <label className="extension-search"><span aria-hidden="true">⌕</span><input value={extensionSearch} onChange={(event) => setExtensionSearch(event.target.value)} placeholder={settingsSection === 'skills' ? '搜索技能' : '搜索 MCP'} aria-label={settingsSection === 'skills' ? '搜索技能' : '搜索 MCP'} /></label>}
        </div>
        {extensionEditorOpen && settingsSection === 'skills' && <section className="extension-editor skill-editor" aria-label="Skill 目录设置">
          <div className="extension-editor-head"><div><strong>额外 Skill 目录</strong><span>每行一个绝对路径；项目和用户级目录会自动发现</span></div><button type="button" onClick={() => setExtensionEditorOpen(false)}>完成</button></div>
          <textarea className="skill-directories" value={skillDirectories} onChange={(event) => setSkillDirectories(event.target.value)} placeholder="/absolute/path/to/skills" aria-label="Skill 目录" />
        </section>}
      <section className="extension-catalog" aria-live="polite">
        {settingsSection === 'skills' && extensionStatus.skills.filter((skill) => {
          const query = extensionSearch.trim().toLowerCase();
          return !query || `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(query);
        }).map((skill) => {
          const enabled = !extensionDraft.skills.disabled.includes(skill.id) && !skill.error && !skill.overriddenBy;
          return <article className="extension-item skill-item" key={`${skill.id}-${skill.path}`} title={skill.path} onClick={() => void openSkillDetail(skill)}>
            <ExtensionIcon kind="skill" />
            <div className="extension-item-copy"><strong>{skill.name}</strong><span>{skill.error || skill.description}</span></div>
            <span className={`extension-item-meta ${skill.error ? 'failed' : ''}`}>{skill.error ? '错误' : skill.overriddenBy ? '已被覆盖' : skillScope(skill)}</span>
            <button type="button" role="switch" aria-checked={enabled} aria-label={`${enabled ? '停用' : '启用'} ${skill.name}`} className={`extension-switch ${enabled ? 'on' : ''}`} disabled={Boolean(skill.error || skill.overriddenBy)} onClick={(event) => { event.stopPropagation(); setExtensionDraft((current) => ({
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
          const statusText = status?.state === 'connected'
            ? [`${status.toolCount} 个工具`, ...(status.resourceCount ? [`${status.resourceCount} 个资源`] : []), ...(status.promptCount ? [`${status.promptCount} 个提示词`] : [])].join(' · ')
            : status?.state === 'connecting' ? '连接中' : status?.state === 'authorizing' ? '等待登录' : status?.state === 'auth_required' ? '需要登录' : status?.state === 'error' ? (status.error || '连接失败') : server.enabled ? '等待连接' : '已停用';
          return <article className="extension-item" key={server.id} title={detail}>
            <ExtensionIcon kind="mcp" />
            <div className="extension-item-copy"><strong>{server.name}</strong><span>{detail}</span></div>
            <span className={`extension-item-meta ${status?.state === 'error' ? 'failed' : ''}`}>{server.transport === 'stdio' ? '本地' : '远程'} · {statusText}</span>
            <div className="extension-item-actions">
            {oauth && server.enabled && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id || status?.state === 'authorizing'} onClick={async () => {
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
            {server.enabled && status?.state !== 'auth_required' && <button type="button" className="extension-auth-button" disabled={oauthBusyServerId === server.id || status?.state === 'connecting' || status?.state === 'authorizing'} onClick={async () => {
              setExtensionError(''); setOauthBusyServerId(server.id);
              try {
                await saveExtensionDraft();
                await window.desktopAgent.reconnectMcp({ serverId: server.id });
                await refreshExtensionStatus();
              } catch (cause) {
                setExtensionError(cause instanceof Error ? cause.message : String(cause));
              } finally { setOauthBusyServerId(''); }
            }}>{status?.state === 'connecting' ? '重连中…' : '重新连接'}</button>}
            <button type="button" role="switch" aria-checked={server.enabled} aria-label={`${server.enabled ? '停用' : '启用'} ${server.name}`} className={`extension-switch ${server.enabled ? 'on' : ''}`} onClick={() => {
              const servers = extensionDraft.mcpServers.map((item) => item.id === server.id ? { ...item, enabled: !server.enabled } : item);
              setExtensionDraft((current) => ({ ...current, mcpServers: servers }));
              setMcpServersJson(JSON.stringify(servers, null, 2));
            }}><span /></button>
            </div>
          </article>;
        })}
        {((settingsSection === 'skills' && extensionStatus.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path}`.toLowerCase().includes(extensionSearch.trim().toLowerCase())).length === 0)
          || (settingsSection === 'mcp' && extensionDraft.mcpServers.filter((server) => `${server.name} ${server.id} ${server.transport === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}`.toLowerCase().includes(extensionSearch.trim().toLowerCase())).length === 0))
          && <div className="extension-empty-state"><span className="mcp-empty-illustration" aria-hidden="true"><i /><b /><em /></span><strong>{extensionSearch ? '没有匹配结果' : settingsSection === 'skills' ? '尚未发现 Skill' : '暂无 MCP 服务'}</strong><span>{extensionSearch ? '尝试其他关键词' : settingsSection === 'skills' ? '可通过 install_skill 或目录设置添加' : '点击右上角“添加”，在数据输入栏中配置服务'}</span></div>}
      </section>
      {extensionError && <div className="settings-error extension-error" role="alert">{extensionError}</div>}
      <footer className="extensions-footer"><p>{settingsSection === 'mcp' ? '所有 MCP 工具执行前均需批准，请只配置可信服务。' : 'Skill 完整内容仅在模型调用 load_skill 后进入上下文。'}</p><div><button className="primary" type="submit">保存更改</button></div></footer>
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
    "transport": "stdio", "command": "npx", "args": ["-y", "server-package"] },
  { "id": "remote", "name": "Remote MCP", "enabled": true,
    "transport": "streamable_http", "url": "https://example.com/mcp",
    "versionNegotiation": "auto" }
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

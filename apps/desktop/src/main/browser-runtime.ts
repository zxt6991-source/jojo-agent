import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebContentsView, type BrowserWindow, type DownloadItem, type Session, type WebContents } from 'electron';
import {
  BrowserActionSchema,
  BrowserRecordingStepSchema,
  type BrowserAction,
  type BrowserDockState,
  type BrowserFramePath,
  type BrowserHealCandidate,
  type BrowserHealProposal,
  type BrowserRecordingDocument,
  type BrowserRecordingRegistrySnapshot,
  type BrowserRecordingStep,
  type BrowserSettings,
  type BrowserTarget,
  type BrowserVerify,
  type ToolResult
} from '@desktop-agent/contracts';
import {
  BROWSER_RECORDER_BINDING_NAME,
  BROWSER_RECORDER_GUARD_NAME,
  BrowserRecordingRegistry,
  BrowserReplayJournalStore,
  FileBrowserRecordingTrustStore,
  MAX_RAW_BROWSER_EVENTS,
  compileUserDemoRecording,
  analyzeBrowserReplayResume,
  createBrowserReplayJournalEntry,
  createBrowserRecorderCaptureScript,
  isReplaySafeBrowserStep,
  parseBrowserRecorderBindingPayload,
  sanitizeRawBrowserEvent,
  type BrowserRecorderBindingPayload,
  type BrowserHealRecord,
  type BrowserHealingPort,
  type BrowserRecordingRegistryEntry,
  type BrowserReplayJournalOutputValue,
  type RawBrowserEvent
} from '@desktop-agent/browser-automation';
import {
  createBrowserConsoleRecord,
  createBrowserNetworkRecord,
  createBrowserPageErrorRecord,
  exceptionRecordFromCdp,
  formatBrowserDiagnosticReport,
  isFailedBrowserNetworkRecord,
  isIgnorableBrowserLoadError,
  logErrorRecordFromCdp,
  MAX_BROWSER_CONSOLE_ENTRIES,
  MAX_BROWSER_ERROR_ENTRIES,
  pushBounded,
  recentBrowserErrorHint,
  selectBrowserConsoleRecords,
  selectBrowserErrorRecords,
  selectBrowserNetworkRecords,
  upsertBrowserNetworkRecord,
  type BrowserConsoleRecord,
  type BrowserNetworkRecord,
  type BrowserPageErrorRecord
} from './browser-diagnostics';
import {
  assertBrowserUrl,
  BROWSER_EVAL_MAX_JS_CHARS,
  BROWSER_EVAL_MAX_RESULT_CHARS,
  BROWSER_EVAL_TIMEOUT_MS,
  browserKeyDefinition,
  chooseBrowserElementCandidate,
  formatAccessibilityTree,
  isAllowedBrowserUrl,
  isRetryableBrowserStepError,
  normalizeDomain,
  resolveBrowserUploadPaths,
  safeDownloadFilename,
  type AccessibilityNode,
  type BrowserElementCandidate,
  type BrowserElementFingerprint
} from './browser-security';
import { stringifyBrowserRecording } from './browser-recording-store';
import {
  expressionInBrowserFrame,
  mergeBrowserFramePaths,
  resolveBrowserFrameRoute,
  type BrowserFrameRoute,
  type BrowserFrameSession
} from './browser-frame-routing';
import {
  applyRecordingParams,
  browserSecretEnvName,
  listedRecordingParams,
  secretEnvValues,
  type RecordingParamValue
} from './browser-recording-params';
import {
  ChromeCdpClient,
  closeChromeTarget,
  listChromeTargets,
  openChromeTarget
} from './browser-backends/chrome-cdp-client';
import { ensureChromeDebugging } from './browser-backends/chrome-launcher';

export type BrowserSecretPrompt = (input: { name: string; description?: string }) => Promise<string | undefined>;

type DownloadRecord = {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
};

type BrowserState = {
  mode: BrowserSettings['mode'];
  chromeDebugPort: number;
  partition: string;
  pages: Map<number, BrowserPageState>;
  activePageId: number;
  nextPageId: number;
  grantedDomains: Set<string>;
  downloads: Map<string, DownloadRecord>;
  lastBlockedPopup: string | undefined;
  requestedFilename: string | undefined;
  downloadPermitUntil: number;
  nextElementRef: number;
  draftRecording: {
    name: string;
    createdAt: string;
    mode: 'agent_trace' | 'user_demo';
    steps: BrowserRecordingStep[];
    rawEvents: RawBrowserEvent[];
    nextRawEventId: number;
    rawEventLimitReached: boolean;
    lastInteractionByPage: Map<number, { timestamp: number; target?: RawBrowserEvent['target'] }>;
  } | undefined;
  networkObserved: boolean;
};

type BrowserPageState = {
  kind: 'electron' | 'chrome';
  id: number;
  view?: WebContentsView;
  chrome?: {
    client?: ChromeCdpClient;
    targetId: string;
    port: number;
    owned: boolean;
    webSocketDebuggerUrl?: string;
    frameSessions: Map<string, BrowserFrameSession>;
  };
  url: string;
  title: string;
  destroyed: boolean;
  blockedNavigation: string | undefined;
  elementRefs: Map<string, BrowserElementFingerprint>;
  console: BrowserConsoleRecord[];
  network: BrowserNetworkRecord[];
  errors: BrowserPageErrorRecord[];
  pendingNetworkRequests: Set<string>;
  recorderScriptId?: string;
};

type BrowserElementTarget = {
  selector?: string | undefined;
  ref?: string | undefined;
  frame?: BrowserFramePath | undefined;
  fingerprint?: BrowserElementFingerprint;
};
type ResolvedElementTarget = { selector: string; label: string; relocated: boolean; frame?: BrowserFramePath };
type BrowserDomNode = Omit<BrowserElementFingerprint, 'origin'> & { value?: string; frameUrl?: string };
type CdpFrameTree = { frame: { id?: string }; childFrames?: CdpFrameTree[] };

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_RECORDING_STEPS = 100;
const APPROVAL_REQUIRED_ACTIONS = new Set<BrowserAction['action']>([
  'close_page', 'record_start', 'record_delete', 'replay', 'click', 'hover', 'eval', 'type', 'press', 'select', 'upload', 'download'
]);
const RECORDABLE_ACTIONS = new Set<BrowserAction['action']>(['open', 'wait', 'scroll', 'click', 'hover', 'type', 'press', 'select', 'back', 'reload']);

function requiresBrowserApproval(action: BrowserAction): boolean {
  if (APPROVAL_REQUIRED_ACTIONS.has(action.action)) return true;
  return action.action === 'cookies' && action.includeValues;
}

function needsBrowserPage(action: BrowserAction): boolean {
  return !['pages', 'new_page', 'record_start', 'record_stop', 'record_cancel', 'recordings', 'record_get', 'record_delete'].includes(action.action);
}

function ok(content: string, contentBlocks?: ToolResult['contentBlocks']): ToolResult {
  return { callId: 'browser', ok: true, content, ...(contentBlocks ? { contentBlocks } : {}) };
}

function resultValue<T>(response: unknown): T {
  return (response as { result?: { value?: T } }).result?.value as T;
}

function collectCdpFrameIds(tree: CdpFrameTree): string[] {
  const ids = tree.frame.id ? [tree.frame.id] : [];
  for (const child of tree.childFrames ?? []) ids.push(...collectCdpFrameIds(child));
  return ids;
}

function frameUrlsMatch(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left, right);
    const rightUrl = new URL(right);
    leftUrl.hash = '';
    rightUrl.hash = '';
    return leftUrl.href === rightUrl.href;
  } catch { return left === right; }
}

function assertReplayActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function replayDelay(ms: number, signal?: AbortSignal): Promise<void> {
  assertReplayActive(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    function finish() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export class BrowserRuntime {
  private readonly states = new Map<string, BrowserState>();
  private readonly recordingRegistry: BrowserRecordingRegistry;
  private readonly replayJournal: BrowserReplayJournalStore;
  private readonly secrets = new Map<string, Map<string, string>>();
  private dockSessionId: string | undefined;
  private dockBounds: { x: number; y: number; width: number; height: number } | undefined;
  private dockOverlayOpen = false;
  private attachedView: WebContentsView | undefined;

  constructor(
    private readonly dataDirectory: string,
    private readonly promptSecret?: BrowserSecretPrompt,
    private readonly host?: {
      window: () => BrowserWindow | null;
      onDock: (state: BrowserDockState | null) => void;
    },
    private readonly healingPortForSession?: (sessionId: string) => BrowserHealingPort
  ) {
    this.recordingRegistry = new BrowserRecordingRegistry({
      userDirectory: path.join(os.homedir(), '.jojo', 'browser-recordings'),
      legacyUserDirectory: path.join(dataDirectory, 'browser-recordings'),
      trustStore: new FileBrowserRecordingTrustStore(path.join(os.homedir(), '.jojo', 'browser-recording-trust.json'))
    });
    this.replayJournal = new BrowserReplayJournalStore(path.join(dataDirectory, 'browser-replay-journal'));
  }

  async execute(
    sessionId: string,
    rawAction: BrowserAction,
    approved: boolean,
    settings: BrowserSettings,
    workingDirectory: string,
    onProgress?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    assertReplayActive(signal);
    const action = BrowserActionSchema.parse(rawAction);
    if (requiresBrowserApproval(action) && !approved) {
      throw new Error(`Browser action requires explicit approval: ${action.action}`);
    }
    const state = await this.getState(
      sessionId,
      settings,
      needsBrowserPage(action) || (action.action === 'record_start' && action.mode === 'user_demo')
    );
    if (state.mode === 'chrome' && action.action === 'select_page' && !approved) {
      throw new Error('Browser action requires explicit approval: select_page');
    }
    for (const domain of settings.allowedDomains) state.grantedDomains.add(normalizeDomain(domain));
    const allowedDomains = new Set([...settings.allowedDomains, ...state.grantedDomains].map(normalizeDomain));
    try {
      const result = await this.executeAction(sessionId, state, action, approved, allowedDomains, workingDirectory, true, onProgress, signal);
      assertReplayActive(signal);
      return result;
    } finally {
      this.presentSession(sessionId);
    }
  }

  async recordingRegistrySnapshot(workingDirectory?: string): Promise<BrowserRecordingRegistrySnapshot> {
    const entries = await this.recordingRegistry.list(workingDirectory);
    return {
      userDirectory: this.recordingRegistry.userDirectory,
      ...(workingDirectory ? { projectDirectory: this.recordingRegistry.projectDirectoryFor(workingDirectory) } : {}),
      recordings: entries.map((entry) => ({
        id: entry.recording.id,
        name: entry.recording.name,
        ...(entry.recording.description ? { description: entry.recording.description } : {}),
        source: entry.source,
        trust: entry.trust,
        overriddenSources: entry.overriddenSources,
        domains: entry.effectSummary.domains,
        effects: entry.effectSummary.effects,
        highRisk: entry.effectSummary.highRisk,
        stepCount: entry.recording.steps.length,
        revision: entry.recording.revision,
        contentHash: entry.recording.contentHash,
        updatedAt: entry.recording.updatedAt
      }))
    };
  }

  async trustProjectRecording(recordingId: string, workingDirectory: string): Promise<BrowserRecordingRegistrySnapshot> {
    await this.recordingRegistry.trustProject(recordingId, workingDirectory);
    return this.recordingRegistrySnapshot(workingDirectory);
  }

  async revokeProjectRecordingTrust(recordingId: string, workingDirectory: string): Promise<BrowserRecordingRegistrySnapshot> {
    await this.recordingRegistry.revokeProjectTrust(recordingId, workingDirectory);
    return this.recordingRegistrySnapshot(workingDirectory);
  }

  async deleteManagedRecording(recordingId: string, workingDirectory: string): Promise<BrowserRecordingRegistrySnapshot> {
    await this.recordingRegistry.delete(recordingId, workingDirectory);
    return this.recordingRegistrySnapshot(workingDirectory);
  }

  private async executeAction(
    sessionId: string,
    state: BrowserState,
    action: BrowserAction,
    approved: boolean,
    allowedDomains: Set<string>,
    workingDirectory: string,
    record: boolean,
    onProgress?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    assertReplayActive(signal);
    let result: ToolResult;
    if (action.action === 'open') result = await this.open(state, action.url, approved, allowedDomains);
    else if (action.action === 'new_page') result = await this.newPage(sessionId, state, action.url, approved, allowedDomains);
    else if (action.action === 'pages') result = await this.pages(state);
    else if (action.action === 'select_page') result = await this.selectPage(state, action.pageId);
    else if (action.action === 'close_page') result = this.closePage(sessionId, state, action.pageId);
    else if (action.action === 'record_start') result = await this.startRecording(state, action.name, action.mode);
    else if (action.action === 'record_stop') result = await this.stopRecording(state, workingDirectory);
    else if (action.action === 'record_cancel') result = await this.cancelRecording(state);
    else if (action.action === 'recordings') result = await this.listRecordings(state, workingDirectory);
    else if (action.action === 'record_get') result = await this.getRecording(action.recordingId, workingDirectory);
    else if (action.action === 'record_delete') result = await this.deleteRecording(action.recordingId, workingDirectory);
    else if (action.action === 'replay') {
      return this.replay(
        sessionId, state, action.recordingId, action.params, action.maxRetries, action.retryDelayMs,
        action.runId, action.resumeRunId, action.confirmUnsafeResume, allowedDomains, workingDirectory, onProgress, signal
      );
    } else if (action.action === 'read') result = await this.read(state, action.maxNodes, action.frame);
    else if (action.action === 'eval') result = await this.evaluate(state, action.js);
    else if (action.action === 'wait') result = await this.wait(state, action, action.state, action.timeoutMs);
    else if (action.action === 'scroll') result = await this.scroll(state, action, action.deltaX, action.deltaY);
    else if (action.action === 'click') result = await this.click(state, action);
    else if (action.action === 'hover') result = await this.hover(state, action);
    else if (action.action === 'type') result = await this.type(state, action, action.text, action.submit);
    else if (action.action === 'press') result = await this.press(state, action, action.key);
    else if (action.action === 'select') result = await this.select(state, action, action.values);
    else if (action.action === 'upload') result = await this.upload(state, action, action.paths, workingDirectory);
    else if (action.action === 'back') result = await this.back(state);
    else if (action.action === 'reload') result = await this.reload(state);
    else if (action.action === 'screenshot') result = await this.screenshot(state, action.fullPage);
    else if (action.action === 'download') result = await this.download(state, action.url, action.filename, approved, allowedDomains);
    else if (action.action === 'downloads') result = ok(JSON.stringify([...state.downloads.values()], null, 2));
    else if (action.action === 'console') result = this.listConsole(state, action.level, action.limit, action.clear);
    else if (action.action === 'network') {
      result = this.listNetwork(state, action.failedOnly, action.urlContains, action.resourceType, action.limit, action.clear);
    } else if (action.action === 'errors') result = this.listErrors(state, action.kind, action.limit, action.clear);
    else if (action.action === 'cookies') result = await this.cookies(state, action.includeValues);
    else {
      const exhaustive: never = action;
      throw new Error(`Unsupported browser action: ${(exhaustive as BrowserAction).action}`);
    }
    if (!record || !RECORDABLE_ACTIONS.has(action.action)) return result;
    const recordingNotice = this.recordSuccessfulAction(state, action);
    return recordingNotice ? { ...result, content: `${result.content}\n${recordingNotice}` } : result;
  }

  close(): void {
    this.detachView(this.host?.window() ?? null);
    this.dockSessionId = undefined;
    this.dockBounds = undefined;
    this.dockOverlayOpen = false;
    this.host?.onDock(null);
    for (const [sessionId, state] of this.states) this.closeSession(sessionId, state);
    this.states.clear();
  }

  setDockLayout(input: { sessionId: string; overlayOpen: boolean; bounds: { x: number; y: number; width: number; height: number } | null }): void {
    this.dockSessionId = input.sessionId;
    this.dockOverlayOpen = input.overlayOpen;
    this.dockBounds = input.bounds ?? undefined;
    this.syncDockedViews();
  }

  async handleDockAction(input: { sessionId: string; type: 'back' | 'forward' | 'reload' | 'select' | 'close-tab' | 'close'; pageId?: number | undefined }): Promise<void> {
    const state = this.states.get(input.sessionId);
    if (!state || state.mode !== 'sandbox') return;
    if (input.type === 'close') {
      for (const page of [...state.pages.values()]) {
        this.removePage(input.sessionId, state, page.id);
        this.destroyPage(page);
      }
      this.syncDockedViews();
      return;
    }
    if (input.type === 'select') {
      if (input.pageId) await this.selectPage(state, input.pageId);
      this.syncDockedViews();
      return;
    }
    if (input.type === 'close-tab') {
      const pageId = input.pageId ?? state.activePageId;
      if (!state.pages.has(pageId)) return;
      this.closePage(input.sessionId, state, pageId);
      this.syncDockedViews();
      return;
    }
    let page: BrowserPageState;
    try { page = this.activePage(state); }
    catch { return; }
    const contents = this.electronContents(page);
    if (!contents) return;
    if (input.type === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (input.type === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (input.type === 'reload') contents.reload();
    this.syncDockedViews();
  }

  private closeSession(_sessionId: string, state: BrowserState): void {
    for (const page of state.pages.values()) this.destroyPage(page);
    state.pages.clear();
  }

  private async getState(sessionId: string, settings: BrowserSettings, ensurePage: boolean): Promise<BrowserState> {
    const existing = this.states.get(sessionId);
    if (existing && existing.mode !== settings.mode) {
      this.closeSession(sessionId, existing);
      this.states.delete(sessionId);
    } else if (existing) {
      existing.chromeDebugPort = settings.chromeDebugPort;
      if (ensurePage && existing.pages.size === 0) {
        if (existing.mode === 'chrome') await this.ensureChromePage(sessionId, existing, settings);
        else this.ensureElectronPage(sessionId, existing);
      }
      return existing;
    }
    const partitionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
    const partition = `browser-${partitionHash}`;
    const state: BrowserState = {
      mode: settings.mode,
      chromeDebugPort: settings.chromeDebugPort,
      partition,
      pages: new Map(),
      activePageId: 0,
      nextPageId: 1,
      grantedDomains: new Set(),
      downloads: new Map(),
      lastBlockedPopup: undefined,
      requestedFilename: undefined,
      downloadPermitUntil: 0,
      nextElementRef: 1,
      draftRecording: undefined,
      networkObserved: false
    };
    this.states.set(sessionId, state);
    if (!ensurePage) return state;
    if (settings.mode === 'chrome') {
      await this.ensureChromePage(sessionId, state, settings);
      return state;
    }
    this.ensureElectronPage(sessionId, state);
    return state;
  }

  private ensureElectronPage(sessionId: string, state: BrowserState): BrowserPageState {
    const view = this.createPageView(state.partition);
    this.observeSessionNetwork(sessionId, state, view.webContents.session);
    return this.registerElectronPage(sessionId, state, view);
  }

  private createPageView(partition: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        safeDialogs: true
      }
    });
    view.setBackgroundColor('#ffffff');
    return view;
  }

  private registerPage(sessionId: string, state: BrowserState, view: WebContentsView): BrowserPageState {
    return this.registerElectronPage(sessionId, state, view);
  }

  private registerElectronPage(sessionId: string, state: BrowserState, view: WebContentsView): BrowserPageState {
    const webContents = view.webContents;
    const pageId = webContents.id;
    const page: BrowserPageState = {
      kind: 'electron',
      id: pageId,
      view,
      url: webContents.getURL() || 'about:blank',
      title: webContents.getTitle() || '',
      destroyed: false,
      blockedNavigation: undefined,
      elementRefs: new Map(),
      console: [],
      network: [],
      errors: [],
      pendingNetworkRequests: new Set()
    };
    state.pages.set(pageId, page);
    state.activePageId = pageId;
    this.observeSessionNetwork(sessionId, state, webContents.session);
    webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserUrl(url, state.grantedDomains)) {
        state.lastBlockedPopup = url;
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: () => {
          const child = this.createPageView(state.partition);
          this.registerPage(sessionId, state, child);
          this.presentSession(sessionId);
          return child.webContents;
        }
      };
    });
    const blockUntrustedNavigation = (event: { preventDefault(): void }, target: string) => {
      if (target === 'about:blank') return;
      if (!isAllowedBrowserUrl(target, state.grantedDomains)) {
        page.blockedNavigation = target;
        event.preventDefault();
      }
    };
    webContents.on('will-navigate', blockUntrustedNavigation);
    webContents.on('will-redirect', blockUntrustedNavigation);
    webContents.on('will-attach-webview', (event) => event.preventDefault());
    webContents.on('destroyed', () => {
      if (this.attachedView === view) this.attachedView = undefined;
      this.removePage(sessionId, state, pageId);
      if (this.dockSessionId === sessionId) this.syncDockedViews();
    });
    webContents.on('render-process-gone', () => {
      if (!webContents.isDestroyed()) webContents.close();
    });
    webContents.debugger.attach('1.3');
    this.observePageDiagnostics(sessionId, page);
    this.enablePageDiagnostics(page);
    return page;
  }

  private observeSessionNetwork(sessionId: string, state: BrowserState, session: Session): void {
    if (state.networkObserved) return;
    state.networkObserved = true;
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
    session.webRequest.onSendHeaders(filter, (details) => {
      const page = this.pageByWebContentsId(state, details.webContentsId);
      if (!page) return;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(details.id),
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        pending: true
      }));
    });
    session.webRequest.onCompleted(filter, (details) => {
      const page = this.pageByWebContentsId(state, details.webContentsId);
      if (!page) return;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(details.id),
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        status: details.statusCode,
        fromCache: details.fromCache,
        pending: false,
        ...(details.statusCode >= 400 || (details.error && details.error !== 'net::OK')
          ? { error: details.error && details.error !== 'net::OK' ? details.error : `HTTP ${details.statusCode}` }
          : {})
      }));
    });
    session.webRequest.onErrorOccurred(filter, (details) => {
      const page = this.pageByWebContentsId(state, details.webContentsId);
      if (!page) return;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(details.id),
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        fromCache: details.fromCache,
        error: details.error || 'net::ERR_FAILED',
        pending: false
      }));
    });
    session.on('will-download', (_event, item) => {
      void this.trackDownload(sessionId, state, item);
    });
  }

  private observePageDiagnostics(sessionId: string, page: BrowserPageState): void {
    const webContents = this.electronContents(page);
    if (!webContents) return;
    webContents.on('console-message', (details) => {
      pushBounded(page.console, createBrowserConsoleRecord({
        level: details.level,
        text: details.message,
        url: details.sourceId,
        line: details.lineNumber
      }), MAX_BROWSER_CONSOLE_ENTRIES);
    });
    webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || isIgnorableBrowserLoadError(errorCode)) return;
      pushBounded(page.errors, createBrowserPageErrorRecord({
        kind: 'failed_load',
        text: `${errorDescription} (${errorCode})`,
        url: validatedURL
      }), MAX_BROWSER_ERROR_ENTRIES);
    });
    const refresh = () => {
      if (webContents.isDestroyed()) return;
      page.url = webContents.getURL();
      page.title = webContents.getTitle();
      this.enablePageDiagnostics(page);
      if (this.dockSessionId === sessionId) this.syncDockedViews();
    };
    webContents.on('did-finish-load', refresh);
    webContents.on('page-title-updated', refresh);
    webContents.on('did-navigate', refresh);
    webContents.on('did-navigate-in-page', refresh);
    webContents.debugger.on('message', (_event, method, params) => {
      if (this.isPageDestroyed(page)) return;
      if (method === 'Runtime.exceptionThrown') {
        const record = exceptionRecordFromCdp(params);
        if (record) pushBounded(page.errors, record, MAX_BROWSER_ERROR_ENTRIES);
        return;
      }
      if (method === 'Log.entryAdded') {
        const record = logErrorRecordFromCdp(params);
        if (record) pushBounded(page.errors, record, MAX_BROWSER_ERROR_ENTRIES);
      }
    });
  }

  private enablePageDiagnostics(page: BrowserPageState): void {
    if (this.isPageDestroyed(page)) return;
    if (page.kind === 'chrome' && page.chrome?.client) {
      void page.chrome.client.send('Runtime.enable').catch(() => undefined);
      void page.chrome.client.send('Log.enable').catch(() => undefined);
      void page.chrome.client.send('Network.enable').catch(() => undefined);
      return;
    }
    const dbg = this.electronContents(page)?.debugger;
    if (!dbg?.isAttached()) return;
    void dbg.sendCommand('Runtime.enable').catch(() => undefined);
    void dbg.sendCommand('Log.enable').catch(() => undefined);
  }

  private pageByWebContentsId(state: BrowserState, webContentsId: number | undefined): BrowserPageState | undefined {
    if (!webContentsId) return undefined;
    const page = state.pages.get(webContentsId);
    return page && !this.isPageDestroyed(page) ? page : undefined;
  }

  private diagnosticPage(page: BrowserPageState) {
    return {
      pageId: page.id,
      url: this.pageUrl(page),
      title: this.pageTitle(page)
    };
  }

  private diagnosticHint(page: BrowserPageState): string {
    return recentBrowserErrorHint(page.errors);
  }

  private electronContents(page: BrowserPageState): WebContents | undefined {
    if (page.kind !== 'electron' || !page.view || page.view.webContents.isDestroyed()) return undefined;
    return page.view.webContents;
  }

  private isPageDestroyed(page: BrowserPageState): boolean {
    if (page.destroyed) return true;
    if (page.kind === 'electron') return !this.electronContents(page);
    return false;
  }

  private pageUrl(page: BrowserPageState): string {
    return this.electronContents(page)?.getURL() || page.url;
  }

  private pageTitle(page: BrowserPageState): string {
    return this.electronContents(page)?.getTitle() || page.title;
  }

  private showPage(_page: BrowserPageState): void {
    this.syncDockedViews();
  }

  private hidePage(_page: BrowserPageState): void {
    // Sandbox pages live in the right dock; blank navigations no longer hide an OS window.
  }

  private destroyPage(page: BrowserPageState): void {
    page.destroyed = true;
    if (page.kind === 'electron' && page.view) {
      const hostWindow = this.host?.window() ?? null;
      if (this.attachedView === page.view) this.detachView(hostWindow);
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
      return;
    }
    if (page.chrome) {
      page.chrome.client?.close();
      if (page.chrome.owned) void closeChromeTarget(page.chrome.port, page.chrome.targetId).catch(() => undefined);
    }
  }

  private presentSession(sessionId: string): void {
    if (!this.dockSessionId) this.dockSessionId = sessionId;
    this.syncDockedViews();
  }

  private detachView(hostWindow: BrowserWindow | null): void {
    if (!this.attachedView) return;
    if (hostWindow && !hostWindow.isDestroyed()) {
      try { hostWindow.contentView.removeChildView(this.attachedView); }
      catch { /* view was not attached */ }
    }
    this.attachedView = undefined;
  }

  private attachView(hostWindow: BrowserWindow, view: WebContentsView): void {
    const bounds = this.dockBounds;
    if (!bounds) return;
    if (this.attachedView && this.attachedView !== view) this.detachView(hostWindow);
    if (this.attachedView !== view) {
      hostWindow.contentView.addChildView(view);
      this.attachedView = view;
    }
    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height))
    });
  }

  private dockState(sessionId: string, state: BrowserState, active: BrowserPageState): BrowserDockState {
    const contents = this.electronContents(active);
    return {
      sessionId,
      pages: [...state.pages.values()].flatMap((page) => (
        this.isPageDestroyed(page) || page.kind !== 'electron' ? [] : [{
          pageId: page.id,
          title: this.pageTitle(page) || '新标签页',
          url: this.pageUrl(page),
          active: page.id === state.activePageId
        }]
      )),
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false
    };
  }

  private syncDockedViews(): void {
    const hostWindow = this.host?.window() ?? null;
    const sessionId = this.dockSessionId;
    const state = sessionId ? this.states.get(sessionId) : undefined;
    const alive = state ? [...state.pages.values()].filter((page) => page.kind === 'electron' && !this.isPageDestroyed(page)) : [];
    if (!sessionId || !state || state.mode !== 'sandbox' || alive.length === 0) {
      this.detachView(hostWindow);
      this.host?.onDock(null);
      return;
    }
    let active: BrowserPageState;
    try { active = this.activePage(state); }
    catch {
      this.detachView(hostWindow);
      this.host?.onDock(null);
      return;
    }
    const canAttach = Boolean(
      hostWindow
      && !hostWindow.isDestroyed()
      && !this.dockOverlayOpen
      && this.dockBounds
      && this.dockBounds.width >= 2
      && this.dockBounds.height >= 2
      && active.kind === 'electron'
      && active.view
    );
    if (!canAttach || !hostWindow || !active.view) this.detachView(hostWindow);
    else this.attachView(hostWindow, active.view);
    this.host?.onDock(this.dockState(sessionId, state, active));
  }

  private async ensureChromePage(sessionId: string, state: BrowserState, settings: BrowserSettings): Promise<void> {
    await ensureChromeDebugging({
      port: settings.chromeDebugPort,
      userDataDir: path.join(this.dataDirectory, 'chrome-profile')
    });
    const target = await openChromeTarget(settings.chromeDebugPort);
    await this.attachChromeTarget(sessionId, state, target, true);
  }

  private async attachChromeTarget(
    _sessionId: string,
    state: BrowserState,
    target: { id: string; title: string; url: string; webSocketDebuggerUrl?: string },
    owned: boolean
  ): Promise<BrowserPageState> {
    const page = this.registerChromePage(state, target, owned, true);
    await this.connectChromeClient(state, page);
    return page;
  }

  private registerChromePage(
    state: BrowserState,
    target: { id: string; title: string; url: string; webSocketDebuggerUrl?: string },
    owned: boolean,
    activate: boolean
  ): BrowserPageState {
    const pageId = state.nextPageId++;
    const page: BrowserPageState = {
      kind: 'chrome',
      id: pageId,
      chrome: {
        targetId: target.id,
        port: state.chromeDebugPort,
        owned,
        frameSessions: new Map(),
        ...(target.webSocketDebuggerUrl ? { webSocketDebuggerUrl: target.webSocketDebuggerUrl } : {})
      },
      url: target.url || 'about:blank',
      title: target.title || '',
      destroyed: false,
      blockedNavigation: undefined,
      elementRefs: new Map(),
      console: [],
      network: [],
      errors: [],
      pendingNetworkRequests: new Set()
    };
    state.pages.set(pageId, page);
    if (activate || state.activePageId === 0) state.activePageId = pageId;
    return page;
  }

  private async refreshChromePages(state: BrowserState): Promise<void> {
    if (state.mode !== 'chrome') return;
    const targets = (await listChromeTargets(state.chromeDebugPort))
      .filter((target) => target.type === 'page');
    const byTarget = new Map<string, BrowserPageState>();
    for (const page of state.pages.values()) {
      if (page.kind === 'chrome' && page.chrome) byTarget.set(page.chrome.targetId, page);
    }
    const seen = new Set<string>();
    for (const target of targets) {
      seen.add(target.id);
      const existing = byTarget.get(target.id);
      if (existing) {
        existing.url = target.url || existing.url;
        existing.title = target.title || existing.title;
        if (existing.chrome && target.webSocketDebuggerUrl) existing.chrome.webSocketDebuggerUrl = target.webSocketDebuggerUrl;
        continue;
      }
      this.registerChromePage(state, target, false, false);
    }
    for (const page of [...state.pages.values()]) {
      if (page.kind !== 'chrome' || !page.chrome || seen.has(page.chrome.targetId)) continue;
      if (page.chrome.client) page.destroyed = true;
      else this.removePage('', state, page.id);
    }
  }

  private async connectChromeClient(state: BrowserState, page: BrowserPageState): Promise<void> {
    if (page.kind !== 'chrome' || !page.chrome) throw new Error('Not a Chrome page.');
    if (page.chrome.client) return;
    let websocket = page.chrome.webSocketDebuggerUrl;
    if (!websocket) {
      const target = (await listChromeTargets(page.chrome.port)).find((item) => item.id === page.chrome!.targetId);
      websocket = target?.webSocketDebuggerUrl;
      if (websocket) page.chrome.webSocketDebuggerUrl = websocket;
    }
    if (!websocket) throw new Error(`Chrome tab ${page.chrome.targetId} is not inspectable. Start Chrome with --remote-debugging-port.`);
    const client = await ChromeCdpClient.connect(websocket);
    page.chrome.client = client;
    client.onDisconnect(() => { page.destroyed = true; });
    this.wireChromeClient(state, page, client);
    await client.send('Page.enable').catch(() => undefined);
    await client.send('Runtime.enable').catch(() => undefined);
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }]
    }).catch(() => client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }).catch(() => undefined));
    this.enablePageDiagnostics(page);
    if (state.draftRecording?.mode === 'user_demo') await this.instrumentUserDemoPage(state, page);
  }

  private wireChromeClient(state: BrowserState, page: BrowserPageState, client: ChromeCdpClient): void {
    client.on('Runtime.exceptionThrown', (params) => {
      const record = exceptionRecordFromCdp(params);
      if (record) pushBounded(page.errors, record, MAX_BROWSER_ERROR_ENTRIES);
    });
    client.on('Log.entryAdded', (params) => {
      const record = logErrorRecordFromCdp(params);
      if (record) pushBounded(page.errors, record, MAX_BROWSER_ERROR_ENTRIES);
    });
    client.on('Runtime.consoleAPICalled', (params) => {
      const args = Array.isArray(params.args) ? params.args as Array<{ value?: unknown; description?: string }> : [];
      const text = args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 4_000);
      pushBounded(page.console, createBrowserConsoleRecord({
        level: String(params.type ?? 'log'),
        text,
        url: page.url
      }), MAX_BROWSER_CONSOLE_ENTRIES);
    });
    client.on('Runtime.bindingCalled', (params, frameSessionId) => {
      if (params.name !== BROWSER_RECORDER_BINDING_NAME || typeof params.payload !== 'string') return;
      const payload = parseBrowserRecorderBindingPayload(params.payload);
      if (payload) void this.captureCdpUserDemoEvent(state, page, payload, frameSessionId);
    });
    client.on('Target.attachedToTarget', (params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const targetInfo = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
      if (!sessionId || targetInfo?.type !== 'iframe' || !targetInfo.targetId || !page.chrome) return;
      const frameSession: BrowserFrameSession = {
        sessionId,
        targetId: targetInfo.targetId,
        url: targetInfo.url ?? 'about:blank'
      };
      page.chrome.frameSessions.set(sessionId, frameSession);
      void this.initializeChromeFrameSession(state, page, frameSession);
    });
    client.on('Target.detachedFromTarget', (params) => {
      if (typeof params.sessionId === 'string') page.chrome?.frameSessions.delete(params.sessionId);
    });
    client.on('Network.requestWillBeSent', (params) => {
      const requestId = String(params.requestId ?? '');
      const resourceType = String(params.type ?? 'other');
      if (requestId && ['Document', 'Fetch', 'XHR'].includes(resourceType)) page.pendingNetworkRequests.add(requestId);
      const request = params.request as { method?: string; url?: string } | undefined;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: requestId,
        method: request?.method ?? 'GET',
        url: request?.url ?? '',
        resourceType,
        pending: true
      }));
    });
    client.on('Network.loadingFinished', (params) => {
      const requestId = String(params.requestId ?? '');
      const tracked = requestId ? page.pendingNetworkRequests.delete(requestId) : false;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: requestId,
        method: 'GET',
        url: page.url,
        pending: false
      }));
      if (tracked && page.pendingNetworkRequests.size === 0) this.captureUserDemoWait(state, page, { type: 'network_idle', idleMs: 500 });
    });
    client.on('Network.loadingFailed', (params) => {
      const requestId = String(params.requestId ?? '');
      const tracked = requestId ? page.pendingNetworkRequests.delete(requestId) : false;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: requestId,
        method: 'GET',
        url: page.url,
        error: String(params.errorText ?? 'net::ERR_FAILED'),
        pending: false
      }));
      if (tracked && page.pendingNetworkRequests.size === 0) this.captureUserDemoWait(state, page, { type: 'network_idle', idleMs: 500 });
    });
    client.on('Page.frameNavigated', (params, frameSessionId) => {
      const frame = params.frame as { url?: string; parentId?: string } | undefined;
      if (frameSessionId && frame?.url) {
        const attached = page.chrome?.frameSessions.get(frameSessionId);
        if (attached) {
          attached.url = frame.url;
          if (attached.framePath) {
            this.captureUserDemoEvent(state, page, {
              type: 'navigate', timestamp: Date.now(), url: frame.url, frame: attached.framePath
            });
          }
        }
      }
      if (!frameSessionId && frame?.url && !frame.parentId) {
        page.url = frame.url;
        this.captureUserDemoEvent(state, page, { type: 'navigate', timestamp: Date.now(), url: frame.url });
      }
    });
    client.on('Page.windowOpen', (params) => {
      this.captureUserDemoWait(state, page, { type: 'new_page' });
      void this.instrumentOpenedUserDemoPage(state, typeof params.url === 'string' ? params.url : undefined);
    });
    client.on('Browser.downloadWillBegin', (params) => {
      const id = String(params.guid ?? crypto.randomUUID());
      const filename = safeDownloadFilename(typeof params.suggestedFilename === 'string' ? params.suggestedFilename : 'download');
      const directory = path.join(this.dataDirectory, 'browser-downloads', state.partition);
      state.downloads.set(id, {
        id,
        url: typeof params.url === 'string' ? params.url : this.pageUrl(page),
        filename,
        path: path.join(directory, filename),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: 0
      });
      const interaction = state.draftRecording?.lastInteractionByPage.get(page.id);
      if (!interaction?.target) return;
      this.captureUserDemoEvent(state, page, {
        type: 'download',
        timestamp: Date.now(),
        url: typeof params.url === 'string' ? params.url : this.pageUrl(page),
        target: interaction.target,
        ...(typeof params.suggestedFilename === 'string'
          ? { download: { suggestedFilename: params.suggestedFilename } }
          : {})
      });
    });
    client.on('Browser.downloadProgress', (params) => {
      const id = String(params.guid ?? '');
      const record = state.downloads.get(id);
      if (!record) return;
      record.receivedBytes = typeof params.receivedBytes === 'number' ? params.receivedBytes : record.receivedBytes;
      record.totalBytes = typeof params.totalBytes === 'number' ? params.totalBytes : record.totalBytes;
      if (typeof params.filePath === 'string' && params.filePath) record.path = params.filePath;
      if (params.state === 'completed' || params.state === 'canceled') {
        record.state = params.state === 'completed' ? 'completed' : 'cancelled';
      }
    });
  }

  private async initializeChromeFrameSession(
    state: BrowserState,
    page: BrowserPageState,
    frameSession: BrowserFrameSession
  ): Promise<void> {
    const client = page.chrome?.client;
    if (!client || !page.chrome?.frameSessions.has(frameSession.sessionId)) return;
    await client.send('Runtime.enable', undefined, COMMAND_TIMEOUT_MS, frameSession.sessionId).catch(() => undefined);
    await client.send('Page.enable', undefined, COMMAND_TIMEOUT_MS, frameSession.sessionId).catch(() => undefined);
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }]
    }, COMMAND_TIMEOUT_MS, frameSession.sessionId).catch(() => client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }, COMMAND_TIMEOUT_MS, frameSession.sessionId).catch(() => undefined));
    if (!frameSession.framePath) {
      const framePath = await this.findChromeFrameSessionPath(page, frameSession).catch(() => undefined);
      if (framePath) frameSession.framePath = framePath;
    }
    if (state.draftRecording?.mode === 'user_demo') {
      await this.instrumentUserDemoCdpSession(page, frameSession.sessionId, frameSession).catch(() => undefined);
    }
  }

  private async captureCdpUserDemoEvent(
    state: BrowserState,
    page: BrowserPageState,
    payload: BrowserRecorderBindingPayload,
    frameSessionId: string | undefined
  ): Promise<void> {
    if (!frameSessionId) {
      this.captureUserDemoEvent(state, page, payload);
      return;
    }
    const frameSession = page.chrome?.frameSessions.get(frameSessionId);
    if (!frameSession) return;
    const outer = frameSession.framePath ?? await this.findChromeFrameSessionPath(page, frameSession);
    if (!outer) return;
    frameSession.framePath = outer;
    const eventFrame = mergeBrowserFramePaths(outer, payload.frame);
    const targetFrame = mergeBrowserFramePaths(outer, payload.target?.frame);
    this.captureUserDemoEvent(state, page, {
      ...payload,
      ...(eventFrame ? { frame: eventFrame } : {}),
      ...(payload.target ? {
        target: {
          ...payload.target,
          ...(targetFrame ? { frame: targetFrame } : {})
        }
      } : {})
    });
  }

  private async findChromeFrameSessionPath(
    page: BrowserPageState,
    target: BrowserFrameSession
  ): Promise<BrowserFramePath | undefined> {
    const client = page.chrome?.client;
    const sessions = page.chrome?.frameSessions;
    if (!client || !sessions) return undefined;
    const known = new Map<string | undefined, BrowserFramePath | undefined>([[undefined, undefined]]);
    for (const session of sessions.values()) if (session.framePath) known.set(session.sessionId, session.framePath);
    for (let round = 0; round <= sessions.size; round += 1) {
      let changed = false;
      for (const [sessionId, prefix] of known) {
        const owners = await this.listLocalFrameOwners(client, sessionId).catch(() => []);
        for (const candidate of sessions.values()) {
          if (candidate.framePath || known.has(candidate.sessionId)) continue;
          const matches = owners.filter((owner) => frameUrlsMatch(owner.src, candidate.url));
          if (matches.length !== 1) continue;
          const framePath = mergeBrowserFramePaths(prefix, { selectors: matches[0]!.selectors });
          if (!framePath) continue;
          candidate.framePath = framePath;
          known.set(candidate.sessionId, framePath);
          changed = true;
        }
      }
      if (target.framePath) return target.framePath;
      if (!changed) break;
    }
    return target.framePath;
  }

  private async listLocalFrameOwners(
    client: ChromeCdpClient,
    sessionId: string | undefined
  ): Promise<Array<{ selectors: string[]; src: string }>> {
    const expression = `(() => {
      const escape = globalThis.CSS && typeof CSS.escape === 'function'
        ? CSS.escape.bind(CSS) : (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
      const selectorFor = (el) => {
        if (el.id) return '#' + escape(el.id);
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name="' + escape(name) + '"]';
        const parts = [];
        let current = el;
        while (current && current !== current.ownerDocument.documentElement && parts.length < 6) {
          let part = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (parent) {
            const peers = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
            if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(current) + 1) + ')';
          }
          parts.unshift(part);
          current = parent;
        }
        return parts.join(' > ');
      };
      const result = [];
      const visit = (doc, prefix) => {
        for (const owner of doc.querySelectorAll('iframe,frame')) {
          const selector = selectorFor(owner);
          if (!selector) continue;
          const selectors = prefix.concat(selector);
          result.push({ selectors, src: owner.src || owner.getAttribute('src') || 'about:blank' });
          try { if (owner.contentDocument) visit(owner.contentDocument, selectors); } catch {}
        }
      };
      visit(document, []);
      return result.slice(0, 256);
    })()`;
    const response = await client.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      COMMAND_TIMEOUT_MS,
      sessionId
    );
    return resultValue<Array<{ selectors: string[]; src: string }>>(response) ?? [];
  }

  private async instrumentUserDemoPage(state: BrowserState, page: BrowserPageState): Promise<void> {
    const client = page.chrome?.client;
    const chrome = page.chrome;
    if (!client || !chrome || page.recorderScriptId) return;
    const downloadDirectory = path.join(this.dataDirectory, 'browser-downloads', state.partition);
    await mkdir(downloadDirectory, { recursive: true });
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
      eventsEnabled: true
    }).catch(() => undefined);
    const installed = await this.instrumentUserDemoCdpSession(page, undefined);
    if (installed) page.recorderScriptId = installed;
    await Promise.all([...chrome.frameSessions.values()].map(async (frameSession) => {
      await this.instrumentUserDemoCdpSession(page, frameSession.sessionId, frameSession).catch(() => undefined);
    }));
    if (state.draftRecording?.mode === 'user_demo') {
      this.captureUserDemoEvent(state, page, { type: 'navigate', timestamp: Date.now(), url: this.pageUrl(page) });
    }
  }

  private async instrumentUserDemoCdpSession(
    page: BrowserPageState,
    sessionId: string | undefined,
    frameSession?: BrowserFrameSession
  ): Promise<string | undefined> {
    const client = page.chrome?.client;
    if (!client || frameSession?.recorderScriptId) return frameSession?.recorderScriptId;
    const source = createBrowserRecorderCaptureScript();
    await client.send(
      'Runtime.addBinding',
      { name: BROWSER_RECORDER_BINDING_NAME },
      COMMAND_TIMEOUT_MS,
      sessionId
    ).catch((error) => {
      if (!/already exists/iu.test(error instanceof Error ? error.message : String(error))) throw error;
    });
    const installed = await client.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
      COMMAND_TIMEOUT_MS,
      sessionId
    ) as { identifier?: string };
    await this.instrumentExistingCdpFrames(client, source, sessionId);
    if (frameSession && installed.identifier) frameSession.recorderScriptId = installed.identifier;
    return installed.identifier;
  }

  private async instrumentExistingCdpFrames(
    client: ChromeCdpClient,
    source: string,
    sessionId: string | undefined
  ): Promise<void> {
    const tree = await client.send('Page.getFrameTree', undefined, COMMAND_TIMEOUT_MS, sessionId)
      .catch(() => undefined) as { frameTree?: CdpFrameTree } | undefined;
    const frameIds = tree?.frameTree ? collectCdpFrameIds(tree.frameTree) : [];
    if (frameIds.length === 0) {
      await client.send('Runtime.evaluate', { expression: source, returnByValue: true }, COMMAND_TIMEOUT_MS, sessionId)
        .catch(() => undefined);
      return;
    }
    await Promise.all(frameIds.map(async (frameId) => {
      const world = await client.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'jojo-browser-recorder-v2',
        grantUniveralAccess: false
      }, COMMAND_TIMEOUT_MS, sessionId).catch(() => undefined) as { executionContextId?: number } | undefined;
      if (!world?.executionContextId) return;
      await client.send('Runtime.evaluate', {
        expression: source,
        contextId: world.executionContextId,
        returnByValue: true
      }, COMMAND_TIMEOUT_MS, sessionId).catch(() => undefined);
    }));
  }

  private async instrumentOpenedUserDemoPage(state: BrowserState, expectedUrl: string | undefined): Promise<void> {
    for (let attempt = 0; attempt < 3 && state.draftRecording?.mode === 'user_demo'; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      await this.refreshChromePages(state).catch(() => undefined);
      const candidates = [...state.pages.values()].filter((page) => (
        page.kind === 'chrome'
        && !page.destroyed
        && !page.chrome?.client
        && (!expectedUrl || page.url === expectedUrl || page.url === 'about:blank')
      ));
      const candidate = candidates.at(-1);
      if (!candidate) continue;
      await this.connectChromeClient(state, candidate).catch(() => undefined);
      if (candidate.chrome?.client) return;
    }
  }

  private async stopUserDemoInstrumentation(state: BrowserState): Promise<void> {
    await Promise.all([...state.pages.values()].map(async (page) => {
      const client = page.chrome?.client;
      if (!client) return;
      const scriptId = page.recorderScriptId;
      delete page.recorderScriptId;
      const stopSession = async (sessionId: string | undefined, installedId: string | undefined) => {
        await client.send('Runtime.evaluate', {
          expression: `(() => { const state = globalThis[${JSON.stringify(BROWSER_RECORDER_GUARD_NAME)}]; if (state && typeof state === 'object') state.active = false; })()`,
          returnByValue: true
        }, COMMAND_TIMEOUT_MS, sessionId).catch(() => undefined);
        if (installedId) {
          await client.send(
            'Page.removeScriptToEvaluateOnNewDocument',
            { identifier: installedId },
            COMMAND_TIMEOUT_MS,
            sessionId
          ).catch(() => undefined);
        }
        await client.send(
          'Runtime.removeBinding',
          { name: BROWSER_RECORDER_BINDING_NAME },
          COMMAND_TIMEOUT_MS,
          sessionId
        ).catch(() => undefined);
      };
      await stopSession(undefined, scriptId);
      await Promise.all([...(page.chrome?.frameSessions.values() ?? [])].map(async (frameSession) => {
        const installedId = frameSession.recorderScriptId;
        delete frameSession.recorderScriptId;
        await stopSession(frameSession.sessionId, installedId);
      }));
      await client.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false }).catch(() => undefined);
    }));
  }

  private captureUserDemoEvent(
    state: BrowserState,
    page: BrowserPageState,
    payload: BrowserRecorderBindingPayload
  ): void {
    const draft = state.draftRecording;
    if (!draft || draft.mode !== 'user_demo') return;
    if (draft.rawEvents.length >= MAX_RAW_BROWSER_EVENTS) {
      draft.rawEventLimitReached = true;
      return;
    }
    const event = sanitizeRawBrowserEvent({
      ...payload,
      id: `raw-${draft.nextRawEventId++}`,
      pageId: String(page.id),
      url: payload.url || this.pageUrl(page)
    });
    draft.rawEvents.push(event);
    if (['click', 'change', 'key', 'select', 'upload', 'download'].includes(event.type)) {
      draft.lastInteractionByPage.set(page.id, {
        timestamp: event.timestamp,
        ...(event.target ? { target: event.target } : {})
      });
    }
  }

  private captureUserDemoWait(state: BrowserState, page: BrowserPageState, wait: NonNullable<RawBrowserEvent['wait']>): void {
    const draft = state.draftRecording;
    if (!draft || draft.mode !== 'user_demo') return;
    const interaction = draft.lastInteractionByPage.get(page.id);
    if (!interaction || Date.now() - interaction.timestamp > 10_000) return;
    this.captureUserDemoEvent(state, page, {
      type: 'wait',
      timestamp: Date.now(),
      url: this.pageUrl(page),
      wait
    });
  }

  private async chromeNavigate(page: BrowserPageState, url: string): Promise<void> {
    const client = page.chrome?.client;
    if (!client) throw new Error('Chrome debugger is not attached.');
    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error('Browser navigation timed out.'));
      }, COMMAND_TIMEOUT_MS);
      const off = client.on('Page.loadEventFired', () => {
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
    await client.send('Page.navigate', { url });
    await loaded;
    await this.refreshChromePageInfo(page);
    if (!page.url) page.url = url;
  }

  private async waitForChromeLoad(page: BrowserPageState, timeoutMs = 8_000): Promise<void> {
    if (!page.chrome?.client) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        off();
        resolve();
      }, timeoutMs);
      const off = page.chrome!.client!.on('Page.loadEventFired', () => {
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
    await this.refreshChromePageInfo(page);
  }

  private async refreshChromePageInfo(page: BrowserPageState): Promise<void> {
    if (!page.chrome?.client) return;
    const info = resultValue<{ url?: string; title?: string }>(await page.chrome.client.send('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title })',
      returnByValue: true
    })) ?? {};
    page.url = info.url || page.url;
    page.title = info.title || page.title;
  }

  private listConsole(
    state: BrowserState,
    level: BrowserConsoleRecord['level'] | undefined,
    limit: number,
    clear: boolean
  ): ToolResult {
    const page = this.activePage(state);
    const captured = level ? page.console.filter((entry) => entry.level === level).length : page.console.length;
    const entries = selectBrowserConsoleRecords(page.console, { ...(level ? { level } : {}), limit });
    if (clear) page.console.length = 0;
    return ok(formatBrowserDiagnosticReport(this.diagnosticPage(page), captured, entries));
  }

  private listNetwork(
    state: BrowserState,
    failedOnly: boolean,
    urlContains: string | undefined,
    resourceType: BrowserNetworkRecord['resourceType'] | undefined,
    limit: number,
    clear: boolean
  ): ToolResult {
    const page = this.activePage(state);
    const selected = selectBrowserNetworkRecords(page.network, {
      failedOnly,
      ...(urlContains ? { urlContains } : {}),
      ...(resourceType ? { resourceType } : {}),
      limit
    });
    const captured = selectBrowserNetworkRecords(page.network, {
      failedOnly,
      ...(urlContains ? { urlContains } : {}),
      ...(resourceType ? { resourceType } : {}),
      limit: page.network.length
    }).length;
    const extra = {
      failed: page.network.filter(isFailedBrowserNetworkRecord).length,
      pending: page.network.filter((record) => record.pending).length
    };
    if (clear) page.network.length = 0;
    return ok(formatBrowserDiagnosticReport(this.diagnosticPage(page), captured, selected, extra));
  }

  private listErrors(
    state: BrowserState,
    kind: BrowserPageErrorRecord['kind'] | undefined,
    limit: number,
    clear: boolean
  ): ToolResult {
    const page = this.activePage(state);
    const captured = kind ? page.errors.filter((entry) => entry.kind === kind).length : page.errors.length;
    const entries = selectBrowserErrorRecords(page.errors, { ...(kind ? { kind } : {}), limit });
    const extra = { failedRequests: page.network.filter(isFailedBrowserNetworkRecord).length };
    if (clear) page.errors.length = 0;
    return ok(formatBrowserDiagnosticReport(this.diagnosticPage(page), captured, entries, extra));
  }

  private removePage(_sessionId: string, state: BrowserState, pageId: number): void {
    state.pages.delete(pageId);
    if (state.activePageId === pageId) state.activePageId = state.pages.keys().next().value ?? 0;
  }

  private activePage(state: BrowserState): BrowserPageState {
    const selected = state.pages.get(state.activePageId);
    if (selected && !this.isPageDestroyed(selected)) return selected;
    for (const [pageId, page] of state.pages) {
      if (this.isPageDestroyed(page)) continue;
      state.activePageId = pageId;
      return page;
    }
    throw new Error('The controlled browser has no open page.');
  }

  private async open(state: BrowserState, value: string, approved: boolean, allowedDomains: Set<string>): Promise<ToolResult> {
    const url = assertBrowserUrl(value);
    if (!isAllowedBrowserUrl(url.toString(), allowedDomains) && !approved) {
      throw new Error(`Domain is not allowed: ${url.hostname}`);
    }
    state.grantedDomains.add(normalizeDomain(url.hostname));
    const page = this.activePage(state);
    page.blockedNavigation = undefined;
    const currentUrl = this.pageUrl(page);
    const wasBlank = !currentUrl || currentUrl === 'about:blank';
    if (wasBlank) this.hidePage(page);
    try {
      if (page.kind === 'chrome') await this.chromeNavigate(page, url.toString());
      else {
        const contents = this.electronContents(page);
        if (!contents) throw new Error('The controlled browser has no open page.');
        await this.withTimeout(
          contents.loadURL(url.toString()),
          () => { if (!contents.isDestroyed()) contents.stop(); }
        );
      }
    } catch (error) {
      if (wasBlank) this.hidePage(page);
      const blockedNavigation = page.blockedNavigation;
      page.blockedNavigation = undefined;
      if (blockedNavigation) {
        throw new Error(`Navigation to ${blockedNavigation} was blocked because its domain is not allowed.`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open ${url.toString()}: ${detail}${this.diagnosticHint(page)}`);
    }
    page.blockedNavigation = undefined;
    this.showPage(page);
    return ok(`Opened page ${page.id}: ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}`);
  }

  private async newPage(
    sessionId: string,
    state: BrowserState,
    value: string,
    approved: boolean,
    allowedDomains: Set<string>
  ): Promise<ToolResult> {
    const url = assertBrowserUrl(value);
    if (!isAllowedBrowserUrl(url.toString(), allowedDomains) && !approved) throw new Error(`Domain is not allowed: ${url.hostname}`);
    state.grantedDomains.add(normalizeDomain(url.hostname));
    const previousPageId = state.activePageId;
    let page: BrowserPageState;
    if (state.mode === 'chrome') {
      const target = await openChromeTarget(state.chromeDebugPort, 'about:blank');
      page = await this.attachChromeTarget(sessionId, state, target, true);
    } else {
      page = this.registerPage(sessionId, state, this.createPageView(state.partition));
    }
    try {
      return await this.open(state, url.toString(), approved, allowedDomains);
    } catch (error) {
      this.removePage(sessionId, state, page.id);
      this.destroyPage(page);
      if (state.pages.has(previousPageId)) state.activePageId = previousPageId;
      throw error;
    }
  }

  private async pages(state: BrowserState): Promise<ToolResult> {
    if (state.mode === 'chrome') await this.refreshChromePages(state);
    const pages = [...state.pages.entries()].flatMap(([pageId, page]) => this.isPageDestroyed(page) ? [] : [{
      pageId,
      active: pageId === state.activePageId,
      mode: page.kind,
      attached: page.kind === 'electron' || Boolean(page.chrome?.client),
      owned: page.kind === 'electron' || page.chrome?.owned === true,
      url: this.pageUrl(page),
      title: this.pageTitle(page)
    }]);
    return ok(JSON.stringify(pages, null, 2));
  }

  private async selectPage(state: BrowserState, pageId: number): Promise<ToolResult> {
    const page = state.pages.get(pageId);
    if (!page || this.isPageDestroyed(page)) throw new Error(`Browser page does not exist: ${pageId}`);
    if (page.kind === 'chrome' && page.chrome && !page.chrome.client) await this.connectChromeClient(state, page);
    state.activePageId = pageId;
    this.showPage(page);
    return ok(`Selected page ${pageId}: ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}`);
  }

  private closePage(sessionId: string, state: BrowserState, pageId: number): ToolResult {
    const page = state.pages.get(pageId);
    if (!page || this.isPageDestroyed(page)) throw new Error(`Browser page does not exist: ${pageId}`);
    const description = `${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}`;
    this.removePage(sessionId, state, pageId);
    this.destroyPage(page);
    if (state.pages.size > 0) this.showPage(this.activePage(state));
    return ok(`Closed page ${pageId}: ${description}`);
  }

  private async startRecording(
    state: BrowserState,
    requestedName: string | undefined,
    mode: 'agent_trace' | 'user_demo'
  ): Promise<ToolResult> {
    if (state.draftRecording) throw new Error('A browser recording is already active.');
    if (mode === 'user_demo' && state.mode !== 'chrome') {
      throw new Error('User Demo recording requires Chrome mode. Select Chrome in Browser Settings and retry.');
    }
    state.draftRecording = {
      name: requestedName ?? 'Workflow',
      createdAt: new Date().toISOString(),
      mode,
      steps: [],
      rawEvents: [],
      nextRawEventId: 1,
      rawEventLimitReached: false,
      lastInteractionByPage: new Map()
    };
    if (mode === 'user_demo') {
      const active = this.activePage(state);
      const connected = [...state.pages.values()].filter((page) => page.chrome?.client);
      if (!connected.includes(active)) connected.push(active);
      await Promise.all(connected.map((page) => this.instrumentUserDemoPage(state, page)));
      return ok(`Started User Demo recording ${state.draftRecording.name}. Use Chrome normally, then call browser_record_stop. Password-like field values are excluded before capture.`);
    }
    return ok(`Started Agent Trace recording ${state.draftRecording.name}. Successful Agent browser actions will be saved as YAML when recording stops, including typed text.`);
  }

  private async stopRecording(state: BrowserState, workingDirectory: string): Promise<ToolResult> {
    const draft = state.draftRecording;
    if (!draft) throw new Error('There is no active browser recording.');
    state.draftRecording = undefined;
    if (draft.mode === 'user_demo') await this.stopUserDemoInstrumentation(state);
    const id = await this.recordingRegistry.allocateUserId(draft.name, workingDirectory);
    const source = draft.mode === 'user_demo'
      ? compileUserDemoRecording({
          id,
          name: draft.name,
          createdAt: draft.createdAt,
          events: draft.rawEvents,
          domains: [...state.grantedDomains]
        })
      : {
          version: 2 as const,
          id,
          name: draft.name,
          scope: 'user' as const,
          domains: [...state.grantedDomains].sort(),
          createdAt: draft.createdAt,
          updatedAt: draft.createdAt,
          params: listedRecordingParams(draft.steps),
          outputs: [],
          steps: draft.steps,
          revision: 1,
          contentHash: ''
        };
    const document = await this.recordingRegistry.save(source, workingDirectory);
    const limitNotice = draft.rawEventLimitReached ? ` Raw trace was capped at ${MAX_RAW_BROWSER_EVENTS} events.` : '';
    return ok(`Saved ${draft.mode} browser recording ${document.id}: ${document.name} (${document.steps.length} steps) to ~/.jojo/browser-recordings/${document.id}.yaml.${limitNotice}`);
  }

  private async cancelRecording(state: BrowserState): Promise<ToolResult> {
    const draft = state.draftRecording;
    if (!draft) throw new Error('There is no active browser recording.');
    state.draftRecording = undefined;
    if (draft.mode === 'user_demo') await this.stopUserDemoInstrumentation(state);
    const discarded = draft.mode === 'user_demo' ? `${draft.rawEvents.length} raw events` : `${draft.steps.length} steps`;
    return ok(`Cancelled ${draft.mode} browser recording ${draft.name} without saving (${discarded} discarded).`);
  }

  private async listRecordings(state: BrowserState, workingDirectory: string): Promise<ToolResult> {
    const stored = await this.recordingRegistry.list(workingDirectory);
    const items: Array<Record<string, unknown>> = stored.map((entry) => ({
      source: entry.source,
      trust: entry.trust,
      overriddenSources: entry.overriddenSources,
      effectSummary: entry.effectSummary,
      id: entry.recording.id,
      name: entry.recording.name,
      createdAt: entry.recording.createdAt,
      updatedAt: entry.recording.updatedAt,
      revision: entry.recording.revision,
      contentHash: entry.recording.contentHash,
      persisted: true,
      active: false,
      stepCount: entry.recording.steps.length,
      params: entry.recording.params.map((param) => param.secret ? { name: param.name, secret: true } : { name: param.name, type: param.type }),
      steps: entry.trust === 'untrusted' && entry.effectSummary.highRisk
        ? undefined
        : entry.recording.steps.map((step, index) => `${index + 1}. ${this.describeRecordedStep(step)}`)
    }));
    if (state.draftRecording) {
      const draft = state.draftRecording;
      const preview = draft.mode === 'user_demo'
        ? compileUserDemoRecording({
            id: 'draft-preview',
            name: draft.name,
            createdAt: draft.createdAt,
            events: draft.rawEvents,
            domains: [...state.grantedDomains]
          })
        : undefined;
      const previewSteps = preview?.steps ?? draft.steps;
      const previewParams = preview?.params ?? listedRecordingParams(draft.steps);
      items.unshift({
        id: 'draft',
        name: draft.name,
        createdAt: draft.createdAt,
        updatedAt: draft.createdAt,
        persisted: false,
        active: true,
        stepCount: previewSteps.length,
        params: previewParams.map((param) => (
          param.secret ? { name: param.name, secret: true } : { name: param.name, type: param.type }
        )),
        steps: previewSteps.map((step, index) => `${index + 1}. ${this.describeRecordedStep(step)}`)
      });
    }
    return ok(JSON.stringify(items, null, 2));
  }

  private async getRecording(recordingId: string, workingDirectory: string): Promise<ToolResult> {
    const entry = await this.recordingRegistry.get(recordingId, workingDirectory);
    const document = entry.recording;
    if (entry.source === 'project' && entry.trust === 'untrusted' && entry.effectSummary.highRisk) {
      return ok(JSON.stringify({
        id: document.id,
        name: document.name,
        description: document.description,
        source: entry.source,
        trust: entry.trust,
        revision: document.revision,
        contentHash: document.contentHash,
        effectSummary: entry.effectSummary,
        message: 'High-risk project recording steps are hidden until this exact content hash is trusted in Desktop Settings.'
      }, null, 2));
    }
    return ok(stringifyBrowserRecording({
      ...document,
      steps: document.steps.map((step) => step.action === 'type' ? { ...step, value: `[${step.value?.length ?? 0} characters]` } : step)
    }));
  }

  private async deleteRecording(recordingId: string, workingDirectory: string): Promise<ToolResult> {
    const source = await this.recordingRegistry.delete(recordingId, workingDirectory);
    return ok(`Deleted ${source} browser recording ${recordingId}.`);
  }

  private recordSuccessfulAction(state: BrowserState, action: BrowserAction): string | undefined {
    const draft = state.draftRecording;
    if (!draft) return undefined;
    if (draft.mode !== 'agent_trace') return undefined;
    if (draft.steps.length >= MAX_RECORDING_STEPS) {
      state.draftRecording = undefined;
      return `Recording reached the ${MAX_RECORDING_STEPS}-step limit and stopped without saving. Use browser_record_stop before the limit.`;
    }
    const compiled = this.compileRecordedAction(state, action);
    if (!compiled) return 'Skipped recording this step because it still referenced an ephemeral element ref.';
    draft.steps.push(compiled);
    if (draft.steps.length === MAX_RECORDING_STEPS) {
      return `Recorded step ${MAX_RECORDING_STEPS}. Stop and save the recording now; further steps will not be added.`;
    }
    return `Recorded step ${draft.steps.length}.`;
  }

  private compileRecordedAction(state: BrowserState, action: BrowserAction): BrowserRecordingStep | undefined {
    const page = state.pages.get(state.activePageId);
    const ref = 'ref' in action ? action.ref : undefined;
    const raw: Record<string, unknown> = {
      id: `step-${(state.draftRecording?.steps.length ?? 0) + 1}`,
      action: action.action === 'open' ? 'navigate' : action.action
    };
    if ('url' in action) raw.url = action.url;
    if ('text' in action) raw.value = action.text;
    if ('values' in action) raw.values = action.values;
    if ('key' in action) raw.key = action.key;
    if ('state' in action) raw.timeoutMs = action.timeoutMs;
    if ('deltaX' in action) {
      raw.deltaX = action.deltaX;
      raw.deltaY = action.deltaY;
    }
    if ('submit' in action) raw.submit = action.submit;
    const selector = 'selector' in action ? action.selector : undefined;
    let recordingFingerprint: Record<string, unknown> | undefined;
    if (ref && page) {
      const fingerprint = page.elementRefs.get(ref);
      if (!fingerprint) return undefined;
      recordingFingerprint = {
        primarySelector: fingerprint.selector,
        tag: fingerprint.tag,
        ...(fingerprint.role ? { role: fingerprint.role } : {}),
        ...(fingerprint.name ? { accessibleName: fingerprint.name } : {}),
        ...(fingerprint.id ? { id: fingerprint.id } : {}),
        ...(fingerprint.testId ? { testId: fingerprint.testId } : {}),
        ...(fingerprint.fieldName ? { fieldName: fingerprint.fieldName } : {}),
        ...(fingerprint.inputType ? { inputType: fingerprint.inputType } : {}),
        ...(fingerprint.placeholder ? { placeholder: fingerprint.placeholder } : {}),
        ...(fingerprint.href ? { href: fingerprint.href } : {})
      };
    }
    const targetSelector = selector ?? (recordingFingerprint?.primarySelector as string | undefined);
    const frame = ('frame' in action ? action.frame : undefined)
      ?? (ref && page ? page.elementRefs.get(ref)?.frame : undefined);
    const target = targetSelector || recordingFingerprint ? {
      ...(targetSelector ? { selector: targetSelector } : {}),
      ...(recordingFingerprint ? { fingerprint: recordingFingerprint } : {}),
      ...(frame ? { frame } : {})
    } : undefined;
    if (target) raw.target = target;
    if (action.action === 'wait' && target) {
      raw.condition = { type: 'element_state', target, state: action.state };
    }
    const parsed = BrowserRecordingStepSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private describeRecordedStep(action: BrowserRecordingStep | BrowserAction): string {
    if (action.action === 'open' || action.action === 'navigate') {
      try { return `open ${new URL(action.url ?? '').hostname}`; } catch { return 'open'; }
    }
    const selector = 'target' in action ? action.target?.selector : ('selector' in action ? action.selector : undefined);
    if (action.action === 'wait') {
      const state = 'condition' in action && action.condition?.type === 'element_state' ? action.condition.state : ('state' in action ? action.state : 'visible');
      return `wait for ${selector ?? 'condition'} to be ${state}`;
    }
    if (action.action === 'scroll') return selector ? `scroll to ${selector}` : `scroll by (${action.deltaX ?? 0}, ${action.deltaY ?? 0})`;
    if (action.action === 'click') return `click ${selector}`;
    if (action.action === 'hover') return `hover ${selector}`;
    if (action.action === 'type') {
      const value = 'id' in action ? action.value : action.text;
      return `type ${value?.length ?? 0} characters into ${selector}`;
    }
    if (action.action === 'press') return `press ${action.key}${selector ? ` on ${selector}` : ''}`;
    if (action.action === 'select') return `select ${(action.values?.length ?? 0)} value(s) in ${selector}`;
    if (action.action === 'back') return 'navigate back';
    if (action.action === 'reload') return 'reload page';
    return action.action;
  }

  private async replay(
    sessionId: string,
    state: BrowserState,
    recordingId: string,
    supplied: Record<string, RecordingParamValue>,
    maxRetries: number,
    retryDelayMs: number,
    newRunId: string | undefined,
    resumeRunId: string | undefined,
    confirmUnsafeResume: boolean,
    allowedDomains: Set<string>,
    workingDirectory: string,
    onProgress?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    assertReplayActive(signal);
    if (state.draftRecording) throw new Error('Stop the active browser recording before replaying a workflow.');
    let registryEntry: BrowserRecordingRegistryEntry;
    try {
      registryEntry = await this.recordingRegistry.getExecutable(recordingId, workingDirectory);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'browser_recording_untrusted') {
        return {
          callId: 'browser',
          ok: false,
          code: 'permission_denied',
          content: error instanceof Error ? error.message : String(error)
        };
      }
      throw error;
    }
    const recording = registryEntry.recording;
    const secrets = await this.resolveRecordingSecrets(sessionId, recording);
    const runId = resumeRunId ?? newRunId ?? `brun_${randomUUID()}`;
    const healingPort = this.healingPortForSession?.(sessionId);
    const healRecords: BrowserHealRecord[] = [];
    const healedSelectors = new Map<number, string>();
    const outputs: Record<string, { type: 'file'; path: string }> = {};
    let verifiedStepIds: ReadonlySet<string> = new Set();
    if (resumeRunId) {
      const entries = await this.replayJournal.read(runId);
      if (entries.length === 0) throw new Error(`Browser replay run does not exist: ${runId}`);
      const resume = analyzeBrowserReplayResume(recording, entries);
      Object.assign(outputs, resume.outputs);
      if (resume.unsafePendingStep && !confirmUnsafeResume) {
        return {
          callId: 'browser',
          ok: false,
          code: 'browser_resume_unsafe',
          content: `Browser replay ${runId} stopped after dispatching step ${resume.unsafePendingStep.stepId}. `
            + 'Confirm the external effect before retrying it.'
        };
      }
      const verified = new Set(resume.verifiedStepIds);
      if (resume.unsafePendingStep) verified.delete(resume.unsafePendingStep.stepId);
      verifiedStepIds = verified;
    } else if (newRunId && (await this.replayJournal.read(runId)).length > 0) {
      throw new Error(`Browser replay run already exists: ${runId}. Resume it instead of starting again.`);
    }
    const report = [`Replay run ${runId}`, `Replaying ${recording.id}: ${recording.name} (${recording.steps.length} steps)`];
    onProgress?.(`${resumeRunId ? 'Resuming' : 'Starting'} browser replay ${runId} (${recording.steps.length} steps).`);
    if (recording.start?.url && !verifiedStepIds.has('$start')) {
      assertReplayActive(signal);
      const startStep: BrowserRecordingStep = { id: '$start', action: 'navigate', url: recording.start.url };
      if (!isAllowedBrowserUrl(recording.start.url, recording.domains)) {
        return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: `${report.join('\n')}\n✗ Recording start domain violation: ${recording.start.url}` };
      }
      onProgress?.(`→ Preparing replay at ${recording.start.url}`);
      await this.appendReplayJournal(runId, recording, startStep, 0, 'step_started', 1);
      try {
        await this.appendReplayJournal(runId, recording, startStep, 0, 'step_effect_dispatched', 1);
        const startResult = await this.executeAction(
          sessionId,
          state,
          BrowserActionSchema.parse({ action: 'open', url: recording.start.url }),
          true,
          allowedDomains,
          workingDirectory,
          false,
          undefined,
          signal
        );
        if (!startResult.ok) throw new Error(startResult.content);
        await this.appendReplayJournal(runId, recording, startStep, 0, 'step_verified', 1);
      } catch (error) {
        if (signal?.aborted) throw error;
        await this.appendReplayJournal(runId, recording, startStep, 0, 'step_failed', 1);
        const detail = error instanceof Error ? error.message : String(error);
        report.push(`✗ Recording start: ${detail}`);
        onProgress?.(`✗ Replay preparation failed: ${detail}`);
        return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
      }
    }
    for (const [index, step] of recording.steps.entries()) {
      assertReplayActive(signal);
      const prepared = applyRecordingParams(step, recording, supplied, secrets);
      if (verifiedStepIds.has(prepared.id)) {
        report.push(`↷ ${index + 1}. ${this.describeRecordedStep(prepared)} (already verified)`);
        onProgress?.(`↷ ${index + 1}/${recording.steps.length} already verified; skipping.`);
        continue;
      }
      if (prepared.action === 'navigate' && prepared.url && !isAllowedBrowserUrl(prepared.url, recording.domains)) {
        return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: `${report.join('\n')}\n✗ ${index + 1}. Recording domain violation: ${prepared.url}` };
      }
      onProgress?.(`→ ${index + 1}/${recording.steps.length} ${this.describeRecordedStep(prepared)}`);
      await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_started', 1);
      let effectivePrepared = prepared;
      let healedRecord: BrowserHealRecord | undefined;
      let action: BrowserAction;
      try {
        await this.assertRecordingStepFramesAllowed(state, prepared, recording.domains);
        if (this.isDesktopHealableStep(prepared) && !await this.waitForRecordingTargetRecovery(
          state, prepared.target!, maxRetries, retryDelayMs, onProgress, signal
        )) {
          throw new Error(`Recording target was not found: ${prepared.target?.selector ?? prepared.target?.fingerprint?.accessibleName ?? prepared.id}`);
        }
        action = await this.recordingStepToAction(state, effectivePrepared, onProgress);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (healingPort && this.isDesktopHealableStep(prepared)
          && !(error instanceof Error && error.message.startsWith('Recording frame domain violation:'))) {
          try {
            onProgress?.('  Deterministic target recovery exhausted; requesting constrained self-heal.');
            const proposal = await this.proposeDesktopHeal(state, prepared, healingPort, signal);
            effectivePrepared = {
              ...prepared,
              target: { selector: proposal.selector, ...(prepared.target?.frame ? { frame: prepared.target.frame } : {}) }
            };
            action = await this.recordingStepToAction(state, effectivePrepared, onProgress);
            healedRecord = {
              stepId: prepared.id,
              ...(prepared.target?.selector ? { previousSelector: prepared.target.selector } : {}),
              selector: proposal.selector,
              confidence: proposal.confidence,
              ...(proposal.reason ? { reason: proposal.reason } : {}),
              persisted: false
            };
            await this.appendReplayJournal(
              runId, recording, prepared, index + 1, 'step_heal_proposed', 1,
              { selector: proposal.selector, confidence: proposal.confidence }
            );
          } catch (healError) {
            if (signal?.aborted) throw healError;
            await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_failed', 1);
            const detail = healError instanceof Error ? healError.message : String(healError);
            report.push(`✗ ${index + 1}. ${this.describeRecordedStep(prepared)} self-heal: ${detail}`);
            onProgress?.(`✗ ${index + 1}/${recording.steps.length} self-heal: ${detail}`);
            return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
          }
        } else {
          await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_failed', 1);
          const detail = error instanceof Error ? error.message : String(error);
          report.push(`✗ ${index + 1}. ${this.describeRecordedStep(prepared)}: ${detail}`);
          onProgress?.(`✗ ${index + 1}/${recording.steps.length} ${detail}`);
          return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
        }
      }
      const downloadsBefore = new Set(state.downloads.keys());
      const pagesBefore = new Set([...state.pages.values()].flatMap((page) => page.chrome ? [page.chrome.targetId] : []));
      if (prepared.action === 'download') await this.prepareChromeDownloadCapture(state);
      let attempt = 0;
      while (true) {
        assertReplayActive(signal);
        attempt += 1;
        try {
          if (attempt > 1) await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_started', attempt);
          if (!isReplaySafeBrowserStep(prepared)) {
            await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_effect_dispatched', attempt);
          }
          const result = await this.executeAction(sessionId, state, action, true, allowedDomains, workingDirectory, false, undefined, signal);
          assertReplayActive(signal);
          if (!result.ok) throw new Error(result.content);
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (attempt <= maxRetries && isRetryableBrowserStepError(error)) {
            onProgress?.(`  Recovery: retrying step ${index + 1} (attempt ${attempt + 1}/${maxRetries + 1}).`);
            await replayDelay(Math.min(2_000, retryDelayMs * attempt), signal);
            continue;
          }
          await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_failed', attempt);
          const detail = error instanceof Error ? error.message : String(error);
          report.push(`✗ ${index + 1}. ${this.describeRecordedStep(prepared)}: ${detail}`);
          onProgress?.(`✗ ${index + 1}/${recording.steps.length} ${detail}`);
          return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
        }
      }
      try {
        const completedDownload = prepared.action === 'download'
          ? await this.waitForNewDownload(state, downloadsBefore, prepared.timeoutMs ?? 30_000, signal)
          : undefined;
        await this.applyRecordingWaitPolicy(state, effectivePrepared, pagesBefore, onProgress, signal);
        assertReplayActive(signal);
        await this.verifyRecordingState(state, effectivePrepared.verify, effectivePrepared.target, completedDownload);
        const currentUrl = this.pageUrl(this.activePage(state));
        if (currentUrl !== 'about:blank' && !isAllowedBrowserUrl(currentUrl, recording.domains)) {
          throw new Error(`Recording domain violation after step: ${currentUrl}`);
        }
        if (completedDownload) {
          report.push(`  ↓ ${prepared.bind ?? 'download'}: ${completedDownload.path}`);
          if (prepared.bind) outputs[prepared.bind] = { type: 'file', path: completedDownload.path };
          onProgress?.(`  ↓ Download completed: ${completedDownload.path}`);
        }
        await this.appendReplayJournal(
          runId, recording, prepared, index + 1, 'step_verified', attempt, undefined,
          prepared.bind && outputs[prepared.bind] ? { name: prepared.bind, value: outputs[prepared.bind]! } : undefined
        );
        if (healedRecord) {
          await this.appendReplayJournal(
            runId, recording, prepared, index + 1, 'step_heal_verified', attempt,
            { selector: healedRecord.selector, confidence: healedRecord.confidence }
          );
          healRecords.push(healedRecord);
          healedSelectors.set(index, healedRecord.selector);
          report.push(`  ⚕ selector healed to ${healedRecord.selector} (${healedRecord.confidence.toFixed(2)})`);
          onProgress?.(`  ⚕ Self-heal verified: ${healedRecord.selector}`);
        }
        report.push(`✓ ${index + 1}. ${this.describeRecordedStep(prepared)}${attempt > 1 ? ` (${attempt} attempts)` : ''}`);
        onProgress?.(`✓ ${index + 1}/${recording.steps.length} verified.`);
      } catch (error) {
        if (signal?.aborted) throw error;
        await this.appendReplayJournal(runId, recording, prepared, index + 1, 'step_failed', attempt);
        const detail = error instanceof Error ? error.message : String(error);
        report.push(`✗ ${index + 1}. ${this.describeRecordedStep(prepared)} verification: ${detail}`);
        onProgress?.(`✗ ${index + 1}/${recording.steps.length} verification: ${detail}`);
        return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
      }
    }
    try {
      await this.verifyRecordingState(state, recording.end, undefined, undefined);
    } catch (error) {
      if (signal?.aborted) throw error;
      report.push(`✗ Final verification: ${error instanceof Error ? error.message : String(error)}`);
      return { callId: 'browser', ok: false, code: 'browser_replay_failed', content: report.join('\n') };
    }
    if (healRecords.length > 0) {
      try {
        const saved = await this.recordingRegistry.save({
          ...recording,
          steps: recording.steps.map((step, index) => {
            const selector = healedSelectors.get(index);
            return selector ? { ...step, target: { ...step.target!, selector } } : step;
          })
        }, workingDirectory, { expectedRevision: recording.revision, expectedHash: recording.contentHash });
        for (const record of healRecords) record.persisted = true;
        report.push(`Persisted ${healRecords.length} verified selector heal(s) as recording revision ${saved.revision}.`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        for (const record of healRecords) record.persistenceError = detail;
        report.push(`⚠ Replay succeeded, but healed selectors were not persisted: ${detail}`);
      }
    }
    const lastStep = recording.steps.at(-1);
    if (lastStep) await this.appendReplayJournal(runId, recording, lastStep, recording.steps.length, 'run_completed');
    report.push('Replay completed.');
    onProgress?.(`✓ Browser replay ${runId} completed.`);
    return {
      callId: 'browser', ok: true, content: report.join('\n'),
      structuredResult: {
        runId,
        recordingId: recording.id,
        success: true,
        outputs,
        finalUrl: this.pageUrl(this.activePage(state)),
        selfHealed: healRecords.length > 0,
        ...(healRecords.length > 0 ? { healRecords } : {})
      }
    };
  }

  private async appendReplayJournal(
    runId: string,
    recording: BrowserRecordingDocument,
    step: BrowserRecordingStep,
    stepIndex: number,
    state: Parameters<typeof createBrowserReplayJournalEntry>[0]['state'],
    attempt?: number,
    heal?: { selector: string; confidence: number },
    output?: { name: string; value: BrowserReplayJournalOutputValue }
  ): Promise<void> {
    await this.replayJournal.append(createBrowserReplayJournalEntry({
      runId,
      recordingId: recording.id,
      revision: recording.revision,
      stepId: step.id,
      stepIndex,
      action: step.action,
      state,
      ...(attempt === undefined ? {} : { attempt }),
      ...(heal ?? {}),
      ...(output ? { output } : {})
    }));
  }

  private isDesktopHealableStep(step: BrowserRecordingStep): boolean {
    return Boolean(step.target && ['click', 'hover', 'type', 'press', 'select', 'upload', 'download'].includes(step.action));
  }

  private async assertRecordingStepFramesAllowed(
    state: BrowserState,
    step: BrowserRecordingStep,
    domains: string[]
  ): Promise<void> {
    const paths = [
      step.target?.frame,
      step.condition?.type === 'element_state' ? step.condition.target.frame : undefined,
      step.wait?.elementVisible?.frame,
      step.verify?.exists?.frame,
      step.verify?.notExists?.frame
    ].filter((frame): frame is BrowserFramePath => Boolean(frame));
    const seen = new Set<string>();
    for (const frame of paths) {
      const key = JSON.stringify(frame.selectors);
      if (seen.has(key)) continue;
      seen.add(key);
      const response = (await this.evaluateInFrame(state, frame, 'location.href')).response;
      const url = resultValue<string>(response);
      if (!url || !isAllowedBrowserUrl(url, domains)) {
        throw new Error(`Recording frame domain violation: ${url ?? frame.selectors.join(' -> ')}`);
      }
    }
  }

  private async waitForRecordingTargetRecovery(
    state: BrowserState,
    target: BrowserTarget,
    maxRetries: number,
    retryDelayMs: number,
    onProgress?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<boolean> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      assertReplayActive(signal);
      if (await this.recordingTargetExists(state, target)) return true;
      if (attempt === maxRetries) return false;
      onProgress?.(`  Target unavailable; deterministic retry ${attempt + 1}/${maxRetries}.`);
      await replayDelay(Math.min(2_000, retryDelayMs * (attempt + 1)), signal);
    }
    return false;
  }

  private async proposeDesktopHeal(
    state: BrowserState,
    step: BrowserRecordingStep,
    healingPort: BrowserHealingPort,
    signal?: AbortSignal
  ): Promise<BrowserHealProposal> {
    assertReplayActive(signal);
    const candidates = await this.browserHealCandidates(state, step.target?.frame);
    if (candidates.length === 0) throw new Error('Browser self-heal has no visible interactable candidates.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Browser self-heal timed out.')), 30_000);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      const frameUrl = step.target?.frame
        ? resultValue<string>((await this.evaluateInFrame(state, step.target.frame, 'location.href')).response)
        : undefined;
      const proposal = await healingPort.heal({
        action: step.action,
        ...(step.target?.selector ? { failedSelector: step.target.selector } : {}),
        ...(step.target?.fingerprint ? { fingerprint: step.target.fingerprint } : {}),
        url: frameUrl ?? this.pageUrl(this.activePage(state)),
        candidates
      }, controller.signal);
      if (proposal.confidence < 0.8) throw new Error(`Browser self-heal confidence ${proposal.confidence} is below 0.8.`);
      if (candidates.filter((candidate) => candidate.selector === proposal.selector).length !== 1) {
        throw new Error('Browser self-heal proposed a selector outside the unique candidate set.');
      }
      return {
        selector: proposal.selector,
        confidence: proposal.confidence,
        ...(proposal.reason ? { reason: proposal.reason } : {})
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async browserHealCandidates(state: BrowserState, frame?: BrowserFramePath): Promise<BrowserHealCandidate[]> {
    const expression = `(() => {
      const selectorFor = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const parts = [];
        let current = el;
        while (current && current !== document.body && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName) : [];
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      return Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]'))
        .filter((el) => el instanceof HTMLElement && el.offsetParent !== null)
        .slice(0, 300)
        .map((el) => ({
          selector: selectorFor(el),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || undefined,
          accessibleName: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().slice(0, 500) || undefined,
          visible: true
        }));
    })()`;
    const response = (await this.evaluateInFrame(state, frame, expression)).response;
    return resultValue<BrowserHealCandidate[]>(response) ?? [];
  }

  private async prepareChromeDownloadCapture(state: BrowserState): Promise<void> {
    const page = this.activePage(state);
    const client = page.chrome?.client;
    if (!client) throw new Error('Recording download replay requires an attached Chrome page.');
    const downloadDirectory = path.join(this.dataDirectory, 'browser-downloads', state.partition);
    await mkdir(downloadDirectory, { recursive: true });
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
      eventsEnabled: true
    });
  }

  private async waitForNewDownload(
    state: BrowserState,
    previousIds: ReadonlySet<string>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<DownloadRecord> {
    const client = this.activePage(state).chrome?.client;
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < timeoutMs) {
        assertReplayActive(signal);
        const candidate = [...state.downloads.values()].find((record) => !previousIds.has(record.id));
        if (candidate?.state === 'completed') return candidate;
        if (candidate && ['cancelled', 'interrupted'].includes(candidate.state)) {
          throw new Error(`Browser download ${candidate.state}: ${candidate.filename}`);
        }
        await replayDelay(100, signal);
      }
      throw new Error(`Timed out after ${timeoutMs} ms waiting for the browser download.`);
    } finally {
      await client?.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: false }).catch(() => undefined);
    }
  }

  private async applyRecordingWaitPolicy(
    state: BrowserState,
    step: BrowserRecordingStep,
    pagesBefore: ReadonlySet<string>,
    onProgress?: (text: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    assertReplayActive(signal);
    const policy = step.wait;
    if (!policy) return;
    const timeoutMs = policy.timeoutMs ?? 15_000;
    if (policy.newPage) {
      onProgress?.('  Waiting for a new browser page.');
      await this.waitForRecordingNewPage(state, pagesBefore, timeoutMs, signal);
    }
    if (policy.networkIdle) {
      onProgress?.('  Waiting for network idle.');
      await this.waitForRecordingNetworkIdle(state, timeoutMs, signal);
    }
    if (policy.domStableMs) {
      onProgress?.('  Waiting for DOM stability.');
      await this.waitForRecordingDomStable(state, policy.domStableMs, timeoutMs, step.target?.frame);
      assertReplayActive(signal);
    }
    if (policy.elementVisible) {
      onProgress?.('  Waiting for the expected element to become visible.');
      const selector = await this.resolveRecordingTargetSelector(state, policy.elementVisible);
      await this.wait(state, { selector, ...(policy.elementVisible.frame ? { frame: policy.elementVisible.frame } : {}) }, 'visible', timeoutMs);
    }
  }

  private async waitForRecordingNewPage(
    state: BrowserState,
    previousTargetIds: ReadonlySet<string>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      assertReplayActive(signal);
      await this.refreshChromePages(state);
      const page = [...state.pages.values()].find((candidate) => (
        candidate.chrome && !previousTargetIds.has(candidate.chrome.targetId) && !candidate.destroyed
      ));
      if (page) {
        if (!page.chrome?.client) await this.connectChromeClient(state, page);
        state.activePageId = page.id;
        return;
      }
      await replayDelay(100, signal);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for a new browser page.`);
  }

  private async waitForRecordingNetworkIdle(state: BrowserState, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    let idleSince: number | undefined;
    while (Date.now() - startedAt < timeoutMs) {
      assertReplayActive(signal);
      const page = this.activePage(state);
      const pending = page.kind === 'chrome'
        ? page.pendingNetworkRequests.size
        : page.network.filter((record) => record.pending).length;
      if (pending === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 500) return;
      } else idleSince = undefined;
      await replayDelay(100, signal);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for network idle.`);
  }

  private async waitForRecordingDomStable(
    state: BrowserState,
    stableMs: number,
    timeoutMs: number,
    frame?: BrowserFramePath
  ): Promise<void> {
    const expression = `new Promise((resolve) => {
      let stable;
      let hard;
      const observer = new MutationObserver(() => {
        clearTimeout(stable);
        stable = setTimeout(done, ${JSON.stringify(stableMs)});
      });
      const done = () => {
        clearTimeout(stable);
        clearTimeout(hard);
        observer.disconnect();
        resolve(true);
      };
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      stable = setTimeout(done, ${JSON.stringify(stableMs)});
      hard = setTimeout(done, ${JSON.stringify(timeoutMs)});
    })`;
    await this.evaluateInFrame(state, frame, expression);
  }

  private async verifyRecordingState(
    state: BrowserState,
    verify: BrowserVerify | undefined,
    stepTarget: BrowserTarget | undefined,
    download: DownloadRecord | undefined
  ): Promise<void> {
    if (!verify) return;
    const currentUrl = this.pageUrl(this.activePage(state));
    if (verify.urlContains && !currentUrl.includes(verify.urlContains)) {
      throw new Error(`URL does not contain ${verify.urlContains}.`);
    }
    if (verify.urlMatches) {
      let pattern: RegExp;
      try { pattern = new RegExp(verify.urlMatches, 'u'); }
      catch { throw new Error(`Invalid URL verification pattern: ${verify.urlMatches}`); }
      if (!pattern.test(currentUrl)) throw new Error(`URL does not match ${verify.urlMatches}.`);
    }
    if (verify.exists && !await this.recordingTargetExists(state, verify.exists)) {
      throw new Error('Expected element does not exist.');
    }
    if (verify.notExists && await this.recordingTargetExists(state, verify.notExists)) {
      throw new Error('Unexpected element exists.');
    }
    if (verify.textContains) {
      const response = (await this.evaluateInFrame(
        state,
        stepTarget?.frame,
        `document.body?.innerText?.includes(${JSON.stringify(verify.textContains)}) === true`
      )).response;
      if (resultValue<boolean>(response) !== true) throw new Error(`Page text does not contain ${verify.textContains}.`);
    }
    if (verify.valueEquals !== undefined || verify.valueNotEmpty) {
      if (!stepTarget) throw new Error('Value verification requires a step target.');
      const selector = await this.resolveRecordingTargetSelector(state, stepTarget);
      const response = (await this.evaluateInFrame(
        state,
        stepTarget.frame,
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && 'value' in el ? String(el.value) : el?.textContent ?? ''; })()`
      )).response;
      const value = resultValue<string>(response) ?? '';
      if (verify.valueEquals !== undefined && value !== verify.valueEquals) throw new Error('Target value does not equal the expected value.');
      if (verify.valueNotEmpty && !value) throw new Error('Target value is empty.');
    }
    if (verify.downloadCompleted && download?.state !== 'completed') throw new Error('Expected download did not complete.');
  }

  private async recordingTargetExists(state: BrowserState, target: BrowserTarget): Promise<boolean> {
    try {
      const selector = await this.resolveRecordingTargetSelector(state, target);
      const response = (await this.evaluateInFrame(
        state,
        target.frame,
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`
      )).response;
      return resultValue<boolean>(response) === true;
    } catch { return false; }
  }

  private async resolveRecordingTargetSelector(state: BrowserState, target: BrowserTarget): Promise<string> {
    let selector = target.selector ?? target.fingerprint?.primarySelector ?? '';
    if (target.fingerprint) selector = await this.relocateRecordedSelector(state, selector, target.fingerprint, target.frame);
    if (!selector) throw new Error('Recording target has no resolvable selector.');
    return selector;
  }

  private async resolveRecordingSecrets(sessionId: string, recording: BrowserRecordingDocument): Promise<Record<string, string>> {
    const secrets = { ...secretEnvValues(recording.params) };
    const cache = this.secrets.get(sessionId) ?? new Map<string, string>();
    for (const [name, value] of cache) if (secrets[name] === undefined) secrets[name] = value;
    for (const param of recording.params) {
      if (!param.secret || secrets[param.name]) continue;
      const entered = this.promptSecret
        ? await this.promptSecret({ name: param.name, ...(param.description ? { description: param.description } : {}) })
        : undefined;
      if (!entered) throw new Error(`Missing secret recording param ${param.name}. Set ${browserSecretEnvName(param.name)} or enter it when prompted.`);
      secrets[param.name] = entered;
      cache.set(param.name, entered);
    }
    this.secrets.set(sessionId, cache);
    return secrets;
  }

  private async recordingStepToAction(
    state: BrowserState,
    step: BrowserRecordingStep,
    onProgress?: (text: string) => void
  ): Promise<BrowserAction> {
    let selector = step.target?.selector;
    if (step.target?.fingerprint) {
      const fallback = selector ?? step.target.fingerprint.primarySelector ?? '';
      selector = await this.relocateRecordedSelector(state, fallback, step.target.fingerprint, step.target.frame);
      if (fallback && selector !== fallback) onProgress?.(`  Selector relocated: ${fallback} → ${selector}`);
    }
    const target = selector ? { selector, ...(step.target?.frame ? { frame: step.target.frame } : {}) } : {};
    switch (step.action) {
      case 'navigate': return BrowserActionSchema.parse({ action: 'open', url: step.url });
      case 'click': return BrowserActionSchema.parse({ action: 'click', ...target });
      case 'hover': return BrowserActionSchema.parse({ action: 'hover', ...target });
      case 'type': return BrowserActionSchema.parse({ action: 'type', ...target, text: step.value, submit: step.submit ?? false });
      case 'press': return BrowserActionSchema.parse({ action: 'press', ...target, key: step.key });
      case 'select': return BrowserActionSchema.parse({ action: 'select', ...target, values: step.values });
      case 'upload': return BrowserActionSchema.parse({ action: 'upload', ...target, paths: step.paths });
      case 'wait': {
        if (step.condition?.type !== 'element_state') throw new Error(`Desktop adapter does not yet support wait condition ${step.condition?.type ?? 'missing'}.`);
        let waitSelector = step.condition.target.selector;
        if (step.condition.target.fingerprint) {
          const fallback = waitSelector ?? step.condition.target.fingerprint.primarySelector ?? '';
          waitSelector = await this.relocateRecordedSelector(
            state,
            fallback,
            step.condition.target.fingerprint,
            step.condition.target.frame
          );
          if (fallback && waitSelector !== fallback) onProgress?.(`  Selector relocated: ${fallback} → ${waitSelector}`);
        }
        return BrowserActionSchema.parse({
          action: 'wait', selector: waitSelector,
          ...(step.condition.target.frame ? { frame: step.condition.target.frame } : {}),
          state: step.condition.state,
          timeoutMs: step.timeoutMs ?? 5_000
        });
      }
      case 'scroll': return BrowserActionSchema.parse({ action: 'scroll', ...target, deltaX: step.deltaX ?? 0, deltaY: step.deltaY ?? 600 });
      case 'back': return BrowserActionSchema.parse({ action: 'back' });
      case 'reload': return BrowserActionSchema.parse({ action: 'reload' });
      case 'download': return BrowserActionSchema.parse({ action: 'click', ...target });
      case 'extract':
        throw new Error(`Desktop adapter does not yet support Recording V2 action ${step.action}.`);
    }
  }

  private async relocateRecordedSelector(
    state: BrowserState,
    selector: string,
    fingerprint: NonNullable<NonNullable<BrowserRecordingStep['target']>['fingerprint']>,
    frame?: BrowserFramePath
  ): Promise<string> {
    try {
      this.assertOpenPage(state);
    } catch {
      return selector;
    }
    if (selector) {
      const exists = resultValue<{ ok?: boolean }>((await this.evaluateInFrame(
        state,
        frame,
        `({ ok: Boolean(document.querySelector(${JSON.stringify(selector)})) })`
      )).response);
      if (exists?.ok) return selector;
    }
    const page = this.activePage(state);
    const location = resultValue<string>((await this.evaluateInFrame(state, frame, 'location.href')).response)
      ?? this.pageUrl(page);
    const origin = new URL(location).origin;
    const match = await this.resolveElementTarget(state, {
      ...(frame ? { frame } : {}),
      fingerprint: {
        origin,
        selector: fingerprint.primarySelector ?? selector,
        tag: fingerprint.tag,
        ...(frame ? { frame } : {}),
        ...(fingerprint.role ? { role: fingerprint.role } : {}),
        ...(fingerprint.accessibleName ? { name: fingerprint.accessibleName } : {}),
        ...(fingerprint.id ? { id: fingerprint.id } : {}),
        ...(fingerprint.testId ? { testId: fingerprint.testId } : {}),
        ...(fingerprint.fieldName ? { fieldName: fingerprint.fieldName } : {}),
        ...(fingerprint.inputType ? { inputType: fingerprint.inputType } : {}),
        ...(fingerprint.placeholder ? { placeholder: fingerprint.placeholder } : {}),
        ...(fingerprint.href ? { href: fingerprint.href } : {})
      }
    }, true);
    return match?.selector ?? selector;
  }

  private async read(state: BrowserState, maxNodes: number, frame?: BrowserFramePath): Promise<ToolResult> {
    this.assertOpenPage(state);
    const page = this.activePage(state);
    const expression = `(() => {
      const selectorFor = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const parts = [];
        let current = el;
        while (current && current !== document.body && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName) : [];
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      return Array.from(document.querySelectorAll('a,button,input,textarea,select,iframe,frame,[role],[contenteditable="true"],h1,h2,h3,main,article,p'))
        .filter((el) => el instanceof HTMLElement && el.offsetParent !== null)
        .slice(0, ${JSON.stringify(maxNodes)})
        .map((el) => ({
          selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
          name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().slice(0, 500) || undefined,
          value: ('value' in el ? String(el.value) : '').slice(0, 500) || undefined,
          id: el.id || undefined,
          testId: el.getAttribute('data-testid') || undefined,
          fieldName: el.getAttribute('name') || undefined,
          inputType: el instanceof HTMLInputElement ? el.type : undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          href: el instanceof HTMLAnchorElement ? el.href : undefined,
          frameUrl: (el instanceof HTMLIFrameElement || el instanceof HTMLFrameElement) ? el.src : undefined
        }));
    })()`;
    const domResponse = (await this.evaluateInFrame(state, frame, expression)).response;
    const domNodes = resultValue<BrowserDomNode[]>(domResponse) ?? [];
    const frameUrl = resultValue<string>((await this.evaluateInFrame(state, frame, 'location.href')).response)
      ?? this.pageUrl(page);
    const origin = new URL(frameUrl).origin;
    const referencedNodes = domNodes.map((node) => {
      const ref = `e${state.nextElementRef++}`;
      page.elementRefs.set(ref, {
        origin,
        selector: node.selector,
        tag: node.tag,
        ...(frame ? { frame } : {}),
        ...(node.role ? { role: node.role } : {}),
        ...(node.name ? { name: node.name } : {}),
        ...(node.id ? { id: node.id } : {}),
        ...(node.testId ? { testId: node.testId } : {}),
        ...(node.fieldName ? { fieldName: node.fieldName } : {}),
        ...(node.inputType ? { inputType: node.inputType } : {}),
        ...(node.placeholder ? { placeholder: node.placeholder } : {}),
        ...(node.href ? { href: node.href } : {})
      });
      return { ref, ...node, ...(frame ? { frame } : {}) };
    });
    while (page.elementRefs.size > 4_000) {
      const oldest = page.elementRefs.keys().next().value;
      if (typeof oldest !== 'string') break;
      page.elementRefs.delete(oldest);
    }
    const domTree = referencedNodes.map((node) => JSON.stringify(node)).join('\n');
    if (domTree) return ok(`Page: ${page.id}\nURL: ${frameUrl}\nTitle: ${this.pageTitle(page)}${frame ? `\nFrame: ${frame.selectors.join(' -> ')}` : ''}\n\n[DOM structure; prefer ref for actions because it can survive DOM reordering; selector remains supported]\n${domTree}`);
    const route = await this.resolveFrameRoute(state, frame);
    const axResponse = await this.sendCommand(state, 'Accessibility.getFullAXTree', undefined, COMMAND_TIMEOUT_MS, route.sessionId);
    const nodes = (axResponse as { nodes?: AccessibilityNode[] }).nodes ?? [];
    const tree = formatAccessibilityTree(nodes, maxNodes);
    return ok(`Page: ${page.id}\nURL: ${frameUrl}\nTitle: ${this.pageTitle(page)}${frame ? `\nFrame: ${frame.selectors.join(' -> ')}` : ''}\n\n${tree || '[No accessible page content]'}`);
  }

  private async resolveElementTarget(
    state: BrowserState,
    target: BrowserElementTarget,
    allowMissing = false
  ): Promise<ResolvedElementTarget | undefined> {
    if (target.selector && !target.fingerprint) return {
      selector: target.selector,
      label: target.selector,
      relocated: false,
      ...(target.frame ? { frame: target.frame } : {})
    };
    const page = this.activePage(state);
    const fingerprint = target.fingerprint ?? (target.ref ? page.elementRefs.get(target.ref) : undefined);
    if (!fingerprint) {
      if (target.selector) return {
        selector: target.selector,
        label: target.selector,
        relocated: false,
        ...(target.frame ? { frame: target.frame } : {})
      };
      if (allowMissing) return undefined;
      throw new Error(target.ref ? `Unknown or expired browser element ref: ${target.ref}. Run browser_read again.` : 'Browser element target requires selector or ref.');
    }
    const frame = target.frame ?? fingerprint.frame;
    const currentUrl = resultValue<string>((await this.evaluateInFrame(state, frame, 'location.href')).response)
      ?? this.pageUrl(page);
    const currentOrigin = new URL(currentUrl).origin;
    if (currentOrigin !== fingerprint.origin) {
      throw new Error(`Browser element ${target.ref ?? 'fingerprint'} belongs to ${fingerprint.origin}, not ${currentOrigin}. Run browser_read again.`);
    }
    const expression = `(() => {
      const selectorFor = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid');
        if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
        const name = el.getAttribute('name');
        if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
        const parts = [];
        let current = el;
        while (current && current !== document.body && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName) : [];
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      return Array.from(document.querySelectorAll(${JSON.stringify(fingerprint.tag)})).slice(0, 5000).map((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
          name: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().slice(0, 500) || undefined,
          id: el.id || undefined, testId: el.getAttribute('data-testid') || undefined,
          fieldName: el.getAttribute('name') || undefined,
          inputType: el instanceof HTMLInputElement ? el.type : undefined,
          placeholder: el.getAttribute('placeholder') || undefined,
          href: el instanceof HTMLAnchorElement ? el.href : undefined,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0
        };
      });
    })()`;
    const response = (await this.evaluateInFrame(state, frame, expression)).response;
    const candidates = resultValue<BrowserElementCandidate[]>(response) ?? [];
    const match = chooseBrowserElementCandidate(fingerprint, candidates);
    if (match.ambiguous) {
      throw new Error(`Browser element ${target.ref ?? 'fingerprint'} is ambiguous after the page changed. Run browser_read again.`);
    }
    if (!match.candidate) {
      if (allowMissing) return undefined;
      throw new Error(`Browser element ${target.ref ?? 'fingerprint'} could not be safely relocated. Run browser_read again.`);
    }
    const previousSelector = fingerprint.selector;
    fingerprint.selector = match.candidate.selector;
    return {
      selector: match.candidate.selector,
      label: target.ref ?? match.candidate.selector,
      relocated: previousSelector !== match.candidate.selector,
      ...(frame ? { frame } : {})
    };
  }

  private targetDescription(target: ResolvedElementTarget): string {
    return target.relocated ? `${target.label} (relocated to ${target.selector})` : target.label;
  }

  private async wait(
    state: BrowserState,
    target: BrowserElementTarget,
    expectedState: 'attached' | 'detached' | 'visible' | 'hidden',
    timeoutMs: number
  ): Promise<ToolResult> {
    this.assertOpenPage(state);
    const startedAt = Date.now();
    while (true) {
      const resolved = await this.resolveElementTarget(state, target, true);
      if (!resolved) {
        if (expectedState === 'detached' || expectedState === 'hidden') return ok(`Element ${target.ref} is ${expectedState}.`);
        if (Date.now() - startedAt >= timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${target.ref} to become ${expectedState}.`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, timeoutMs)));
        continue;
      }
      const expression = `(() => {
        const el = document.querySelector(${JSON.stringify(resolved.selector)});
        if (!el) return { attached: false, visible: false };
        if (!(el instanceof Element)) return { attached: true, visible: false };
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          attached: true,
          visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0
        };
      })()`;
      const response = (await this.evaluateInFrame(state, resolved.frame, expression)).response;
      const value = resultValue<{ attached: boolean; visible: boolean }>(response) ?? { attached: false, visible: false };
      const matches = expectedState === 'attached' ? value.attached
        : expectedState === 'detached' ? !value.attached
          : expectedState === 'visible' ? value.visible : !value.visible;
      if (matches) return ok(`Element ${this.targetDescription(resolved)} is ${expectedState}.`);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for ${resolved.label} to become ${expectedState}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs)));
    }
  }

  private async scroll(state: BrowserState, target: BrowserElementTarget, deltaX: number, deltaY: number): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = target.selector || target.ref ? await this.resolveElementTarget(state, target) : undefined;
    const expression = resolved
      ? `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof Element)) return { ok: false, error: 'Element not found' }; el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); return { ok: true, x: window.scrollX, y: window.scrollY }; })()`
      : `(() => { window.scrollBy({ left: ${JSON.stringify(deltaX)}, top: ${JSON.stringify(deltaY)}, behavior: 'instant' }); return { ok: true, x: window.scrollX, y: window.scrollY }; })()`;
    const response = (await this.evaluateInFrame(state, resolved?.frame ?? target.frame, expression)).response;
    const value = resultValue<{ ok: boolean; error?: string; x?: number; y?: number }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Scroll failed.');
    return ok(resolved
      ? `Scrolled ${this.targetDescription(resolved)} into view at (${value.x ?? 0}, ${value.y ?? 0}).`
      : `Scrolled by (${deltaX}, ${deltaY}) to (${value.x ?? 0}, ${value.y ?? 0}).`);
  }

  private async click(state: BrowserState, target: BrowserElementTarget): Promise<ToolResult> {
    this.assertOpenPage(state);
    state.lastBlockedPopup = undefined;
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser click target was not found.');
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!el) return { ok: false, error: 'Element not found' }; if (!(el instanceof HTMLElement)) return { ok: false, error: 'Element is not clickable' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true, tag: el.tagName, text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 500) }; })()`;
    const response = (await this.evaluateInFrame(state, resolved.frame, expression)).response;
    const value = resultValue<{ ok: boolean; error?: string; tag?: string; text?: string }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Click failed.');
    const blockedPopup = state.lastBlockedPopup;
    state.lastBlockedPopup = undefined;
    return ok(`Clicked ${this.targetDescription(resolved)}${value.text ? `: ${value.text}` : ''}${blockedPopup ? `\nBlocked popup navigation to unapproved URL: ${blockedPopup}` : ''}`);
  }

  private async hover(state: BrowserState, target: BrowserElementTarget): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser hover target was not found.');
    const locate = `(() => {
      const el = document.querySelector(${JSON.stringify(resolved.selector)});
      if (!(el instanceof Element)) return { ok: false, error: 'Element not found' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      return {
        ok: true,
        x: rect.left + Math.max(1, rect.width / 2),
        y: rect.top + Math.max(1, rect.height / 2),
        tag: el.tagName,
        text: ((el instanceof HTMLElement ? el.innerText : '') || el.getAttribute('aria-label') || '').slice(0, 500)
      };
    })()`;
    const located = resultValue<{ ok: boolean; error?: string; x?: number; y?: number; text?: string }>(
      (await this.evaluateInFrame(state, resolved.frame, locate)).response
    );
    if (!located?.ok) throw new Error(located?.error ?? 'Hover failed.');
    const x = located.x ?? 0;
    const y = located.y ?? 0;
    const hoverRoute = await this.resolveFrameRoute(state, resolved.frame);
    await this.sendCommand(state, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, COMMAND_TIMEOUT_MS, hoverRoute.sessionId);
    const fire = `(() => {
      const el = document.querySelector(${JSON.stringify(resolved.selector)});
      if (!(el instanceof Element)) return { ok: false, error: 'Element not found' };
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: ${JSON.stringify(x)}, clientY: ${JSON.stringify(y)}, view: window };
      try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch {}
      try { el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, opts, { bubbles: false }))); } catch {}
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, opts, { bubbles: false })));
      return { ok: true };
    })()`;
    const fired = resultValue<{ ok: boolean; error?: string }>(
      (await this.evaluateInFrame(state, resolved.frame, fire)).response
    );
    if (!fired?.ok) throw new Error(fired?.error ?? 'Hover failed.');
    return ok(`Hovered ${this.targetDescription(resolved)}${located.text ? `: ${located.text}` : ''}`);
  }

  private async evaluate(state: BrowserState, js: string): Promise<ToolResult> {
    this.assertOpenPage(state);
    if (js.length > BROWSER_EVAL_MAX_JS_CHARS) {
      throw new Error(`JavaScript exceeds the ${BROWSER_EVAL_MAX_JS_CHARS} character limit.`);
    }
    const expression = `(async () => {
      const max = ${BROWSER_EVAL_MAX_RESULT_CHARS};
      try {
        const value = await Promise.resolve().then(() => eval(${JSON.stringify(js)}));
        let json;
        try { json = JSON.stringify(value === undefined ? null : value); }
        catch { json = JSON.stringify(String(value)); }
        if (typeof json !== 'string') json = '"[unserializable]"';
        const truncated = json.length > max;
        return { ok: true, truncated, json: truncated ? json.slice(0, max) : json };
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        return { ok: false, error: message.slice(0, 2000) };
      }
    })()`;
    let response: unknown;
    try {
      response = await this.sendCommand(state, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, BROWSER_EVAL_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof Error && /timed out/iu.test(error.message)) {
        throw new Error(`JavaScript evaluation timed out after ${BROWSER_EVAL_TIMEOUT_MS} ms.`);
      }
      throw error;
    }
    const exception = (response as {
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }).exceptionDetails;
    if (exception) {
      throw new Error(exception.exception?.description || exception.text || 'JavaScript evaluation failed.');
    }
    const value = resultValue<{ ok: boolean; error?: string; json?: string; truncated?: boolean }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'JavaScript evaluation failed.');
    const json = value.json ?? 'null';
    const truncated = value.truncated === true || json.length > BROWSER_EVAL_MAX_RESULT_CHARS;
    const body = json.length > BROWSER_EVAL_MAX_RESULT_CHARS
      ? `${json.slice(0, BROWSER_EVAL_MAX_RESULT_CHARS)}\n...[truncated]`
      : json;
    return ok(`Evaluated JavaScript in the page.${truncated ? '\nResult truncated.' : ''}\nResult:\n${body}`);
  }

  private async cookies(state: BrowserState, includeValues: boolean): Promise<ToolResult> {
    const page = this.activePage(state);
    let cookies: Array<{
      name: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean;
      session?: boolean; sameSite?: string; expirationDate?: number; expires?: number; value?: string;
    }>;
    if (page.kind === 'chrome') {
      if (!page.chrome?.client) throw new Error('Select this Chrome tab with browser_select_page before reading cookies.');
      const currentUrl = this.pageUrl(page);
      const scoped = currentUrl && currentUrl !== 'about:blank'
        ? await page.chrome.client.send('Network.getCookies', { urls: [currentUrl] }) as { cookies?: typeof cookies }
        : await page.chrome.client.send('Network.getAllCookies') as { cookies?: typeof cookies };
      cookies = scoped.cookies ?? [];
    } else {
      const contents = this.electronContents(page);
      if (!contents) throw new Error('The controlled browser has no open page.');
      cookies = await contents.session.cookies.get({});
    }
    const records = cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      session: cookie.session ?? (cookie.expirationDate === undefined && cookie.expires === undefined),
      sameSite: cookie.sameSite,
      ...(cookie.expirationDate === undefined && cookie.expires === undefined ? {} : { expires: cookie.expirationDate ?? cookie.expires }),
      ...(includeValues ? { value: cookie.value } : {})
    }));
    return ok(JSON.stringify({ includeValues, count: records.length, cookies: records }, null, 2));
  }

  private async type(state: BrowserState, target: BrowserElementTarget, text: string, submit: boolean): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser type target was not found.');
    const expression = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLElement && el.isContentEditable)) return { ok: false, error: 'Editable element not found' }; el.focus(); if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; if (setter) setter.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)}; } else { el.textContent = ${JSON.stringify(text)}; } el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} })); el.dispatchEvent(new Event('change', { bubbles: true })); if (${JSON.stringify(submit)}) { const form = el.closest('form'); if (form instanceof HTMLFormElement) form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); } return { ok: true }; })()`;
    const response = (await this.evaluateInFrame(state, resolved.frame, expression)).response;
    const value = resultValue<{ ok: boolean; error?: string }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Typing failed.');
    return ok(`Entered ${text.length} characters into ${this.targetDescription(resolved)}${submit ? ' and submitted the form' : ''}.`);
  }

  private async press(state: BrowserState, target: BrowserElementTarget, key: string): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = target.selector || target.ref ? await this.resolveElementTarget(state, target) : undefined;
    if (resolved) {
      const expression = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof HTMLElement)) return { ok: false, error: 'Focusable element not found' }; el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus(); return { ok: document.activeElement === el }; })()`;
      const response = (await this.evaluateInFrame(state, resolved.frame, expression)).response;
      const value = resultValue<{ ok: boolean; error?: string }>(response);
      if (!value?.ok) throw new Error(value?.error ?? `Could not focus ${resolved.label}.`);
    }
    const definition = browserKeyDefinition(key);
    const keyParams = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
      nativeVirtualKeyCode: definition.windowsVirtualKeyCode
    };
    const keyRoute = await this.resolveFrameRoute(state, resolved?.frame ?? target.frame);
    await this.sendCommand(state, 'Input.dispatchKeyEvent', {
      type: 'keyDown', ...keyParams,
      ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {})
    }, COMMAND_TIMEOUT_MS, keyRoute.sessionId);
    await this.sendCommand(state, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams }, COMMAND_TIMEOUT_MS, keyRoute.sessionId);
    return ok(`Pressed ${key}${resolved ? ` on ${this.targetDescription(resolved)}` : ''}.`);
  }

  private async select(state: BrowserState, target: BrowserElementTarget, values: string[]): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser select target was not found.');
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(resolved.selector)});
      if (!(el instanceof HTMLSelectElement)) return { ok: false, error: 'Select element not found' };
      const requested = ${JSON.stringify(values)};
      if (!el.multiple && requested.length > 1) return { ok: false, error: 'The select element does not allow multiple values' };
      const available = new Set(Array.from(el.options).map((option) => option.value));
      const missing = requested.filter((value) => !available.has(value));
      if (missing.length) return { ok: false, error: 'Option values not found: ' + missing.join(', ') };
      const selected = new Set(requested);
      for (const option of el.options) option.selected = selected.has(option.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: Array.from(el.selectedOptions).map((option) => ({ value: option.value, label: option.label })) };
    })()`;
    const response = (await this.evaluateInFrame(state, resolved.frame, expression)).response;
    const value = resultValue<{ ok: boolean; error?: string; selected?: Array<{ value: string; label: string }> }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Select failed.');
    return ok(`Selected options in ${this.targetDescription(resolved)}: ${JSON.stringify(value.selected ?? [])}`);
  }

  private async upload(state: BrowserState, target: BrowserElementTarget, requestedPaths: string[], workingDirectory: string): Promise<ToolResult> {
    this.assertOpenPage(state);
    const files = await resolveBrowserUploadPaths(workingDirectory, requestedPaths);
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser upload target was not found.');
    const elementExpression = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, error: 'File input not found' }; return { ok: true, multiple: el.multiple }; })()`;
    const elementResponse = (await this.evaluateInFrame(state, resolved.frame, elementExpression)).response;
    const element = resultValue<{ ok: boolean; error?: string; multiple?: boolean }>(elementResponse);
    if (!element?.ok) throw new Error(element?.error ?? 'File input not found.');
    if (!element.multiple && files.length > 1) throw new Error('The file input does not allow multiple files.');

    const route = await this.resolveFrameRoute(state, resolved.frame);
    const remote = await this.sendCommand(state, 'Runtime.evaluate', {
      expression: expressionInBrowserFrame(route.localSelectors, `return document.querySelector(${JSON.stringify(resolved.selector)});`),
      returnByValue: false
    }, COMMAND_TIMEOUT_MS, route.sessionId) as { result?: { objectId?: string } };
    const objectId = remote.result?.objectId;
    if (!objectId) throw new Error(`File input not found: ${resolved.selector}`);
    const requested = await this.sendCommand(
      state,
      'DOM.requestNode',
      { objectId },
      COMMAND_TIMEOUT_MS,
      route.sessionId
    ) as { nodeId?: number };
    if (!requested.nodeId) throw new Error(`File input not found: ${resolved.selector}`);
    await this.sendCommand(
      state,
      'DOM.setFileInputFiles',
      { files, nodeId: requested.nodeId },
      COMMAND_TIMEOUT_MS,
      route.sessionId
    );
    return ok(`Uploaded ${files.length} workspace file${files.length === 1 ? '' : 's'} to ${this.targetDescription(resolved)}: ${files.map((file) => path.basename(file)).join(', ')}`);
  }

  private async back(state: BrowserState): Promise<ToolResult> {
    this.assertOpenPage(state);
    const page = this.activePage(state);
    if (page.kind === 'chrome') {
      const history = await this.sendCommand(state, 'Page.getNavigationHistory') as {
        currentIndex?: number; entries?: Array<{ id: number }>;
      };
      const previous = history.entries?.[(history.currentIndex ?? 0) - 1];
      if (!previous) throw new Error('The controlled browser has no previous history entry.');
      await page.chrome!.client!.send('Page.navigateToHistoryEntry', { entryId: previous.id });
      await this.waitForChromeLoad(page);
    } else {
      const contents = this.electronContents(page);
      if (!contents) throw new Error('The controlled browser has no open page.');
      if (!contents.navigationHistory.canGoBack()) throw new Error('The controlled browser has no previous history entry.');
      await this.navigateAndWait(page, () => contents.navigationHistory.goBack());
    }
    return ok(`Navigated page ${page.id} back to ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}`);
  }

  private async reload(state: BrowserState): Promise<ToolResult> {
    this.assertOpenPage(state);
    const page = this.activePage(state);
    if (page.kind === 'chrome') {
      await page.chrome!.client!.send('Page.reload');
      await this.waitForChromeLoad(page);
    }
    else {
      const contents = this.electronContents(page);
      if (!contents) throw new Error('The controlled browser has no open page.');
      await this.navigateAndWait(page, () => contents.reload());
    }
    return ok(`Reloaded page ${page.id}: ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}`);
  }

  private async screenshot(state: BrowserState, fullPage: boolean): Promise<ToolResult> {
    this.assertOpenPage(state);
    let clip: Record<string, number> | undefined;
    if (fullPage) {
      const metrics = await this.sendCommand(state, 'Page.getLayoutMetrics') as { cssContentSize?: { width?: number; height?: number } };
      const width = Math.min(4_096, Math.max(1, Math.ceil(metrics.cssContentSize?.width ?? 1280)));
      const height = Math.min(4_096, Math.max(1, Math.ceil(metrics.cssContentSize?.height ?? 720)));
      clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const response = await this.sendCommand(state, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 82, fromSurface: true, captureBeyondViewport: fullPage, ...(clip ? { clip } : {})
    }) as { data?: string };
    if (!response.data) throw new Error('The browser returned an empty screenshot.');
    if (response.data.length > 14_000_000) throw new Error('The browser screenshot is too large; capture the viewport or a smaller page.');
    const page = this.activePage(state);
    return ok(`Screenshot captured for page ${page.id}: ${this.pageUrl(page)}`, [{
      type: 'image', data: response.data, mimeType: 'image/jpeg', altText: `Screenshot of ${this.pageTitle(page)}`
    }]);
  }

  private async download(
    state: BrowserState,
    value: string,
    filename: string | undefined,
    approved: boolean,
    allowedDomains: Set<string>
  ): Promise<ToolResult> {
    const url = assertBrowserUrl(value);
    if (!isAllowedBrowserUrl(url.toString(), allowedDomains) && !approved) throw new Error(`Domain is not allowed: ${url.hostname}`);
    state.grantedDomains.add(normalizeDomain(url.hostname));
    state.requestedFilename = filename;
    state.downloadPermitUntil = Date.now() + 10_000;
    if (this.activePage(state).kind === 'chrome') {
      throw new Error('browser_download is not available in Chrome attach mode. Use Sandbox Browser, or download the file from Chrome itself.');
    }
    const contents = this.electronContents(this.activePage(state));
    if (!contents) throw new Error('The controlled browser has no open page.');
    contents.downloadURL(url.toString());
    return ok(`Download requested: ${url.toString()}\nUse browser_downloads to inspect its status and local path.`);
  }

  private async trackDownload(sessionId: string, state: BrowserState, item: DownloadItem): Promise<void> {
    const id = crypto.randomUUID();
    const permitted = Date.now() <= state.downloadPermitUntil && isAllowedBrowserUrl(item.getURL(), state.grantedDomains);
    state.downloadPermitUntil = 0;
    if (!permitted) {
      state.requestedFilename = undefined;
      item.cancel();
      state.downloads.set(id, {
        id, url: item.getURL(), filename: safeDownloadFilename(item.getFilename()), path: '', state: 'cancelled',
        receivedBytes: 0, totalBytes: item.getTotalBytes()
      });
      return;
    }
    const filename = safeDownloadFilename(state.requestedFilename ?? item.getFilename());
    state.requestedFilename = undefined;
    const directoryName = /^[a-z0-9-]{1,100}$/iu.test(sessionId)
      ? sessionId
      : createHash('sha256').update(sessionId).digest('hex');
    const directory = path.join(this.dataDirectory, 'browser-downloads', directoryName);
    await mkdir(directory, { recursive: true });
    const savePath = path.join(directory, `${Date.now()}-${filename}`);
    const record: DownloadRecord = {
      id, url: item.getURL(), filename, path: savePath, state: 'progressing', receivedBytes: 0, totalBytes: item.getTotalBytes()
    };
    state.downloads.set(id, record);
    item.setSavePath(savePath);
    item.on('updated', () => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      if (item.isPaused()) record.state = 'progressing';
    });
    item.once('done', (_event, status) => {
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.state = status;
    });
  }

  private assertOpenPage(state: BrowserState): void {
    const url = this.pageUrl(this.activePage(state));
    if (!url || url === 'about:blank') throw new Error('Open a web page before using this browser action.');
  }

  private sendCommand(
    state: BrowserState,
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = COMMAND_TIMEOUT_MS,
    sessionId?: string
  ): Promise<unknown> {
    const page = this.activePage(state);
    if (page.kind === 'chrome') {
      if (!page.chrome?.client) return Promise.reject(new Error('Select this Chrome tab with browser_select_page before using page actions.'));
      return page.chrome.client.send(method, params, timeoutMs, sessionId);
    }
    const contents = this.electronContents(page);
    if (!contents) return Promise.reject(new Error('The controlled browser has no open page.'));
    return this.withTimeout(contents.debugger.sendCommand(method, params, sessionId), undefined, timeoutMs);
  }

  private async resolveFrameRoute(state: BrowserState, frame: BrowserFramePath | undefined): Promise<BrowserFrameRoute> {
    const page = this.activePage(state);
    const sessions = page.chrome?.frameSessions.values() ?? [];
    return resolveBrowserFrameRoute(frame, sessions, async (sessionId, expression) => {
      const response = await this.sendCommand(state, 'Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, COMMAND_TIMEOUT_MS, sessionId);
      return resultValue<unknown>(response);
    });
  }

  private async evaluateInFrame(
    state: BrowserState,
    frame: BrowserFramePath | undefined,
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean; timeoutMs?: number } = {}
  ): Promise<{ response: unknown; route: BrowserFrameRoute }> {
    const route = await this.resolveFrameRoute(state, frame);
    const response = await this.sendCommand(state, 'Runtime.evaluate', {
      expression: expressionInBrowserFrame(route.localSelectors, `return (${expression});`),
      returnByValue: options.returnByValue ?? true,
      awaitPromise: options.awaitPromise ?? true
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS, route.sessionId);
    return { response, route };
  }

  private navigateAndWait(page: BrowserPageState, navigate: () => void): Promise<void> {
    const webContents = this.electronContents(page);
    if (page.kind === 'chrome' || !webContents) return Promise.reject(new Error('Chrome navigation should use Page.navigate.'));
    page.blockedNavigation = undefined;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        webContents.removeListener('did-finish-load', finish);
        webContents.removeListener('did-fail-load', fail);
        clearTimeout(timeout);
        clearInterval(blockedPoll);
      };
      const finish = () => { cleanup(); resolve(); };
      const fail = (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        cleanup();
        reject(new Error(`Navigation failed for ${validatedURL}: ${errorDescription} (${errorCode})${this.diagnosticHint(page)}`));
      };
      webContents.once('did-finish-load', finish);
      webContents.on('did-fail-load', fail);
      const blockedPoll = setInterval(() => {
        if (!page.blockedNavigation) return;
        const blocked = page.blockedNavigation;
        page.blockedNavigation = undefined;
        cleanup();
        reject(new Error(`Navigation to ${blocked} was blocked because its domain is not allowed.`));
      }, 25);
      const timeout = setTimeout(() => {
        cleanup();
        webContents.stop();
        reject(new Error('Browser navigation timed out.'));
      }, COMMAND_TIMEOUT_MS);
      try { navigate(); }
      catch (error) { cleanup(); reject(error); }
    });
  }

  private async withTimeout<T>(promise: Promise<T>, onTimeout?: () => void, timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            onTimeout?.();
            reject(new Error('Browser action timed out.'));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

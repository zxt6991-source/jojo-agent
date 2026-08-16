import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WebContentsView, type BrowserWindow, type DownloadItem, type Session, type WebContents } from 'electron';
import { BrowserActionSchema, BrowserRecordingStepSchema, type BrowserAction, type BrowserDockState, type BrowserRecordingDocument, type BrowserRecordingStep, type BrowserSettings, type ToolResult } from '@desktop-agent/contracts';
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
import { BrowserRecordingStore, stringifyBrowserRecording } from './browser-recording-store';
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
  openChromeTarget,
  probeChromeCdp
} from './browser-backends/chrome-cdp-client';

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
    steps: BrowserRecordingStep[];
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
  };
  url: string;
  title: string;
  destroyed: boolean;
  blockedNavigation: string | undefined;
  elementRefs: Map<string, BrowserElementFingerprint>;
  console: BrowserConsoleRecord[];
  network: BrowserNetworkRecord[];
  errors: BrowserPageErrorRecord[];
};

type BrowserElementTarget = { selector?: string | undefined; ref?: string | undefined; fingerprint?: BrowserElementFingerprint };
type ResolvedElementTarget = { selector: string; label: string; relocated: boolean };
type BrowserDomNode = Omit<BrowserElementFingerprint, 'origin'> & { value?: string };

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

export class BrowserRuntime {
  private readonly states = new Map<string, BrowserState>();
  private readonly recordingStore: BrowserRecordingStore;
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
    }
  ) {
    this.recordingStore = new BrowserRecordingStore(path.join(dataDirectory, 'browser-recordings'));
  }

  async execute(
    sessionId: string,
    rawAction: BrowserAction,
    approved: boolean,
    settings: BrowserSettings,
    workingDirectory: string
  ): Promise<ToolResult> {
    const action = BrowserActionSchema.parse(rawAction);
    if (requiresBrowserApproval(action) && !approved) {
      throw new Error(`Browser action requires explicit approval: ${action.action}`);
    }
    const state = await this.getState(sessionId, settings, needsBrowserPage(action));
    if (state.mode === 'chrome' && action.action === 'select_page' && !approved) {
      throw new Error('Browser action requires explicit approval: select_page');
    }
    for (const domain of settings.allowedDomains) state.grantedDomains.add(normalizeDomain(domain));
    const allowedDomains = new Set([...settings.allowedDomains, ...state.grantedDomains].map(normalizeDomain));
    try {
      return await this.executeAction(sessionId, state, action, approved, allowedDomains, workingDirectory, true);
    } finally {
      this.presentSession(sessionId);
    }
  }

  private async executeAction(
    sessionId: string,
    state: BrowserState,
    action: BrowserAction,
    approved: boolean,
    allowedDomains: Set<string>,
    workingDirectory: string,
    record: boolean
  ): Promise<ToolResult> {
    let result: ToolResult;
    if (action.action === 'open') result = await this.open(state, action.url, approved, allowedDomains);
    else if (action.action === 'new_page') result = await this.newPage(sessionId, state, action.url, approved, allowedDomains);
    else if (action.action === 'pages') result = await this.pages(state);
    else if (action.action === 'select_page') result = await this.selectPage(state, action.pageId);
    else if (action.action === 'close_page') result = this.closePage(sessionId, state, action.pageId);
    else if (action.action === 'record_start') result = this.startRecording(state, action.name);
    else if (action.action === 'record_stop') result = await this.stopRecording(state);
    else if (action.action === 'record_cancel') result = this.cancelRecording(state);
    else if (action.action === 'recordings') result = await this.listRecordings(state);
    else if (action.action === 'record_get') result = await this.getRecording(action.recordingId);
    else if (action.action === 'record_delete') result = await this.deleteRecording(action.recordingId);
    else if (action.action === 'replay') {
      return this.replay(sessionId, state, action.recordingId, action.params, action.maxRetries, action.retryDelayMs, allowedDomains, workingDirectory);
    } else if (action.action === 'read') result = await this.read(state, action.maxNodes);
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
      errors: []
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
    await probeChromeCdp(settings.chromeDebugPort);
    if (settings.chromeNewTab) {
      const target = await openChromeTarget(settings.chromeDebugPort);
      await this.attachChromeTarget(sessionId, state, target, true);
      return;
    }
    const pages = (await listChromeTargets(settings.chromeDebugPort)).filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    const target = pages[0];
    if (!target) throw new Error('Chrome has no open tabs. Enable chromeNewTab or open a tab in Chrome.');
    await this.attachChromeTarget(sessionId, state, target, false);
  }

  private async attachChromeTarget(
    _sessionId: string,
    state: BrowserState,
    target: { id: string; title: string; url: string; webSocketDebuggerUrl?: string },
    owned: boolean
  ): Promise<BrowserPageState> {
    const page = this.registerChromePage(state, target, owned, true);
    await this.connectChromeClient(page);
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
        ...(target.webSocketDebuggerUrl ? { webSocketDebuggerUrl: target.webSocketDebuggerUrl } : {})
      },
      url: target.url || 'about:blank',
      title: target.title || '',
      destroyed: false,
      blockedNavigation: undefined,
      elementRefs: new Map(),
      console: [],
      network: [],
      errors: []
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

  private async connectChromeClient(page: BrowserPageState): Promise<void> {
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
    this.wireChromeClient(page, client);
    await client.send('Page.enable').catch(() => undefined);
    await client.send('Runtime.enable').catch(() => undefined);
    this.enablePageDiagnostics(page);
  }

  private wireChromeClient(page: BrowserPageState, client: ChromeCdpClient): void {
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
    client.on('Network.requestWillBeSent', (params) => {
      const request = params.request as { method?: string; url?: string } | undefined;
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(params.requestId ?? ''),
        method: request?.method ?? 'GET',
        url: request?.url ?? '',
        resourceType: String(params.type ?? 'other'),
        pending: true
      }));
    });
    client.on('Network.loadingFinished', (params) => {
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(params.requestId ?? ''),
        method: 'GET',
        url: page.url,
        pending: false
      }));
    });
    client.on('Network.loadingFailed', (params) => {
      upsertBrowserNetworkRecord(page.network, createBrowserNetworkRecord({
        id: String(params.requestId ?? ''),
        method: 'GET',
        url: page.url,
        error: String(params.errorText ?? 'net::ERR_FAILED'),
        pending: false
      }));
    });
    client.on('Page.frameNavigated', (params) => {
      const frame = params.frame as { url?: string } | undefined;
      if (frame?.url) page.url = frame.url;
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
    if (page.kind === 'chrome' && page.chrome && !page.chrome.client) await this.connectChromeClient(page);
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

  private startRecording(state: BrowserState, requestedName: string | undefined): ToolResult {
    if (state.draftRecording) throw new Error('A browser recording is already active.');
    state.draftRecording = {
      name: requestedName ?? 'Workflow',
      createdAt: new Date().toISOString(),
      steps: []
    };
    return ok(`Started browser recording ${state.draftRecording.name}. Successful workflow actions will be saved as YAML when recording stops, including typed text.`);
  }

  private async stopRecording(state: BrowserState): Promise<ToolResult> {
    const draft = state.draftRecording;
    if (!draft) throw new Error('There is no active browser recording.');
    state.draftRecording = undefined;
    const id = await this.recordingStore.allocateId(draft.name);
    const document = await this.recordingStore.save({
      version: 1,
      id,
      name: draft.name,
      createdAt: draft.createdAt,
      params: listedRecordingParams(draft.steps),
      steps: draft.steps
    });
    return ok(`Saved browser recording ${document.id}: ${document.name} (${document.steps.length} steps) to userData/browser-recordings/${document.id}.yaml.`);
  }

  private cancelRecording(state: BrowserState): ToolResult {
    const draft = state.draftRecording;
    if (!draft) throw new Error('There is no active browser recording.');
    state.draftRecording = undefined;
    return ok(`Cancelled browser recording ${draft.name} without saving (${draft.steps.length} steps discarded).`);
  }

  private async listRecordings(state: BrowserState): Promise<ToolResult> {
    const stored = await this.recordingStore.list();
    const items = stored.map((recording) => ({
      id: recording.id,
      name: recording.name,
      createdAt: recording.createdAt,
      updatedAt: recording.updatedAt,
      persisted: true,
      active: false,
      stepCount: recording.steps.length,
      params: recording.params.map((param) => param.secret ? { name: param.name, secret: true } : { name: param.name, type: param.type }),
      steps: recording.steps.map((step, index) => `${index + 1}. ${this.describeRecordedStep(step)}`)
    }));
    if (state.draftRecording) {
      items.unshift({
        id: 'draft',
        name: state.draftRecording.name,
        createdAt: state.draftRecording.createdAt,
        updatedAt: undefined,
        persisted: false,
        active: true,
        stepCount: state.draftRecording.steps.length,
        params: listedRecordingParams(state.draftRecording.steps).map((param) => (
          param.secret ? { name: param.name, secret: true } : { name: param.name, type: param.type }
        )),
        steps: state.draftRecording.steps.map((step, index) => `${index + 1}. ${this.describeRecordedStep(step)}`)
      });
    }
    return ok(JSON.stringify(items, null, 2));
  }

  private async getRecording(recordingId: string): Promise<ToolResult> {
    const document = await this.recordingStore.get(recordingId);
    return ok(stringifyBrowserRecording({
      ...document,
      steps: document.steps.map((step) => step.action === 'type' ? { ...step, text: `[${step.text?.length ?? 0} characters]` } : step)
    }));
  }

  private async deleteRecording(recordingId: string): Promise<ToolResult> {
    await this.recordingStore.delete(recordingId);
    return ok(`Deleted browser recording ${recordingId}.`);
  }

  private recordSuccessfulAction(state: BrowserState, action: BrowserAction): string | undefined {
    const draft = state.draftRecording;
    if (!draft) return undefined;
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
    const raw: Record<string, unknown> = { ...action };
    delete raw.ref;
    if (ref && page) {
      const fingerprint = page.elementRefs.get(ref);
      if (!fingerprint) return undefined;
      raw.selector = fingerprint.selector;
      raw.fingerprint = {
        selector: fingerprint.selector,
        tag: fingerprint.tag,
        ...(fingerprint.role ? { role: fingerprint.role } : {}),
        ...(fingerprint.name ? { name: fingerprint.name } : {}),
        ...(fingerprint.id ? { id: fingerprint.id } : {}),
        ...(fingerprint.testId ? { testId: fingerprint.testId } : {}),
        ...(fingerprint.fieldName ? { fieldName: fingerprint.fieldName } : {}),
        ...(fingerprint.inputType ? { inputType: fingerprint.inputType } : {}),
        ...(fingerprint.placeholder ? { placeholder: fingerprint.placeholder } : {}),
        ...(fingerprint.href ? { href: fingerprint.href } : {})
      };
    }
    const parsed = BrowserRecordingStepSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  private describeRecordedStep(action: BrowserRecordingStep | BrowserAction): string {
    if (action.action === 'open') {
      try { return `open ${new URL(action.url ?? '').hostname}`; } catch { return 'open'; }
    }
    if (action.action === 'wait') return `wait for ${action.selector} to be ${action.state ?? 'visible'}`;
    if (action.action === 'scroll') return action.selector ? `scroll to ${action.selector}` : `scroll by (${action.deltaX ?? 0}, ${action.deltaY ?? 0})`;
    if (action.action === 'click') return `click ${action.selector}`;
    if (action.action === 'hover') return `hover ${action.selector}`;
    if (action.action === 'type') return `type ${action.text?.length ?? 0} characters into ${action.selector}`;
    if (action.action === 'press') return `press ${action.key}${action.selector ? ` on ${action.selector}` : ''}`;
    if (action.action === 'select') return `select ${(action.values?.length ?? 0)} value(s) in ${action.selector}`;
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
    allowedDomains: Set<string>,
    workingDirectory: string
  ): Promise<ToolResult> {
    if (state.draftRecording) throw new Error('Stop the active browser recording before replaying a workflow.');
    const recording = await this.recordingStore.get(recordingId);
    const secrets = await this.resolveRecordingSecrets(sessionId, recording);
    const report = [`Replaying ${recording.id}: ${recording.name} (${recording.steps.length} steps)`];
    for (const [index, step] of recording.steps.entries()) {
      const prepared = applyRecordingParams(step, recording, supplied, secrets);
      const action = await this.recordingStepToAction(state, prepared);
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const result = await this.executeAction(sessionId, state, action, true, allowedDomains, workingDirectory, false);
          if (!result.ok) throw new Error(result.content);
          report.push(`✓ ${index + 1}. ${this.describeRecordedStep(prepared)}${attempt > 1 ? ` (${attempt} attempts)` : ''}`);
          break;
        } catch (error) {
          if (attempt <= maxRetries && isRetryableBrowserStepError(error)) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, retryDelayMs * attempt)));
            continue;
          }
          const detail = error instanceof Error ? error.message : String(error);
          report.push(`✗ ${index + 1}. ${this.describeRecordedStep(prepared)}: ${detail}`);
          return { callId: 'browser', ok: false, content: report.join('\n') };
        }
      }
    }
    report.push('Replay completed.');
    return ok(report.join('\n'));
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

  private async recordingStepToAction(state: BrowserState, step: BrowserRecordingStep): Promise<BrowserAction> {
    const raw: Record<string, unknown> = { ...step };
    delete raw.fingerprint;
    if (step.fingerprint) {
      const fallback = step.selector ?? step.fingerprint.selector ?? '';
      const relocated = await this.relocateRecordedSelector(state, fallback, step.fingerprint);
      if (relocated) raw.selector = relocated;
    }
    return BrowserActionSchema.parse(raw);
  }

  private async relocateRecordedSelector(
    state: BrowserState,
    selector: string,
    fingerprint: NonNullable<BrowserRecordingStep['fingerprint']>
  ): Promise<string> {
    try {
      this.assertOpenPage(state);
    } catch {
      return selector;
    }
    if (selector) {
      const exists = resultValue<{ ok?: boolean }>(await this.sendCommand(state, 'Runtime.evaluate', {
        expression: `({ ok: Boolean(document.querySelector(${JSON.stringify(selector)})) })`,
        returnByValue: true
      }));
      if (exists?.ok) return selector;
    }
    const page = this.activePage(state);
    const origin = new URL(this.pageUrl(page)).origin;
    const match = await this.resolveElementTarget(state, {
      fingerprint: {
        origin,
        selector: fingerprint.selector ?? selector,
        tag: fingerprint.tag,
        ...(fingerprint.role ? { role: fingerprint.role } : {}),
        ...(fingerprint.name ? { name: fingerprint.name } : {}),
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

  private async read(state: BrowserState, maxNodes: number): Promise<ToolResult> {
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
      return Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"],h1,h2,h3,main,article,p'))
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
          href: el instanceof HTMLAnchorElement ? el.href : undefined
        }));
    })()`;
    const domResponse = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const domNodes = resultValue<BrowserDomNode[]>(domResponse) ?? [];
    const origin = new URL(this.pageUrl(page)).origin;
    const referencedNodes = domNodes.map((node) => {
      const ref = `e${state.nextElementRef++}`;
      page.elementRefs.set(ref, {
        origin,
        selector: node.selector,
        tag: node.tag,
        ...(node.role ? { role: node.role } : {}),
        ...(node.name ? { name: node.name } : {}),
        ...(node.id ? { id: node.id } : {}),
        ...(node.testId ? { testId: node.testId } : {}),
        ...(node.fieldName ? { fieldName: node.fieldName } : {}),
        ...(node.inputType ? { inputType: node.inputType } : {}),
        ...(node.placeholder ? { placeholder: node.placeholder } : {}),
        ...(node.href ? { href: node.href } : {})
      });
      return { ref, ...node };
    });
    while (page.elementRefs.size > 4_000) {
      const oldest = page.elementRefs.keys().next().value;
      if (typeof oldest !== 'string') break;
      page.elementRefs.delete(oldest);
    }
    const domTree = referencedNodes.map((node) => JSON.stringify(node)).join('\n');
    if (domTree) return ok(`Page: ${page.id}\nURL: ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}\n\n[DOM structure; prefer ref for actions because it can survive DOM reordering; selector remains supported]\n${domTree}`);
    const axResponse = await this.sendCommand(state, 'Accessibility.getFullAXTree');
    const nodes = (axResponse as { nodes?: AccessibilityNode[] }).nodes ?? [];
    const tree = formatAccessibilityTree(nodes, maxNodes);
    return ok(`Page: ${page.id}\nURL: ${this.pageUrl(page)}\nTitle: ${this.pageTitle(page)}\n\n${tree || '[No accessible page content]'}`);
  }

  private async resolveElementTarget(
    state: BrowserState,
    target: BrowserElementTarget,
    allowMissing = false
  ): Promise<ResolvedElementTarget | undefined> {
    if (target.selector && !target.fingerprint) return { selector: target.selector, label: target.selector, relocated: false };
    const page = this.activePage(state);
    const fingerprint = target.fingerprint ?? (target.ref ? page.elementRefs.get(target.ref) : undefined);
    if (!fingerprint) {
      if (target.selector) return { selector: target.selector, label: target.selector, relocated: false };
      if (allowMissing) return undefined;
      throw new Error(target.ref ? `Unknown or expired browser element ref: ${target.ref}. Run browser_read again.` : 'Browser element target requires selector or ref.');
    }
    const currentOrigin = new URL(this.pageUrl(page)).origin;
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
    const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
      relocated: previousSelector !== match.candidate.selector
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
      const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
      await this.sendCommand(state, 'Runtime.evaluate', { expression: locate, returnByValue: true, awaitPromise: true })
    );
    if (!located?.ok) throw new Error(located?.error ?? 'Hover failed.');
    const x = located.x ?? 0;
    const y = located.y ?? 0;
    await this.sendCommand(state, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
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
      await this.sendCommand(state, 'Runtime.evaluate', { expression: fire, returnByValue: true, awaitPromise: true })
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
    const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const value = resultValue<{ ok: boolean; error?: string }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Typing failed.');
    return ok(`Entered ${text.length} characters into ${this.targetDescription(resolved)}${submit ? ' and submitted the form' : ''}.`);
  }

  private async press(state: BrowserState, target: BrowserElementTarget, key: string): Promise<ToolResult> {
    this.assertOpenPage(state);
    const resolved = target.selector || target.ref ? await this.resolveElementTarget(state, target) : undefined;
    if (resolved) {
      const expression = `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof HTMLElement)) return { ok: false, error: 'Focusable element not found' }; el.scrollIntoView({ block: 'center', inline: 'nearest' }); el.focus(); return { ok: document.activeElement === el }; })()`;
      const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
    await this.sendCommand(state, 'Input.dispatchKeyEvent', {
      type: 'keyDown', ...keyParams,
      ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {})
    });
    await this.sendCommand(state, 'Input.dispatchKeyEvent', { type: 'keyUp', ...keyParams });
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
    const response = await this.sendCommand(state, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const value = resultValue<{ ok: boolean; error?: string; selected?: Array<{ value: string; label: string }> }>(response);
    if (!value?.ok) throw new Error(value?.error ?? 'Select failed.');
    return ok(`Selected options in ${this.targetDescription(resolved)}: ${JSON.stringify(value.selected ?? [])}`);
  }

  private async upload(state: BrowserState, target: BrowserElementTarget, requestedPaths: string[], workingDirectory: string): Promise<ToolResult> {
    this.assertOpenPage(state);
    const files = await resolveBrowserUploadPaths(workingDirectory, requestedPaths);
    const resolved = await this.resolveElementTarget(state, target);
    if (!resolved) throw new Error('Browser upload target was not found.');
    const elementResponse = await this.sendCommand(state, 'Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(resolved.selector)}); if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { ok: false, error: 'File input not found' }; return { ok: true, multiple: el.multiple }; })()`,
      returnByValue: true,
      awaitPromise: true
    });
    const element = resultValue<{ ok: boolean; error?: string; multiple?: boolean }>(elementResponse);
    if (!element?.ok) throw new Error(element?.error ?? 'File input not found.');
    if (!element.multiple && files.length > 1) throw new Error('The file input does not allow multiple files.');

    const documentResponse = await this.sendCommand(state, 'DOM.getDocument', { depth: 1, pierce: true }) as { root?: { nodeId?: number } };
    const rootNodeId = documentResponse.root?.nodeId;
    if (!rootNodeId) throw new Error('Could not inspect the browser document for file upload.');
    const queryResponse = await this.sendCommand(state, 'DOM.querySelector', { nodeId: rootNodeId, selector: resolved.selector }) as { nodeId?: number };
    if (!queryResponse.nodeId) throw new Error(`File input not found: ${resolved.selector}`);
    await this.sendCommand(state, 'DOM.setFileInputFiles', { files, nodeId: queryResponse.nodeId });
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
    timeoutMs = COMMAND_TIMEOUT_MS
  ): Promise<unknown> {
    const page = this.activePage(state);
    if (page.kind === 'chrome') {
      if (!page.chrome?.client) return Promise.reject(new Error('Select this Chrome tab with browser_select_page before using page actions.'));
      return page.chrome.client.send(method, params, timeoutMs);
    }
    const contents = this.electronContents(page);
    if (!contents) return Promise.reject(new Error('The controlled browser has no open page.'));
    return this.withTimeout(contents.debugger.sendCommand(method, params), undefined, timeoutMs);
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

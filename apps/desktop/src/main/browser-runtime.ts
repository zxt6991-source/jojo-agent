import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, type DownloadItem, type Session } from 'electron';
import { BrowserActionSchema, type BrowserAction, type ToolResult } from '@desktop-agent/contracts';
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
  partition: string;
  pages: Map<number, BrowserPageState>;
  activePageId: number;
  grantedDomains: Set<string>;
  downloads: Map<string, DownloadRecord>;
  lastBlockedPopup: string | undefined;
  requestedFilename: string | undefined;
  downloadPermitUntil: number;
  nextElementRef: number;
  recordings: Map<string, BrowserRecording>;
  activeRecordingId: string | undefined;
  nextRecordingId: number;
  networkObserved: boolean;
};

type BrowserPageState = {
  window: BrowserWindow;
  blockedNavigation: string | undefined;
  elementRefs: Map<string, BrowserElementFingerprint>;
  console: BrowserConsoleRecord[];
  network: BrowserNetworkRecord[];
  errors: BrowserPageErrorRecord[];
};

type BrowserElementTarget = { selector?: string | undefined; ref?: string | undefined };
type ResolvedElementTarget = { selector: string; label: string; relocated: boolean };
type BrowserDomNode = Omit<BrowserElementFingerprint, 'origin'> & { value?: string };
type BrowserRecording = {
  id: string;
  name: string;
  createdAt: string;
  steps: BrowserAction[];
};

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_RECORDING_STEPS = 100;
const APPROVAL_REQUIRED_ACTIONS = new Set<BrowserAction['action']>(['close_page', 'record_start', 'replay', 'click', 'type', 'press', 'select', 'upload', 'download']);
const RECORDABLE_ACTIONS = new Set<BrowserAction['action']>(['open', 'wait', 'scroll', 'click', 'type', 'press', 'select', 'back', 'reload']);

function ok(content: string, contentBlocks?: ToolResult['contentBlocks']): ToolResult {
  return { callId: 'browser', ok: true, content, ...(contentBlocks ? { contentBlocks } : {}) };
}

function resultValue<T>(response: unknown): T {
  return (response as { result?: { value?: T } }).result?.value as T;
}

export class BrowserRuntime {
  private readonly states = new Map<string, BrowserState>();

  constructor(private readonly dataDirectory: string) {}

  async execute(
    sessionId: string,
    rawAction: BrowserAction,
    approved: boolean,
    configuredDomains: string[],
    workingDirectory: string
  ): Promise<ToolResult> {
    const action = BrowserActionSchema.parse(rawAction);
    if (APPROVAL_REQUIRED_ACTIONS.has(action.action) && !approved) {
      throw new Error(`Browser action requires explicit approval: ${action.action}`);
    }
    const state = await this.getState(sessionId);
    for (const domain of configuredDomains) state.grantedDomains.add(normalizeDomain(domain));
    const allowedDomains = new Set([...configuredDomains, ...state.grantedDomains].map(normalizeDomain));
    return this.executeAction(sessionId, state, action, approved, allowedDomains, workingDirectory, true);
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
    else if (action.action === 'pages') result = this.pages(state);
    else if (action.action === 'select_page') result = this.selectPage(state, action.pageId);
    else if (action.action === 'close_page') result = this.closePage(sessionId, state, action.pageId);
    else if (action.action === 'record_start') result = this.startRecording(state, action.name);
    else if (action.action === 'record_stop') result = this.stopRecording(state);
    else if (action.action === 'recordings') result = this.listRecordings(state);
    else if (action.action === 'replay') {
      return this.replay(sessionId, state, action.recordingId, action.maxRetries, action.retryDelayMs, allowedDomains, workingDirectory);
    } else if (action.action === 'read') result = await this.read(state, action.maxNodes);
    else if (action.action === 'wait') result = await this.wait(state, action, action.state, action.timeoutMs);
    else if (action.action === 'scroll') result = await this.scroll(state, action, action.deltaX, action.deltaY);
    else if (action.action === 'click') result = await this.click(state, action);
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
    else {
      const exhaustive: never = action;
      throw new Error(`Unsupported browser action: ${(exhaustive as BrowserAction).action}`);
    }
    if (!record || !RECORDABLE_ACTIONS.has(action.action)) return result;
    const recordingNotice = this.recordSuccessfulAction(state, action);
    return recordingNotice ? { ...result, content: `${result.content}\n${recordingNotice}` } : result;
  }

  close(): void {
    for (const state of this.states.values()) {
      for (const page of state.pages.values()) {
        if (!page.window.isDestroyed()) page.window.destroy();
      }
    }
    this.states.clear();
  }

  private async getState(sessionId: string): Promise<BrowserState> {
    const existing = this.states.get(sessionId);
    if (existing) {
      if (existing.pages.size === 0) this.registerPage(sessionId, existing, this.createPageWindow(existing.partition));
      return existing;
    }
    const partitionHash = createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
    const partition = `browser-${partitionHash}`;
    const state: BrowserState = {
      partition, pages: new Map(), activePageId: 0, grantedDomains: new Set(), downloads: new Map(),
      lastBlockedPopup: undefined, requestedFilename: undefined, downloadPermitUntil: 0, nextElementRef: 1,
      recordings: new Map(), activeRecordingId: undefined, nextRecordingId: 1, networkObserved: false
    };
    this.states.set(sessionId, state);
    const browserWindow = this.createPageWindow(partition);
    this.observeSessionNetwork(state, browserWindow.webContents.session);
    this.registerPage(sessionId, state, browserWindow);
    browserWindow.webContents.session.on('will-download', (_event, item) => {
      void this.trackDownload(sessionId, state, item);
    });
    return state;
  }

  private createPageWindow(partition: string): BrowserWindow {
    return new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 640,
      minHeight: 480,
      title: 'Desktop Agent · 受控浏览器',
      show: false,
      backgroundColor: '#f5f5f5',
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
  }

  private registerPage(sessionId: string, state: BrowserState, browserWindow: BrowserWindow): BrowserPageState {
    const page: BrowserPageState = {
      window: browserWindow,
      blockedNavigation: undefined,
      elementRefs: new Map(),
      console: [],
      network: [],
      errors: []
    };
    const pageId = browserWindow.webContents.id;
    state.pages.set(pageId, page);
    state.activePageId = pageId;
    browserWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedBrowserUrl(url, state.grantedDomains)) {
        state.lastBlockedPopup = url;
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: () => {
          const child = this.createPageWindow(state.partition);
          this.registerPage(sessionId, state, child);
          child.webContents.once('did-finish-load', () => {
            if (!child.isDestroyed()) child.show();
          });
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
    browserWindow.webContents.on('will-navigate', blockUntrustedNavigation);
    browserWindow.webContents.on('will-redirect', blockUntrustedNavigation);
    browserWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    browserWindow.on('closed', () => this.removePage(sessionId, state, pageId));
    browserWindow.webContents.on('render-process-gone', () => {
      if (!browserWindow.isDestroyed()) browserWindow.destroy();
    });
    browserWindow.webContents.debugger.attach('1.3');
    this.observePageDiagnostics(page);
    this.enablePageDiagnostics(page);
    return page;
  }

  private observeSessionNetwork(state: BrowserState, session: Session): void {
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
  }

  private observePageDiagnostics(page: BrowserPageState): void {
    const webContents = page.window.webContents;
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
    webContents.on('did-finish-load', () => this.enablePageDiagnostics(page));
    webContents.debugger.on('message', (_event, method, params) => {
      if (page.window.isDestroyed()) return;
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
    if (page.window.isDestroyed()) return;
    const dbg = page.window.webContents.debugger;
    if (!dbg.isAttached()) return;
    void dbg.sendCommand('Runtime.enable').catch(() => undefined);
    void dbg.sendCommand('Log.enable').catch(() => undefined);
  }

  private pageByWebContentsId(state: BrowserState, webContentsId: number | undefined): BrowserPageState | undefined {
    if (!webContentsId) return undefined;
    const page = state.pages.get(webContentsId);
    return page && !page.window.isDestroyed() ? page : undefined;
  }

  private diagnosticPage(page: BrowserPageState) {
    return {
      pageId: page.window.webContents.id,
      url: page.window.webContents.getURL(),
      title: page.window.webContents.getTitle()
    };
  }

  private diagnosticHint(page: BrowserPageState): string {
    return recentBrowserErrorHint(page.errors);
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
    if (selected && !selected.window.isDestroyed()) return selected;
    for (const [pageId, page] of state.pages) {
      if (page.window.isDestroyed()) continue;
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
    const wasBlank = !page.window.webContents.getURL() || page.window.webContents.getURL() === 'about:blank';
    if (wasBlank) page.window.hide();
    try {
      await this.withTimeout(
        page.window.loadURL(url.toString()),
        () => page.window.webContents.stop()
      );
    } catch (error) {
      if (wasBlank && !page.window.isDestroyed()) page.window.hide();
      const blockedNavigation = page.blockedNavigation;
      page.blockedNavigation = undefined;
      if (blockedNavigation) {
        throw new Error(`Navigation to ${blockedNavigation} was blocked because its domain is not allowed.`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to open ${url.toString()}: ${detail}${this.diagnosticHint(page)}`);
    }
    page.blockedNavigation = undefined;
    page.window.show();
    page.window.focus();
    return ok(`Opened page ${page.window.webContents.id}: ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}`);
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
    const page = this.registerPage(sessionId, state, this.createPageWindow(state.partition));
    try {
      return await this.open(state, url.toString(), approved, allowedDomains);
    } catch (error) {
      const pageId = page.window.webContents.id;
      this.removePage(sessionId, state, pageId);
      if (!page.window.isDestroyed()) page.window.destroy();
      if (state.pages.has(previousPageId)) state.activePageId = previousPageId;
      throw error;
    }
  }

  private pages(state: BrowserState): ToolResult {
    const pages = [...state.pages.entries()].flatMap(([pageId, page]) => page.window.isDestroyed() ? [] : [{
      pageId,
      active: pageId === state.activePageId,
      visible: page.window.isVisible(),
      url: page.window.webContents.getURL(),
      title: page.window.webContents.getTitle()
    }]);
    return ok(JSON.stringify(pages, null, 2));
  }

  private selectPage(state: BrowserState, pageId: number): ToolResult {
    const page = state.pages.get(pageId);
    if (!page || page.window.isDestroyed()) throw new Error(`Browser page does not exist: ${pageId}`);
    state.activePageId = pageId;
    page.window.show();
    page.window.focus();
    return ok(`Selected page ${pageId}: ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}`);
  }

  private closePage(sessionId: string, state: BrowserState, pageId: number): ToolResult {
    const page = state.pages.get(pageId);
    if (!page || page.window.isDestroyed()) throw new Error(`Browser page does not exist: ${pageId}`);
    const description = `${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}`;
    this.removePage(sessionId, state, pageId);
    page.window.destroy();
    if (state.pages.size > 0) {
      const active = this.activePage(state);
      active.window.show();
      active.window.focus();
    }
    return ok(`Closed page ${pageId}: ${description}`);
  }

  private startRecording(state: BrowserState, requestedName: string | undefined): ToolResult {
    if (state.activeRecordingId) throw new Error(`Browser recording ${state.activeRecordingId} is already active.`);
    const id = `r${state.nextRecordingId++}`;
    const recording: BrowserRecording = {
      id,
      name: requestedName ?? `Workflow ${id}`,
      createdAt: new Date().toISOString(),
      steps: []
    };
    state.recordings.set(id, recording);
    state.activeRecordingId = id;
    return ok(`Started in-memory browser recording ${id}: ${recording.name}. Successful workflow actions will be captured, including typed text.`);
  }

  private stopRecording(state: BrowserState): ToolResult {
    const recordingId = state.activeRecordingId;
    if (!recordingId) throw new Error('There is no active browser recording.');
    const recording = state.recordings.get(recordingId);
    state.activeRecordingId = undefined;
    if (!recording) throw new Error(`Browser recording does not exist: ${recordingId}`);
    return ok(`Stopped browser recording ${recording.id}: ${recording.name} (${recording.steps.length} steps).`);
  }

  private listRecordings(state: BrowserState): ToolResult {
    return ok(JSON.stringify([...state.recordings.values()].map((recording) => ({
      id: recording.id,
      name: recording.name,
      createdAt: recording.createdAt,
      active: recording.id === state.activeRecordingId,
      stepCount: recording.steps.length,
      steps: recording.steps.map((action, index) => `${index + 1}. ${this.describeRecordedAction(action)}`)
    })), null, 2));
  }

  private recordSuccessfulAction(state: BrowserState, action: BrowserAction): string | undefined {
    const recordingId = state.activeRecordingId;
    if (!recordingId) return undefined;
    const recording = state.recordings.get(recordingId);
    if (!recording) {
      state.activeRecordingId = undefined;
      return undefined;
    }
    if (recording.steps.length >= MAX_RECORDING_STEPS) {
      state.activeRecordingId = undefined;
      return `Recording ${recording.id} reached the ${MAX_RECORDING_STEPS}-step limit and stopped.`;
    }
    recording.steps.push(BrowserActionSchema.parse(action));
    if (recording.steps.length === MAX_RECORDING_STEPS) {
      state.activeRecordingId = undefined;
      return `Recorded step ${MAX_RECORDING_STEPS}; recording ${recording.id} reached its limit and stopped.`;
    }
    return `Recorded step ${recording.steps.length} in ${recording.id}.`;
  }

  private describeRecordedAction(action: BrowserAction): string {
    if (action.action === 'open') return `open ${new URL(action.url).hostname}`;
    if (action.action === 'wait') return `wait for ${action.ref ?? action.selector} to be ${action.state}`;
    if (action.action === 'scroll') return action.ref || action.selector
      ? `scroll to ${action.ref ?? action.selector}` : `scroll by (${action.deltaX}, ${action.deltaY})`;
    if (action.action === 'click') return `click ${action.ref ?? action.selector}`;
    if (action.action === 'type') return `type ${action.text.length} characters into ${action.ref ?? action.selector}`;
    if (action.action === 'press') return `press ${action.key}${action.ref || action.selector ? ` on ${action.ref ?? action.selector}` : ''}`;
    if (action.action === 'select') return `select ${action.values.length} value${action.values.length === 1 ? '' : 's'} in ${action.ref ?? action.selector}`;
    if (action.action === 'back') return 'navigate back';
    if (action.action === 'reload') return 'reload page';
    return action.action;
  }

  private async replay(
    sessionId: string,
    state: BrowserState,
    recordingId: string,
    maxRetries: number,
    retryDelayMs: number,
    allowedDomains: Set<string>,
    workingDirectory: string
  ): Promise<ToolResult> {
    if (state.activeRecordingId) throw new Error('Stop the active browser recording before replaying a workflow.');
    const recording = state.recordings.get(recordingId);
    if (!recording) throw new Error(`Browser recording does not exist: ${recordingId}`);
    const report = [`Replaying ${recording.id}: ${recording.name} (${recording.steps.length} steps)`];
    for (const [index, action] of recording.steps.entries()) {
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const result = await this.executeAction(sessionId, state, action, true, allowedDomains, workingDirectory, false);
          if (!result.ok) throw new Error(result.content);
          report.push(`✓ ${index + 1}. ${this.describeRecordedAction(action)}${attempt > 1 ? ` (${attempt} attempts)` : ''}`);
          break;
        } catch (error) {
          if (attempt <= maxRetries && isRetryableBrowserStepError(error)) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, retryDelayMs * attempt)));
            continue;
          }
          const detail = error instanceof Error ? error.message : String(error);
          report.push(`✗ ${index + 1}. ${this.describeRecordedAction(action)}: ${detail}`);
          return { callId: 'browser', ok: false, content: report.join('\n') };
        }
      }
    }
    report.push('Replay completed.');
    return ok(report.join('\n'));
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
    const origin = new URL(page.window.webContents.getURL()).origin;
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
    if (domTree) return ok(`Page: ${page.window.webContents.id}\nURL: ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}\n\n[DOM structure; prefer ref for actions because it can survive DOM reordering; selector remains supported]\n${domTree}`);
    const axResponse = await this.sendCommand(state, 'Accessibility.getFullAXTree');
    const nodes = (axResponse as { nodes?: AccessibilityNode[] }).nodes ?? [];
    const tree = formatAccessibilityTree(nodes, maxNodes);
    return ok(`Page: ${page.window.webContents.id}\nURL: ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}\n\n${tree || '[No accessible page content]'}`);
  }

  private async resolveElementTarget(
    state: BrowserState,
    target: BrowserElementTarget,
    allowMissing = false
  ): Promise<ResolvedElementTarget | undefined> {
    if (target.selector) return { selector: target.selector, label: target.selector, relocated: false };
    if (!target.ref) {
      if (allowMissing) return undefined;
      throw new Error('Browser element target requires selector or ref.');
    }
    const page = this.activePage(state);
    const fingerprint = page.elementRefs.get(target.ref);
    if (!fingerprint) throw new Error(`Unknown or expired browser element ref: ${target.ref}. Run browser_read again.`);
    const currentOrigin = new URL(page.window.webContents.getURL()).origin;
    if (currentOrigin !== fingerprint.origin) {
      throw new Error(`Browser element ref ${target.ref} belongs to ${fingerprint.origin}, not ${currentOrigin}. Run browser_read again.`);
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
      throw new Error(`Browser element ref ${target.ref} is ambiguous after the page changed. Run browser_read again.`);
    }
    if (!match.candidate) {
      if (allowMissing) return undefined;
      throw new Error(`Browser element ref ${target.ref} could not be safely relocated. Run browser_read again.`);
    }
    const previousSelector = fingerprint.selector;
    fingerprint.selector = match.candidate.selector;
    return {
      selector: match.candidate.selector,
      label: target.ref,
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
    if (!page.window.webContents.navigationHistory.canGoBack()) throw new Error('The controlled browser has no previous history entry.');
    await this.navigateAndWait(page, () => page.window.webContents.navigationHistory.goBack());
    return ok(`Navigated page ${page.window.webContents.id} back to ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}`);
  }

  private async reload(state: BrowserState): Promise<ToolResult> {
    this.assertOpenPage(state);
    const page = this.activePage(state);
    await this.navigateAndWait(page, () => page.window.webContents.reload());
    return ok(`Reloaded page ${page.window.webContents.id}: ${page.window.webContents.getURL()}\nTitle: ${page.window.webContents.getTitle()}`);
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
    return ok(`Screenshot captured for page ${page.window.webContents.id}: ${page.window.webContents.getURL()}`, [{
      type: 'image', data: response.data, mimeType: 'image/jpeg', altText: `Screenshot of ${page.window.webContents.getTitle()}`
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
    this.activePage(state).window.webContents.downloadURL(url.toString());
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
    const url = this.activePage(state).window.webContents.getURL();
    if (!url || url === 'about:blank') throw new Error('Open a web page before using this browser action.');
  }

  private sendCommand(state: BrowserState, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.withTimeout(this.activePage(state).window.webContents.debugger.sendCommand(method, params));
  }

  private navigateAndWait(page: BrowserPageState, navigate: () => void): Promise<void> {
    page.blockedNavigation = undefined;
    return new Promise((resolve, reject) => {
      const webContents = page.window.webContents;
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

  private async withTimeout<T>(promise: Promise<T>, onTimeout?: () => void): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            onTimeout?.();
            reject(new Error('Browser action timed out.'));
          }, COMMAND_TIMEOUT_MS);
        })
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

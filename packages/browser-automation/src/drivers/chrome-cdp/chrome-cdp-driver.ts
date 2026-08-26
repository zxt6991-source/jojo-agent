import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserFramePath, BrowserTarget, BrowserWaitCondition } from '@desktop-agent/contracts';
import type {
  BrowserDriver,
  BrowserImage,
  BrowserPage,
  BrowserPageInfo,
  BrowserReadOptions,
  BrowserScreenshotOptions,
  BrowserSession,
  BrowserSessionEvent,
  BrowserSessionEventListener,
  BrowserSessionOptions,
  BrowserSnapshot,
  ResolveTargetOptions,
  ResolvedBrowserTarget
} from '../../ports/browser-driver';
import { ChromeCdpClient } from './cdp-client';
import { startChromeRuntime, type ChromeLaunchOptions, type ChromeRuntime } from './chrome-launcher';

export type ChromeCdpDriverOptions = ChromeLaunchOptions & {
  downloadDirectory?: string;
  closeRuntimeOnIdle?: boolean;
};

type CdpTargetInfo = { targetId?: string; type?: string; title?: string; url?: string; parentId?: string };
type FrameSession = { targetId: string; sessionId: string; url: string };

type PageEntry = {
  targetId: string;
  sessionId: string;
  page: ChromeCdpPage;
  frameSessions: Map<string, FrameSession>;
};

export class ChromeCdpDriver implements BrowserDriver {
  private runtime: Promise<ChromeRuntime> | undefined;
  private openSessions = 0;

  constructor(private readonly options: ChromeCdpDriverOptions) {}

  async openSession(options: BrowserSessionOptions, signal: AbortSignal): Promise<BrowserSession> {
    if (signal.aborted) throw signal.reason;
    const runtime = await (this.runtime ??= startChromeRuntime(this.options));
    const client = await ChromeCdpClient.connect(runtime.version.webSocketDebuggerUrl);
    const session = new ChromeCdpSession(client, options, this.options.downloadDirectory, async () => {
      this.openSessions -= 1;
      if (this.openSessions === 0 && this.options.closeRuntimeOnIdle && this.runtime) {
        const owned = await this.runtime;
        this.runtime = undefined;
        await owned.close();
      }
    });
    this.openSessions += 1;
    try {
      await session.initialize(signal);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const runtime = this.runtime ? await this.runtime : undefined;
    this.runtime = undefined;
    await runtime?.close();
  }
}

class ChromeCdpSession implements BrowserSession {
  private readonly pages = new Map<string, PageEntry>();
  private readonly listeners = new Set<BrowserSessionEventListener>();
  private activeTargetId = '';
  private closed = false;
  private downloadDirectory = '';
  private readonly pendingDownloads = new Map<string, { path: string; done: Promise<void>; resolve: () => void }>();

  constructor(
    private readonly client: ChromeCdpClient,
    private readonly options: BrowserSessionOptions,
    configuredDownloadDirectory: string | undefined,
    private readonly onClose: () => Promise<void>
  ) {
    this.downloadDirectory = configuredDownloadDirectory
      ?? path.join(options.workingDirectory ?? process.cwd(), '.jojo', 'browser-downloads', safeName(options.sessionId));
  }

  async initialize(signal: AbortSignal): Promise<void> {
    assertActive(signal);
    await mkdir(this.downloadDirectory, { recursive: true });
    await this.client.send('Target.setDiscoverTargets', { discover: true });
    await this.client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: this.downloadDirectory,
      eventsEnabled: true
    });
    this.client.on('Target.targetCreated', () => { void this.refreshFrames(); });
    this.client.on('Target.targetInfoChanged', () => { void this.refreshFrames(); });
    this.client.on('Browser.downloadWillBegin', (params) => {
      const guid = String(params.guid ?? '');
      const filename = safeName(String(params.suggestedFilename ?? 'download'));
      let resolve: () => void = () => undefined;
      const done = new Promise<void>((finish) => { resolve = finish; });
      this.pendingDownloads.set(guid, { path: path.join(this.downloadDirectory, filename), done, resolve });
    });
    this.client.on('Browser.downloadProgress', (params) => {
      const record = this.pendingDownloads.get(String(params.guid ?? ''));
      if (!record) return;
      if (typeof params.filePath === 'string' && params.filePath) record.path = params.filePath;
      if (params.state === 'completed' || params.state === 'canceled') record.resolve();
    });
    await this.newPage('about:blank', signal);
  }

  async listPages(): Promise<BrowserPageInfo[]> {
    return Promise.all([...this.pages.values()].map(async (entry) => ({
      id: entry.targetId,
      url: await entry.page.getUrl(),
      title: await entry.page.getTitle(),
      active: entry.targetId === this.activeTargetId
    })));
  }

  async newPage(url = 'about:blank', signal?: AbortSignal): Promise<BrowserPage> {
    assertActive(signal);
    assertAllowedUrl(url, this.options.allowedDomains);
    const created = await this.client.send('Target.createTarget', { url: 'about:blank' }) as { targetId?: string };
    if (!created.targetId) throw new Error('Chrome did not create a page target.');
    const attached = await this.client.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true
    }) as { sessionId?: string };
    if (!attached.sessionId) throw new Error('Chrome did not attach the page target.');
    await Promise.all([
      this.client.send('Page.enable', undefined, attached.sessionId),
      this.client.send('Runtime.enable', undefined, attached.sessionId),
      this.client.send('Network.enable', undefined, attached.sessionId)
    ]);
    const page = new ChromeCdpPage(this, created.targetId, attached.sessionId);
    this.pages.set(created.targetId, {
      targetId: created.targetId,
      sessionId: attached.sessionId,
      page,
      frameSessions: new Map()
    });
    this.activeTargetId = created.targetId;
    this.emit({ type: 'page_opened', page: { id: created.targetId, url: 'about:blank', title: '', active: true } });
    if (url !== 'about:blank') await page.navigate(url, signal);
    return page;
  }

  async selectPage(pageId: string): Promise<void> {
    if (!this.pages.has(pageId)) throw new Error(`Browser page does not exist: ${pageId}`);
    this.activeTargetId = pageId;
    await this.client.send('Target.activateTarget', { targetId: pageId });
    this.emit({ type: 'page_selected', pageId });
  }

  async closePage(pageId: string): Promise<void> {
    if (!this.pages.delete(pageId)) return;
    await this.client.send('Target.closeTarget', { targetId: pageId });
    if (this.activeTargetId === pageId) this.activeTargetId = this.pages.keys().next().value ?? '';
    this.emit({ type: 'page_closed', pageId });
  }

  async activePage(): Promise<BrowserPage> {
    const entry = this.pages.get(this.activeTargetId);
    if (!entry) throw new Error('Browser session has no active page.');
    return entry.page;
  }

  subscribe(listener: BrowserSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const targetId of [...this.pages.keys()]) {
      await this.client.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
    this.pages.clear();
    this.client.close();
    await this.onClose();
  }

  send(method: string, params: Record<string, unknown> | undefined, sessionId: string): Promise<unknown> {
    return this.client.send(method, params, sessionId);
  }

  waitForPageLoad(sessionId: string, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error('Browser navigation timed out.'));
      }, timeoutMs);
      const off = this.client.on('Page.loadEventFired', (_params, eventSessionId) => {
        if (eventSessionId !== sessionId) return;
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
  }

  allowedDomains(): string[] | undefined { return this.options.allowedDomains; }

  notifyNavigation(pageId: string, url: string): void {
    this.emit({ type: 'navigation', pageId, url });
  }

  async route(targetId: string, frame: BrowserFramePath | undefined): Promise<{ sessionId: string; selectors: string[] }> {
    const entry = this.pages.get(targetId);
    if (!entry) throw new Error('Browser page is closed.');
    if (!frame) return { sessionId: entry.sessionId, selectors: [] };
    const direct = await evaluateValue<boolean>(this.client, entry.sessionId, frameExpression(frame.selectors, 'return true;')).catch(() => false);
    if (direct) return { sessionId: entry.sessionId, selectors: frame.selectors };
    await this.refreshFrames();
    const first = frame.selectors[0]!;
    const ownerUrl = await evaluateValue<string | undefined>(this.client, entry.sessionId, `(() => {
      const owner = document.querySelector(${JSON.stringify(first)});
      return owner && (owner.src || owner.getAttribute('src')) || undefined;
    })()`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await this.refreshFrames();
      const matches = [...entry.frameSessions.values()].filter((candidate) => urlsMatch(candidate.url, ownerUrl));
      if (matches.length === 1) return { sessionId: matches[0]!.sessionId, selectors: frame.selectors.slice(1) };
      if (matches.length > 1) break;
      await delay(50);
    }
    throw new Error(`Unable to resolve frame path: ${frame.selectors.join(' -> ')}`);
  }

  async waitForDownload(previous: Set<string>, timeoutMs = 30_000): Promise<{ path: string }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const next = [...this.pendingDownloads.entries()].find(([guid]) => !previous.has(guid));
      if (next) {
        await Promise.race([
          next[1].done,
          delay(timeoutMs).then(() => { throw new Error('Browser download timed out.'); })
        ]);
        return { path: next[1].path };
      }
      await delay(50);
    }
    throw new Error('Browser download timed out.');
  }

  downloadIds(): Set<string> { return new Set(this.pendingDownloads.keys()); }

  private async refreshFrames(): Promise<void> {
    const response = await this.client.send('Target.getTargets') as { targetInfos?: CdpTargetInfo[] };
    for (const entry of this.pages.values()) {
      const known = new Set([...entry.frameSessions.values()].map((frame) => frame.targetId));
      for (const info of response.targetInfos ?? []) {
        if (info.type !== 'iframe' || info.parentId !== entry.targetId || !info.targetId || known.has(info.targetId)) continue;
        const attached = await this.client.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true
        }).catch(() => undefined) as { sessionId?: string } | undefined;
        if (!attached?.sessionId) continue;
        entry.frameSessions.set(attached.sessionId, {
          targetId: info.targetId,
          sessionId: attached.sessionId,
          url: info.url ?? 'about:blank'
        });
        await Promise.all([
          this.client.send('Page.enable', undefined, attached.sessionId).catch(() => undefined),
          this.client.send('Runtime.enable', undefined, attached.sessionId).catch(() => undefined)
        ]);
      }
    }
  }

  private emit(event: BrowserSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class ChromeCdpPage implements BrowserPage {
  constructor(
    private readonly owner: ChromeCdpSession,
    private readonly targetId: string,
    private readonly sessionId: string
  ) {}

  async navigate(url: string, signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    assertAllowedUrl(url, this.owner.allowedDomains());
    await this.owner.send('Page.navigate', { url }, this.sessionId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      assertActive(signal);
      const state = await evaluateValue<{ url?: string; ready?: string }>(this.ownerClient(), this.sessionId, '({ url: location.href, ready: document.readyState })');
      if (state.url === url && (state.ready === 'interactive' || state.ready === 'complete')) break;
      await abortableDelay(50, signal);
    }
    if (await this.getUrl() !== url) throw new Error(`Browser navigation timed out: ${url}`);
    this.owner.notifyNavigation(this.targetId, url);
  }

  async read(options: BrowserReadOptions = {}, signal?: AbortSignal): Promise<BrowserSnapshot> {
    assertActive(signal);
    const route = await this.owner.route(this.targetId, options.frame);
    const value = await evaluateValue<BrowserSnapshot>(this.ownerClient(), route.sessionId, frameExpression(route.selectors, `
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const nodes = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role],[contenteditable],iframe,frame')).slice(0, ${Math.min(1_000, options.maxNodes ?? 200)});
      return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 50000), elements: nodes.map((el) => ({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined, accessibleName: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 500) || undefined, visible: visible(el) })) };
    `));
    return value;
  }

  async resolveTarget(target: BrowserTarget, options: ResolveTargetOptions = {}, signal?: AbortSignal): Promise<ResolvedBrowserTarget | undefined> {
    assertActive(signal);
    const route = await this.owner.route(this.targetId, target.frame);
    const candidates = [target.selector, target.fingerprint?.primarySelector, ...(target.fingerprint?.alternateSelectors ?? [])]
      .filter((value): value is string => Boolean(value));
    for (const selector of candidates) {
      const exists = await evaluateValue<boolean>(this.ownerClient(), route.sessionId, frameExpression(route.selectors, `return Boolean(document.querySelector(${JSON.stringify(selector)}));`));
      if (exists) return { selector, relocated: selector !== target.selector, ...(target.frame ? { frame: target.frame } : {}) };
    }
    const fingerprint = target.fingerprint;
    if (fingerprint) {
      const selector = await evaluateValue<string | undefined>(this.ownerClient(), route.sessionId, frameExpression(route.selectors, `
        const nodes = Array.from(document.querySelectorAll(${JSON.stringify(fingerprint.tag || '*')}));
        const wanted = ${JSON.stringify((fingerprint.accessibleName ?? '').toLowerCase())};
        const node = nodes.find((el) => !wanted || (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase() === wanted);
        return node ? selectorFor(node) : undefined;
      `));
      if (selector) return { selector, relocated: true, ...(target.frame ? { frame: target.frame } : {}) };
    }
    if (options.allowMissing) return undefined;
    throw new Error(`Browser target was not found: ${target.selector ?? target.fingerprint?.accessibleName ?? 'unknown'}`);
  }

  click(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<void> { return this.elementAction(target, 'el.click();', signal); }
  hover(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<void> { return this.elementAction(target, `el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));`, signal); }
  type(target: ResolvedBrowserTarget, text: string, signal?: AbortSignal): Promise<void> {
    return this.elementAction(target, `el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));`, signal);
  }
  async press(_target: ResolvedBrowserTarget | undefined, key: string, signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    await this.owner.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, this.sessionId);
    await this.owner.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, this.sessionId);
  }
  select(target: ResolvedBrowserTarget, values: string[], signal?: AbortSignal): Promise<void> {
    return this.elementAction(target, `for (const option of el.options || []) option.selected = ${JSON.stringify(values)}.includes(option.value); el.dispatchEvent(new Event('change', { bubbles: true }));`, signal);
  }
  async upload(target: ResolvedBrowserTarget, paths: string[], signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    const route = await this.owner.route(this.targetId, target.frame);
    const remote = await this.owner.send('Runtime.evaluate', {
      expression: frameExpression(route.selectors, `return document.querySelector(${JSON.stringify(target.selector)});`),
      returnByValue: false
    }, route.sessionId) as { result?: { objectId?: string } };
    if (!remote.result?.objectId) throw new Error('Upload target was not found.');
    const node = await this.owner.send('DOM.requestNode', { objectId: remote.result.objectId }, route.sessionId) as { nodeId?: number };
    if (!node.nodeId) throw new Error('Upload target has no DOM node.');
    await this.owner.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: paths }, route.sessionId);
  }
  async download(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<{ path: string }> {
    const before = this.owner.downloadIds();
    await this.click(target, signal);
    return this.owner.waitForDownload(before);
  }
  async extract(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<unknown> {
    assertActive(signal);
    return this.elementValue(target, 'el.value ?? el.textContent ?? el.getAttribute("href")');
  }
  async getValue(target: ResolvedBrowserTarget, signal?: AbortSignal): Promise<string> {
    assertActive(signal);
    return String(await this.elementValue(target, 'el.value ?? el.textContent ?? ""'));
  }
  async scroll(target: ResolvedBrowserTarget | undefined, deltaX: number, deltaY: number, signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    if (target) await this.elementAction(target, `el.scrollBy(${deltaX}, ${deltaY});`, signal);
    else await this.owner.send('Runtime.evaluate', { expression: `scrollBy(${deltaX}, ${deltaY})` }, this.sessionId);
  }
  async back(signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    await this.owner.send('Runtime.evaluate', { expression: 'history.back()' }, this.sessionId);
  }
  async reload(signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    await this.owner.send('Page.reload', undefined, this.sessionId);
  }
  async wait(condition: BrowserWaitCondition, timeoutMs = 15_000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    if (condition.type === 'delay') { await abortableDelay(condition.delayMs, signal); return; }
    let stableSince = 0;
    let previous = '';
    while (Date.now() < deadline) {
      assertActive(signal);
      if (condition.type === 'url' && (await this.getUrl()).includes(condition.contains)) return;
      if (condition.type === 'element_state') {
        const target = await this.resolveTarget(condition.target, { allowMissing: true }, signal);
        const exists = Boolean(target);
        if ((condition.state === 'detached' || condition.state === 'hidden') ? !exists : exists) return;
      }
      if (condition.type === 'network_idle') {
        await abortableDelay(condition.idleMs, signal);
        return;
      }
      if (condition.type === 'dom_stable') {
        const value = await evaluateValue<string>(this.ownerClient(), this.sessionId, 'document.documentElement?.innerHTML.length + ":" + document.body?.innerText.length');
        if (value === previous) {
          stableSince ||= Date.now();
          if (Date.now() - stableSince >= condition.stableMs) return;
        } else {
          previous = value;
          stableSince = 0;
        }
      }
      await abortableDelay(50, signal);
    }
    throw new Error(`Browser wait timed out: ${condition.type}`);
  }
  async screenshot(options: BrowserScreenshotOptions = {}, signal?: AbortSignal): Promise<BrowserImage> {
    assertActive(signal);
    const response = await this.owner.send('Page.captureScreenshot', {
      format: options.format ?? 'png',
      captureBeyondViewport: options.fullPage === true
    }, this.sessionId) as { data?: string };
    if (!response.data) throw new Error('Chrome returned an empty screenshot.');
    return { mimeType: options.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: Buffer.from(response.data, 'base64') };
  }
  getUrl(): Promise<string> { return this.evalString('location.href'); }
  getTitle(): Promise<string> { return this.evalString('document.title'); }

  private async elementAction(target: ResolvedBrowserTarget, body: string, signal?: AbortSignal): Promise<void> {
    assertActive(signal);
    const result = await this.elementValue(target, `${body} return true;`, true);
    if (!result) throw new Error(`Browser target was not found: ${target.selector}`);
  }

  private async elementValue(target: ResolvedBrowserTarget, body: string, statement = false): Promise<unknown> {
    const route = await this.owner.route(this.targetId, target.frame);
    return evaluateValue(this.ownerClient(), route.sessionId, frameExpression(route.selectors, `
      const el = document.querySelector(${JSON.stringify(target.selector)});
      if (!el) return undefined;
      ${statement ? body : `return ${body};`}
    `));
  }

  private async evalString(expression: string): Promise<string> {
    return String(await evaluateValue(this.ownerClient(), this.sessionId, expression) ?? '');
  }

  private ownerClient(): ChromeCdpClient {
    return (this.owner as unknown as { client: ChromeCdpClient }).client;
  }
}

async function evaluateValue<T>(client: ChromeCdpClient, sessionId: string, expression: string): Promise<T> {
  const response = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  }, sessionId) as { result?: { value?: T }; exceptionDetails?: unknown };
  if (response.exceptionDetails) throw new Error('Chrome page evaluation failed.');
  return response.result?.value as T;
}

function frameExpression(selectors: string[], body: string): string {
  return `(() => {
    const selectorFor = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
      const peers = el.parentElement ? Array.from(el.parentElement.children).filter((node) => node.tagName === el.tagName) : [];
      return el.tagName.toLowerCase() + (peers.length > 1 ? ':nth-of-type(' + (peers.indexOf(el) + 1) + ')' : '');
    };
    let currentWindow = window;
    for (const selector of ${JSON.stringify(selectors)}) {
      const owner = currentWindow.document.querySelector(selector);
      if (!owner || !owner.contentWindow) return undefined;
      currentWindow = owner.contentWindow;
    }
    return currentWindow.Function('selectorFor', ${JSON.stringify(body)})(selectorFor);
  })()`;
}

function assertAllowedUrl(value: string, domains: string[] | undefined): void {
  if (value === 'about:blank' || !domains?.length) return;
  const hostname = new URL(value).hostname.toLowerCase();
  if (!domains.some((domain) => hostname === domain.toLowerCase() || hostname.endsWith(`.${domain.toLowerCase()}`))) {
    throw new Error(`Browser navigation domain is not allowed: ${hostname}`);
  }
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Browser operation aborted.');
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timeout); reject(signal.reason); }, { once: true });
  });
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 120) || 'browser'; }
function urlsMatch(left: string, right: string | undefined): boolean {
  if (!right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch { return left === right; }
}

import http from 'node:http';
import { chromeCdpPortFromWebSocketUrl, connectChromeCdpSocket, type ChromeCdpTransport } from './chrome-cdp-socket';

export type ChromeVersionInfo = {
  browser: string;
  protocolVersion?: string;
  webSocketDebuggerUrl: string;
};

export type ChromeTargetInfo = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type ChromeCdpHttp = (
  url: string,
  init?: { method?: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const CDP_HTTP_TIMEOUT_MS = 2_500;

export function chromeCdpUnavailableMessage(_port?: number): string {
  return '无法连接到本机 Chrome。请确认已安装 Google Chrome 后重试。';
}

function chromeCdpErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  return String(err.code ?? err.cause?.code ?? '');
}

function chromeCdpErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : '';
  return `${error.message} ${cause}`.trim();
}

export function mapChromeCdpError(error: unknown, port: number): Error {
  const code = chromeCdpErrorCode(error);
  const text = chromeCdpErrorText(error);
  if (
    code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' || code === 'ECONNRESET'
    || /ECONNREFUSED|fetch failed|other side closed/i.test(text)
  ) {
    return new Error(chromeCdpUnavailableMessage(port));
  }
  if (code === 'ETIMEDOUT' || code === 'ERR_SOCKET_TIMEOUT' || /timed out/i.test(text)) {
    return new Error('连接本机 Chrome 超时，请重试。');
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function rethrowChromeCdpError(error: unknown, port: number): never {
  throw mapChromeCdpError(error, port);
}

const defaultHttp: ChromeCdpHttp = (url, init) => new Promise((resolve, reject) => {
  let target: URL;
  try { target = new URL(url); }
  catch (error) { reject(error); return; }
  const request = http.request({
    protocol: 'http:',
    hostname: target.hostname,
    port: Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: init?.method ?? 'GET',
    family: target.hostname === 'localhost' ? undefined : 4,
    timeout: CDP_HTTP_TIMEOUT_MS,
    headers: { host: target.host, accept: 'application/json' }
  }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const status = response.statusCode ?? 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown
      });
    });
  });
  request.on('timeout', () => {
    request.destroy(Object.assign(new Error('Timed out connecting to Chrome debugger.'), { code: 'ETIMEDOUT' }));
  });
  request.on('error', reject);
  request.end();
});

export function chromeCdpOrigin(port: number, host = '127.0.0.1'): string {
  return `http://${host}:${port}`;
}

async function chromeCdpCall(
  url: string,
  init: { method?: string } | undefined,
  httpGet: ChromeCdpHttp,
  port: number
): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  try {
    return await httpGet(url, init);
  } catch (error) {
    rethrowChromeCdpError(error, port);
  }
}

export async function probeChromeCdp(
  port: number,
  host = '127.0.0.1',
  httpGet: ChromeCdpHttp = defaultHttp
): Promise<ChromeVersionInfo> {
  const response = await chromeCdpCall(`${chromeCdpOrigin(port, host)}/json/version`, undefined, httpGet, port);
  if (!response.ok) throw new Error(`Chrome debug port ${port} returned HTTP ${response.status}.`);
  const payload = await response.json() as ChromeVersionInfo;
  if (!payload?.webSocketDebuggerUrl) {
    throw new Error(chromeCdpUnavailableMessage(port));
  }
  return payload;
}

export async function listChromeTargets(
  port: number,
  host = '127.0.0.1',
  httpGet: ChromeCdpHttp = defaultHttp
): Promise<ChromeTargetInfo[]> {
  const response = await chromeCdpCall(`${chromeCdpOrigin(port, host)}/json/list`, undefined, httpGet, port);
  if (!response.ok) throw new Error(`Chrome debug port ${port} returned HTTP ${response.status}.`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload as ChromeTargetInfo[] : [];
}

export async function openChromeTarget(
  port: number,
  url = 'about:blank',
  host = '127.0.0.1',
  httpGet: ChromeCdpHttp = defaultHttp
): Promise<ChromeTargetInfo> {
  const href = `${chromeCdpOrigin(port, host)}/json/new?${encodeURIComponent(url)}`;
  let response = await chromeCdpCall(href, { method: 'PUT' }, httpGet, port);
  if (!response.ok) response = await chromeCdpCall(href, undefined, httpGet, port);
  if (!response.ok) throw new Error(`Chrome could not open a new tab (HTTP ${response.status}).`);
  return await response.json() as ChromeTargetInfo;
}

export async function closeChromeTarget(
  port: number,
  targetId: string,
  host = '127.0.0.1',
  httpGet: ChromeCdpHttp = defaultHttp
): Promise<void> {
  const response = await chromeCdpCall(
    `${chromeCdpOrigin(port, host)}/json/close/${encodeURIComponent(targetId)}`,
    undefined,
    httpGet,
    port
  );
  if (!response.ok) throw new Error(`Chrome could not close tab ${targetId} (HTTP ${response.status}).`);
}

export class ChromeCdpClient {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>, sessionId?: string) => void>>();
  private readonly disconnectListeners = new Set<() => void>();
  private nextId = 1;
  private closed = false;
  private transport: ChromeCdpTransport | undefined;

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 8_000): Promise<ChromeCdpClient> {
    const port = chromeCdpPortFromWebSocketUrl(webSocketDebuggerUrl);
    const client = new ChromeCdpClient();
    try {
      client.transport = await connectChromeCdpSocket(webSocketDebuggerUrl, {
        onMessage: (data) => client.onMessage(data),
        onClose: () => client.failAll(new Error('Chrome debugger connection closed.')),
        onError: (error) => client.failAll(error)
      }, timeoutMs);
      return client;
    } catch (error) {
      throw mapChromeCdpError(error, port);
    }
  }

  on(method: string, listener: (params: Record<string, unknown>, sessionId?: string) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = 30_000, sessionId?: string): Promise<unknown> {
    if (this.closed || !this.transport) {
      return Promise.reject(new Error('Chrome debugger connection is closed.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      try {
        this.transport!.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('Chrome debugger connection closed.'));
    this.transport?.close();
    this.transport = undefined;
  }

  private onMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string }; sessionId?: string };
    try { message = JSON.parse(raw) as typeof message; }
    catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Chrome CDP command failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    const disconnect = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    for (const listener of disconnect) listener();
  }
}

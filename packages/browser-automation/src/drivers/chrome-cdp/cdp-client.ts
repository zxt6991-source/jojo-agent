import http from 'node:http';

export type CdpEventListener = (params: Record<string, unknown>, sessionId?: string) => void;

export type ChromeCdpVersion = {
  Browser?: string;
  webSocketDebuggerUrl: string;
};

export type ChromeCdpClientOptions = {
  webSocketFactory?: (url: string) => WebSocket;
  timeoutMs?: number;
};

export class ChromeCdpClient {
  private readonly listeners = new Map<string, Set<CdpEventListener>>();
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private closed = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly commandTimeoutMs: number
  ) {
    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('close', () => this.failAll(new Error('Chrome debugger connection closed.')));
    socket.addEventListener('error', () => this.failAll(new Error('Chrome debugger connection failed.')));
  }

  static connect(url: string, options: ChromeCdpClientOptions = {}): Promise<ChromeCdpClient> {
    const factory = options.webSocketFactory ?? ((value) => new WebSocket(value));
    const socket = factory(url);
    const timeoutMs = options.timeoutMs ?? 8_000;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to Chrome debugger.'));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve(new ChromeCdpClient(socket, 30_000));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Chrome debugger connection failed.'));
      }, { once: true });
    });
  }

  on(method: string, listener: CdpEventListener): () => void {
    const listeners = this.listeners.get(method) ?? new Set<CdpEventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Chrome debugger connection is closed.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({
        id,
        method,
        ...(params ? { params } : {}),
        ...(sessionId ? { sessionId } : {})
      }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Chrome debugger connection closed.'));
    this.socket.close();
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string };
    };
    try { message = JSON.parse(raw) as typeof message; }
    catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Chrome CDP command failed.'));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params ?? {}, message.sessionId);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function probeChromeCdp(port: number, host = '127.0.0.1'): Promise<ChromeCdpVersion> {
  return requestChromeJson<ChromeCdpVersion>(port, '/json/version', host).then((version) => {
    if (!version.webSocketDebuggerUrl) throw new Error('Chrome did not expose a debugger websocket.');
    return version;
  });
}

export function requestChromeJson<T>(port: number, pathname: string, host = '127.0.0.1', method = 'GET'): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: pathname, method, timeout: 2_500 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 300) {
          reject(new Error(`Chrome debugger returned HTTP ${response.statusCode ?? 0}.`));
          return;
        }
        try { resolve(JSON.parse(body) as T); }
        catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Chrome debugger request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

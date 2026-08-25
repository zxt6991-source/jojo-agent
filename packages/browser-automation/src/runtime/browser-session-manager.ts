import type { BrowserDriver, BrowserSession, BrowserSessionOptions } from '../ports/browser-driver';

type SessionEntry = { promise: Promise<BrowserSession>; controller: AbortController };

/** Lazily owns browser sessions and guarantees one driver session per Jojo session. */
export class BrowserSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly driver: BrowserDriver) {}

  acquire(options: BrowserSessionOptions, signal?: AbortSignal): Promise<BrowserSession> {
    const current = this.sessions.get(options.sessionId);
    if (current) return current.promise;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const promise = this.driver.openSession(options, controller.signal).catch((error) => {
      this.sessions.delete(options.sessionId);
      throw error;
    }).finally(() => signal?.removeEventListener('abort', onAbort));
    this.sessions.set(options.sessionId, { promise, controller });
    return promise;
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    entry.controller.abort(new Error('Browser session closed.'));
    try { await (await entry.promise).close(); } catch { /* already failed or closed */ }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.close(sessionId)));
  }
}

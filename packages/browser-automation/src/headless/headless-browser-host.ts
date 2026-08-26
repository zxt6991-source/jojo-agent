import type { BrowserSession, BrowserSessionOptions } from '../ports/browser-driver';
import { BrowserSessionManager } from '../runtime/browser-session-manager';
import { ChromeCdpDriver, type ChromeCdpDriverOptions } from '../drivers/chrome-cdp/chrome-cdp-driver';

/**
 * Process-level Browser host for CLI, server and scheduler runtimes.
 * It owns Chrome lazily and keeps Jojo session lifecycle independent from Electron.
 */
export class HeadlessBrowserHost {
  readonly driver: ChromeCdpDriver;
  readonly sessions: BrowserSessionManager;

  constructor(options: ChromeCdpDriverOptions) {
    this.driver = new ChromeCdpDriver({ ...options, headless: options.headless ?? true });
    this.sessions = new BrowserSessionManager(this.driver);
  }

  acquire(options: BrowserSessionOptions, signal?: AbortSignal): Promise<BrowserSession> {
    return this.sessions.acquire(options, signal);
  }

  async run<T>(
    options: BrowserSessionOptions,
    task: (session: BrowserSession, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal
  ): Promise<T> {
    const session = await this.acquire(options, signal);
    try {
      return await task(session, signal);
    } finally {
      await this.sessions.close(options.sessionId);
    }
  }

  async close(): Promise<void> {
    await this.sessions.closeAll();
    await this.driver.close();
  }
}

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowserRecorderCaptureScript, parseBrowserRecorderBindingPayload } from '@desktop-agent/browser-automation';
import {
  ChromeCdpClient,
  openChromeTarget,
  probeChromeCdp
} from '../../desktop/src/main/browser-backends/chrome-cdp-client';
import { resolveChromeExecutable } from '../../desktop/src/main/browser-backends/chrome-launcher';
import {
  expressionInBrowserFrame,
  resolveBrowserFrameRoute,
  type BrowserFrameSession
} from '../../desktop/src/main/browser-frame-routing';
import { startBrowserTestSite, type BrowserTestSite } from './server';

const chromeExecutable = resolveChromeExecutable();
const suite = chromeExecutable ? describe : describe.skip;

suite('iframe and OOPIF Chrome integration', () => {
  let site: BrowserTestSite;
  let chrome: ChildProcess;
  let profile: string;
  let debugPort: number;
  let client: ChromeCdpClient;
  let pageSessionId: string;
  const sessions = new Map<string, BrowserFrameSession>();

  beforeAll(async () => {
    site = await startBrowserTestSite();
    debugPort = await allocatePort();
    profile = await mkdtemp(path.join(os.tmpdir(), 'jojo-oopif-chrome-'));
    chrome = spawn(chromeExecutable!, [
      '--headless=new',
      '--disable-gpu',
      ...(process.env.CI && process.platform === 'linux' ? [
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ] : []),
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--site-per-process',
      '--no-proxy-server',
      '--host-resolver-rules=MAP jojo-top.test 127.0.0.1, MAP jojo-frame.test 127.0.0.1',
      'about:blank'
    ], { stdio: 'ignore' });
    await vi.waitFor(async () => {
      await expect(probeChromeCdp(debugPort)).resolves.toHaveProperty('webSocketDebuggerUrl');
    }, { timeout: 15_000, interval: 100 });
    const target = await openChromeTarget(debugPort);
    const browser = await probeChromeCdp(debugPort);
    client = await ChromeCdpClient.connect(browser.webSocketDebuggerUrl);
    const attached = await client.send('Target.attachToTarget', {
      targetId: target.id,
      flatten: true
    }) as { sessionId?: string };
    if (!attached.sessionId) throw new Error('Chrome did not return a page session.');
    pageSessionId = attached.sessionId;
    client.on('Target.attachedToTarget', (params) => {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const info = params.targetInfo as { targetId?: string; type?: string; url?: string } | undefined;
      if (sessionId && info?.type === 'iframe' && info.targetId) {
        sessions.set(sessionId, {
          sessionId,
          targetId: info.targetId,
          url: info.url ?? 'about:blank'
        });
      }
    });
    client.on('Target.detachedFromTarget', (params) => {
      if (typeof params.sessionId === 'string') sessions.delete(params.sessionId);
    });
    await client.send('Page.enable', undefined, 30_000, pageSessionId);
    await client.send('Runtime.enable', undefined, 30_000, pageSessionId);
    await client.send('Target.setDiscoverTargets', { discover: true });
    await client.send('Page.navigate', { url: `${site.topOrigin}/checkout` }, 30_000, pageSessionId);
    await vi.waitFor(async () => {
      expect(await evaluate(undefined, 'document.querySelectorAll("iframe").length')).toBe(2);
    }, { timeout: 10_000, interval: 100 });
    const attachDiscoveredFrames = async () => {
      const targets = await client.send('Target.getTargets') as {
        targetInfos?: Array<{ targetId?: string; type?: string; url?: string; parentId?: string }>;
      };
      const attachedIds = new Set([...sessions.values()].map((session) => session.targetId));
      for (const info of targets.targetInfos ?? []) {
        if (info.type !== 'iframe' || info.parentId !== target.id || !info.targetId || attachedIds.has(info.targetId)) continue;
        const result = await client.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: true
        }) as { sessionId?: string };
        if (result.sessionId) sessions.set(result.sessionId, {
          sessionId: result.sessionId,
          targetId: info.targetId,
          url: info.url ?? 'about:blank'
        });
      }
    };
    try {
      await vi.waitFor(async () => {
        await attachDiscoveredFrames();
        expect([...sessions.values()].some((session) => session.url.startsWith(site.oopifOrigin))).toBe(true);
      }, { timeout: 10_000, interval: 100 });
    } catch (error) {
      const frameTree = await client.send('Page.getFrameTree', undefined, 30_000, pageSessionId).catch(() => undefined);
      const targets = await client.send('Target.getTargets').catch(() => undefined);
      throw new Error(`OOPIF session was not attached. frameTree=${JSON.stringify(frameTree)} targets=${JSON.stringify(targets)}`, { cause: error });
    }
  }, 25_000);

  afterAll(async () => {
    client?.close();
    if (chrome && chrome.exitCode === null) {
      chrome.kill('SIGTERM');
      await Promise.race([once(chrome, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    await site?.close();
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('routes same-origin iframe DOM work without changing CDP sessions', async () => {
    const route = await resolveBrowserFrameRoute(
      { selectors: ['iframe#profile'] },
      sessions.values(),
      evaluate
    );
    expect(route).toEqual({ localSelectors: ['iframe#profile'] });
    expect(await evaluate(route.sessionId, expressionInBrowserFrame(
      route.localSelectors,
      'return document.querySelector("#save-profile")?.textContent;'
    ))).toBe('Save profile');
  });

  it('routes a cross-site iframe into its flattened OOPIF session', async () => {
    const route = await resolveBrowserFrameRoute(
      { selectors: ['iframe[name="payment"]'] },
      sessions.values(),
      evaluate
    );
    expect(route.sessionId).toBeTruthy();
    expect(route.localSelectors).toEqual([]);
    expect(await evaluate(route.sessionId, 'document.querySelector("#pay")?.textContent')).toBe('Pay now');
  });

  it('captures user-demo interactions inside the OOPIF binding context', async () => {
    const route = await resolveBrowserFrameRoute(
      { selectors: ['iframe[name="payment"]'] },
      sessions.values(),
      evaluate
    );
    const payloads: string[] = [];
    const off = client.on('Runtime.bindingCalled', (params, sessionId) => {
      if (sessionId === route.sessionId && params.name === '__jojoBrowserRecorder' && typeof params.payload === 'string') {
        payloads.push(params.payload);
      }
    });
    try {
      await client.send('Runtime.addBinding', { name: '__jojoBrowserRecorder' }, 30_000, route.sessionId);
      await client.send('Runtime.evaluate', {
        expression: createBrowserRecorderCaptureScript(),
        returnByValue: true
      }, 30_000, route.sessionId);
      await client.send('Runtime.evaluate', {
        expression: 'document.querySelector("#pay").click()',
        returnByValue: true
      }, 30_000, route.sessionId);
      await vi.waitFor(() => expect(payloads.length).toBeGreaterThan(0));
      expect(parseBrowserRecorderBindingPayload(payloads.at(-1)!)).toMatchObject({
        type: 'click', target: { selector: '#pay', fingerprint: { tag: 'button', accessibleName: 'Pay now' } }
      });
    } finally {
      off();
    }
  });

  async function evaluate(sessionId: string | undefined, expression: string): Promise<unknown> {
    const response = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, 30_000, sessionId ?? pageSessionId) as { result?: { value?: unknown } };
    return response.result?.value;
  }
});

function allocatePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

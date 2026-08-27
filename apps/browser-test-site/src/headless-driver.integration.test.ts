import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessBrowserHost, resolveChromeExecutable } from '@desktop-agent/browser-automation';
import { startBrowserTestSite, type BrowserTestSite } from './server';

const executable = resolveChromeExecutable();
const suite = executable ? describe : describe.skip;

suite('headless Chrome CDP driver', () => {
  let site: BrowserTestSite;
  let profile: string;
  let host: HeadlessBrowserHost;

  beforeAll(async () => {
    site = await startBrowserTestSite();
    profile = await mkdtemp(path.join(os.tmpdir(), 'jojo-headless-driver-'));
    host = new HeadlessBrowserHost({
      port: await allocatePort(),
      userDataDir: profile,
      executable: executable!,
      headless: true,
      closeRuntimeOnIdle: true,
      extraArgs: [
        '--site-per-process',
        '--no-proxy-server',
        '--host-resolver-rules=MAP jojo-top.test 127.0.0.1, MAP jojo-frame.test 127.0.0.1'
      ]
    });
  });

  afterAll(async () => {
    await host?.close();
    await site?.close();
    if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('runs page, same-origin iframe and OOPIF actions without Electron', async () => {
    await host.run({
      sessionId: 'headless-integration',
      allowedDomains: ['jojo-top.test', 'jojo-frame.test']
    }, async (session, signal) => {
      const page = await session.activePage();
      await page.navigate(`${site.topOrigin}/checkout`, signal);
      expect((await page.read({}, signal)).text).toContain('Checkout');

      const sameFrame = { selectors: ['iframe#profile'] };
      const profileButton = await page.resolveTarget({ selector: '#save-profile', frame: sameFrame }, undefined, signal);
      expect(profileButton?.frame).toEqual(sameFrame);
      await page.click(profileButton!, signal);

      const oopif = { selectors: ['iframe[name="payment"]'] };
      const payButton = await page.resolveTarget({ selector: '#pay', frame: oopif }, undefined, signal);
      expect(payButton?.frame).toEqual(oopif);
      await page.click(payButton!, signal);
      const snapshot = await page.read({ frame: oopif }, signal);
      expect(snapshot.text).toContain('Pay now');
    });
  }, 30_000);

  it('routes duplicate-URL OOPIFs by their frame target id', async () => {
    await host.run({
      sessionId: 'headless-duplicate-oopif',
      allowedDomains: ['jojo-top.test', 'jojo-frame.test']
    }, async (session, signal) => {
      const page = await session.activePage();
      await page.navigate(`${site.topOrigin}/checkout-duplicate`, signal);
      const primary = { selectors: ['iframe[name="payment"]'] };
      const backup = { selectors: ['iframe[name="backup-payment"]'] };
      await expect(page.resolveTarget({ selector: '#pay', frame: primary }, undefined, signal))
        .resolves.toMatchObject({ selector: '#pay', frame: primary });
      await expect(page.resolveTarget({ selector: '#pay', frame: backup }, undefined, signal))
        .resolves.toMatchObject({ selector: '#pay', frame: backup });
    });
  }, 30_000);
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

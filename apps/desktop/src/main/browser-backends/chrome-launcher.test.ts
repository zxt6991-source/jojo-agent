import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  chromeDebugLaunchArgs,
  chromeExecutableCandidates,
  chromeLaunchFailedMessage,
  chromeMissingMessage,
  ensureChromeDebugging,
  resolveChromeExecutable
} from './chrome-launcher';

describe('chrome launcher', () => {
  it('prefers a CHROME_PATH override and platform Chrome installs', () => {
    expect(chromeExecutableCandidates('darwin', { CHROME_PATH: '/opt/chrome' })[0]).toBe('/opt/chrome');
    expect(chromeExecutableCandidates('darwin', {})).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(chromeExecutableCandidates('win32', { PROGRAMFILES: 'C:\\Apps' })).toContain(path.join('C:\\Apps', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(chromeExecutableCandidates('linux', {})).toContain('google-chrome');
  });

  it('picks the first executable that exists', () => {
    expect(resolveChromeExecutable(['/missing', '/real/chrome'], (file) => file === '/real/chrome')).toBe('/real/chrome');
    expect(resolveChromeExecutable(['/missing'], () => false)).toBeUndefined();
  });

  it('launches Chrome with an isolated profile and debug port', () => {
    expect(chromeDebugLaunchArgs(9222, '/tmp/profile')).toEqual([
      '--remote-debugging-port=9222',
      '--remote-allow-origins=*',
      '--user-data-dir=/tmp/profile',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank'
    ]);
  });

  it('reuses an already debugging Chrome without spawning', async () => {
    const spawnChrome = vi.fn();
    const info = { browser: 'Chrome/124', webSocketDebuggerUrl: 'ws://127.0.0.1:9331/devtools/browser/1' };
    await expect(ensureChromeDebugging({
      port: 9331,
      userDataDir: '/unused-ready',
      probe: async () => info,
      spawnChrome
    })).resolves.toEqual(info);
    expect(spawnChrome).not.toHaveBeenCalled();
  });

  it('starts Chrome when the debug port is empty', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'jojo-chrome-'));
    const spawnChrome = vi.fn();
    const info = { browser: 'Chrome/124', webSocketDebuggerUrl: 'ws://127.0.0.1:9332/devtools/browser/1' };
    let attempts = 0;
    await expect(ensureChromeDebugging({
      port: 9332,
      userDataDir,
      probe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('refused');
        return info;
      },
      resolveExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      spawnChrome,
      sleep: async () => undefined,
      now: (() => {
        let tick = 0;
        return () => {
          tick += 1;
          return tick * 100;
        };
      })()
    })).resolves.toEqual(info);
    expect(spawnChrome).toHaveBeenCalledOnce();
    expect(spawnChrome.mock.calls[0]?.[1]).toContain('--remote-debugging-port=9332');
    expect(spawnChrome.mock.calls[0]?.[1]).toContain(`--user-data-dir=${userDataDir}`);
  });

  it('explains a missing Chrome install without CLI flags', async () => {
    await expect(ensureChromeDebugging({
      port: 9333,
      userDataDir: '/unused-missing',
      probe: async () => {
        throw new Error('refused');
      },
      resolveExecutable: () => undefined,
      spawnChrome: () => undefined
    })).rejects.toThrow(chromeMissingMessage());
  });

  it('explains a failed launch without asking the user to copy flags', async () => {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'jojo-chrome-'));
    await expect(ensureChromeDebugging({
      port: 9334,
      userDataDir,
      probe: async () => {
        throw new Error('refused');
      },
      resolveExecutable: () => '/chrome',
      spawnChrome: () => undefined,
      sleep: async () => undefined,
      now: (() => {
        let tick = 0;
        return () => {
          tick += 1;
          return tick * 10_000;
        };
      })()
    })).rejects.toThrow(chromeLaunchFailedMessage());
  });
});

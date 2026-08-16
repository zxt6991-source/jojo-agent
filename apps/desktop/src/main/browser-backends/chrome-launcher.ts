import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { probeChromeCdp, type ChromeVersionInfo } from './chrome-cdp-client';

const READY_TIMEOUT_MS = 12_000;
const READY_POLL_MS = 250;
const inflight = new Map<string, Promise<ChromeVersionInfo>>();

export function chromeDebugLaunchArgs(port: number, userDataDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ];
}

export function chromeExecutableCandidates(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const extras = [env.CHROME_PATH, env.GOOGLE_CHROME_SHIM].filter((value): value is string => Boolean(value));
  if (platform === 'darwin') {
    return [
      ...extras,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];
  }
  if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA ?? '';
    return [
      ...extras,
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...(localAppData ? [path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
  }
  return [...extras, 'google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium', 'microsoft-edge'];
}

export function pathHasExecutable(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathEnv = env.PATH ?? '';
  return pathEnv.split(path.delimiter).some((directory) => directory !== '' && existsSync(path.join(directory, file)));
}

export function chromeExecutableExists(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (file.includes(path.sep) || /^[A-Za-z]:[\\/]/u.test(file)) return existsSync(file);
  return pathHasExecutable(file, env);
}

export function resolveChromeExecutable(
  candidates = chromeExecutableCandidates(),
  exists: (file: string) => boolean = chromeExecutableExists
): string | undefined {
  return candidates.find((candidate) => exists(candidate));
}

export function chromeMissingMessage(): string {
  return '未找到本机 Chrome。请先安装 Google Chrome，然后再选择“本机浏览器”。';
}

export function chromeLaunchFailedMessage(): string {
  return '无法打开本机 Chrome。请确认已安装 Google Chrome 后重试。';
}

function defaultSpawn(executable: string, args: string[]): void {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

export async function ensureChromeDebugging(options: {
  port: number;
  userDataDir: string;
  probe?: (port: number) => Promise<ChromeVersionInfo>;
  resolveExecutable?: () => string | undefined;
  spawnChrome?: (executable: string, args: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ChromeVersionInfo> {
  const key = `${options.port}:${options.userDataDir}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = ensureChromeDebuggingOnce(options);
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

async function ensureChromeDebuggingOnce(options: {
  port: number;
  userDataDir: string;
  probe?: (port: number) => Promise<ChromeVersionInfo>;
  resolveExecutable?: () => string | undefined;
  spawnChrome?: (executable: string, args: string[]) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ChromeVersionInfo> {
  const probe = options.probe ?? ((port) => probeChromeCdp(port));
  try {
    return await probe(options.port);
  } catch {
    // Launch a dedicated Chrome profile so the user does not have to start debugging by hand.
  }
  const executable = (options.resolveExecutable ?? resolveChromeExecutable)();
  if (!executable) throw new Error(chromeMissingMessage());
  await mkdir(options.userDataDir, { recursive: true });
  const spawnChrome = options.spawnChrome ?? defaultSpawn;
  spawnChrome(executable, chromeDebugLaunchArgs(options.port, options.userDataDir));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + READY_TIMEOUT_MS;
  while (now() < deadline) {
    await sleep(READY_POLL_MS);
    try {
      return await probe(options.port);
    } catch {
      // Chrome is still starting.
    }
  }
  throw new Error(chromeLaunchFailedMessage());
}

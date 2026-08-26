import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { probeChromeCdp, type ChromeCdpVersion } from './cdp-client';

export type ChromeLaunchOptions = {
  port: number;
  userDataDir: string;
  executable?: string;
  headless?: boolean;
  extraArgs?: string[];
  launch?: boolean;
};

export type ChromeRuntime = {
  version: ChromeCdpVersion;
  process?: ChildProcess;
  owned: boolean;
  close(): Promise<void>;
};

export function resolveChromeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [
    env.CHROME_PATH,
    ...(process.platform === 'darwin' ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ] : process.platform === 'win32' ? [
      path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ] : ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'])
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => candidate.includes(path.sep)
    ? existsSync(candidate)
    : (env.PATH ?? '').split(path.delimiter).some((directory) => existsSync(path.join(directory, candidate))));
}

export async function startChromeRuntime(options: ChromeLaunchOptions): Promise<ChromeRuntime> {
  try {
    const version = await probeChromeCdp(options.port);
    return { version, owned: false, close: async () => undefined };
  } catch {
    if (options.launch === false) throw new Error(`Chrome CDP is unavailable on port ${options.port}.`);
  }
  const executable = options.executable ?? resolveChromeExecutable();
  if (!executable) throw new Error('Chrome executable was not found. Set CHROME_PATH or provide executable.');
  await mkdir(options.userDataDir, { recursive: true });
  const child = spawn(executable, [
    `--remote-debugging-port=${options.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${options.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.headless === false ? [] : ['--headless=new', '--disable-gpu']),
    ...(options.extraArgs ?? []),
    'about:blank'
  ], { stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  let version: ChromeCdpVersion | undefined;
  while (!version && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    version = await probeChromeCdp(options.port).catch(() => undefined);
  }
  if (!version) {
    child.kill('SIGTERM');
    throw new Error('Chrome did not expose CDP before the startup deadline.');
  }
  return {
    version,
    process: child,
    owned: true,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
    }
  };
}

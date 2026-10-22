import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface TestChrome {
  port: number;
  browser: { webSocketDebuggerUrl: string };
  stop(): Promise<void>;
}

/** The caller must preserve the profile if the child could not be stopped. */
export class TestChromeCleanupError extends AggregateError {}

/** Test-only launcher. Chrome owns the ephemeral port from bind to shutdown;
 * the fresh profile's DevToolsActivePort identifies this exact process. */
export async function startTestChrome(executable: string, profile: string, options: {
  extraArgs?: string[];
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  probe: (port: number) => Promise<{ webSocketDebuggerUrl: string }>;
}): Promise<TestChrome> {
  const child = (options.spawnProcess ?? spawn)(executable, [
    '--headless=new', '--disable-gpu',
    ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    '--remote-debugging-port=0', '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...(options.extraArgs ?? []), 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', spawnError: Error | undefined, closed = false;
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
  child.on('error', (error) => { spawnError = error; });
  const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve(); }));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= stopChild(child, exited, () => closed);
  const failure = (reason: string, cause?: unknown) => new Error(
    `Chrome test startup ${reason}. executable=${executable} exitCode=${child.exitCode} signal=${child.signalCode}`
      + `\nstderr (last 8192 chars):\n${stderr || '(empty)'}`, { cause }
  );
  const assertRunning = () => {
    if (spawnError) throw failure('failed to spawn', spawnError);
    if (closed || child.exitCode !== null || child.signalCode !== null) throw failure('exited before CDP was ready');
  };
  try {
    const deadline = performance.now() + (options.timeoutMs ?? 30_000);
    let lastProbeError: unknown;
    while (performance.now() < deadline) {
      assertRunning();
      let activePort: string | undefined;
      try { activePort = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw failure('could not read DevToolsActivePort', error);
      }
      // Chrome may still be writing the two-line file. Never probe an unparsed
      // port, and validate the browser id so a stale endpoint cannot pass.
      const [portLine, browserPath] = activePort?.trim().split(/\r?\n/u) ?? [];
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && browserPath?.startsWith('/devtools/browser/')) {
        try {
          const browser = await options.probe(port);
          if (new URL(browser.webSocketDebuggerUrl).pathname !== browserPath) throw new Error('CDP browser id differs from DevToolsActivePort.');
          assertRunning();
          return { port, browser, stop };
        } catch (error) { lastProbeError = error; }
      }
      assertRunning();
      await delay(100);
    }
    throw failure('timed out waiting for CDP', lastProbeError);
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new TestChromeCleanupError([error, cleanupError], 'Chrome startup and cleanup failed; preserve the test profile.'); }
    throw error;
  }
}

async function stopChild(child: ChildProcess, exited: Promise<void>, isClosed: () => boolean): Promise<void> {
  if (isClosed()) return;
  const waitForExit = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    } finally { clearTimeout(timer); }
  };
  child.kill('SIGTERM');
  if (await waitForExit()) return;
  child.kill('SIGKILL');
  if (!await waitForExit()) throw new Error('Test Chrome did not exit after SIGKILL; its profile was not safe to remove.');
}

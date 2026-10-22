import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestChrome, TestChromeCleanupError } from './chrome-test-process';

const pollDelay = vi.hoisted(() => vi.fn());
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: (ms: number) => {
    pollDelay(ms);
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}));

class FakeChrome extends EventEmitter {
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  ignoreTerm = false;
  kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal !== 'SIGTERM' || !this.ignoreTerm) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  });

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

describe('test Chrome startup', () => {
  let profile: string;
  const executable = '/test/chrome';
  const port = 41234;
  const browserPath = '/devtools/browser/owned-browser';
  const browser = { browser: 'Chrome/Test', webSocketDebuggerUrl: `ws://127.0.0.1:${port}${browserPath}` };

  beforeEach(async () => {
    profile = await mkdtemp(path.join(os.tmpdir(), 'jojo-chrome-launch-test-'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    pollDelay.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(profile, { recursive: true, force: true });
  });

  function launch(child = new FakeChrome(), onSpawn?: () => void) {
    const spawnProcess = vi.fn(() => {
      if (onSpawn) queueMicrotask(onSpawn);
      return child as unknown as ChildProcess;
    });
    const probe = vi.fn().mockResolvedValue(browser);
    return { child, spawnProcess, probe, options: { spawnProcess: spawnProcess as unknown as typeof spawn, probe, timeoutMs: 200 } };
  }

  function writeActivePort(contents = `${port}\n${browserPath}\n`) {
    return writeFile(path.join(profile, 'DevToolsActivePort'), contents);
  }

  it('waits for the complete active-port file and uses the port owned by Chrome', async () => {
    await writeActivePort(`${port}\n`);
    const { child, spawnProcess, probe, options } = launch();
    const starting = startTestChrome(executable, profile, options);
    await waitForPolls(1);
    expect(probe).not.toHaveBeenCalled();

    await writeActivePort();
    await vi.advanceTimersByTimeAsync(100);
    const runtime = await starting;
    expect(runtime.port).toBe(port);
    expect(runtime.browser).toEqual(browser);
    expect(probe).toHaveBeenCalledExactlyOnceWith(port);
    expect(spawnProcess).toHaveBeenCalledWith(executable, expect.arrayContaining([
      '--remote-debugging-port=0', `--user-data-dir=${profile}`
    ]), { stdio: ['ignore', 'ignore', 'pipe'] });

    await runtime.stop();
    await runtime.stop();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('reports spawn errors with the executable and original cause', async () => {
    const child = new FakeChrome();
    const spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const { options } = launch(child, () => {
      child.emit('error', spawnError);
      child.exit(-1);
    });
    const error = await startTestChrome(executable, profile, options).catch((error: Error) => error);
    expect(error).toMatchObject({ cause: spawnError });
    expect((error as Error).message).toContain('failed to spawn');
    expect((error as Error).message).toContain(`executable=${executable}`);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('fails promptly on early exit and retains bounded stderr diagnostics', async () => {
    const child = new FakeChrome();
    const { options } = launch(child, () => {
      child.stderr.write(`discarded-start${'x'.repeat(9000)}\nChrome failed: missing library`);
      child.exit(1);
    });
    const error = await startTestChrome(executable, profile, options).catch((error: Error) => error);
    expect((error as Error).message).toContain('exited before CDP was ready');
    expect((error as Error).message).toContain('exitCode=1');
    expect((error as Error).message).toContain('Chrome failed: missing library');
    expect((error as Error).message).not.toContain('discarded-start');
    expect(pollDelay).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('cleans up a Chrome process that never publishes its debugging endpoint', async () => {
    const { child, probe, options } = launch();
    const result = startTestChrome(executable, profile, options).catch((error: Error) => error);
    await waitForPolls(1);
    await vi.advanceTimersByTimeAsync(100);
    await waitForPolls(2);
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;
    expect((error as Error).message).toContain('timed out waiting for CDP');
    expect(probe).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('rejects an endpoint whose browser id does not belong to the launched profile', async () => {
    await writeActivePort();
    const { child, probe, options } = launch();
    probe.mockResolvedValue({ ...browser, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/other-browser` });
    const result = startTestChrome(executable, profile, options).catch((error: Error) => error);
    await waitForPolls(1);
    await vi.advanceTimersByTimeAsync(100);
    await waitForPolls(2);
    await vi.advanceTimersByTimeAsync(100);
    const error = await result;
    expect((error as Error).message).toContain('timed out waiting for CDP');
    expect((error as Error).cause).toEqual(new Error('CDP browser id differs from DevToolsActivePort.'));
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('escalates to SIGKILL when Chrome ignores SIGTERM', async () => {
    await writeActivePort();
    const { child, options } = launch();
    child.ignoreTerm = true;
    const runtime = await startTestChrome(executable, profile, options);
    const stopping = runtime.stop();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(1999);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(child.signalCode).toBe('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks failed startup cleanup so callers preserve a profile still in use', async () => {
    const { child, options } = launch();
    child.kill.mockImplementation(() => false);
    const result = startTestChrome(executable, profile, { ...options, timeoutMs: 0 }).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(4000);
    const error = await result;
    expect(error).toBeInstanceOf(TestChromeCleanupError);
    expect((error as TestChromeCleanupError).errors[0].message).toContain('timed out waiting for CDP');
    expect((error as TestChromeCleanupError).errors[1].message).toContain('did not exit after SIGKILL');
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Let real filesystem reads finish before advancing the simulated poll clock.
async function waitForPolls(count: number): Promise<void> {
  const { setTimeout: realDelay } = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pollDelay.mock.calls.length >= count) return;
    await realDelay(5);
  }
  expect(pollDelay.mock.calls.length, `Expected ${count} Chrome startup polls after waiting 2s for filesystem I/O`)
    .toBeGreaterThanOrEqual(count);
}

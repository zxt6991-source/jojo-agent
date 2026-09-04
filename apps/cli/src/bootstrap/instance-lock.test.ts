import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';
import { acquireInstanceLock } from './instance-lock.js';

describe('instance lock', () => {
  it('rejects a second live owner and releases all process files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-lock-'));
    const config = await loadConfig({ homeDirectory: root, environment: {} });
    const first = await acquireInstanceLock(config);
    await expect(acquireInstanceLock(config)).rejects.toMatchObject({ code: 'INSTANCE_ALREADY_RUNNING', exitCode: 3 });
    await first.update('http://127.0.0.1:7788');
    await first.release();
    const next = await acquireInstanceLock(config);
    await next.release();
  });

  it('recovers a stale lock record', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-stale-lock-'));
    const config = await loadConfig({ homeDirectory: root, environment: {} });
    await (await import('node:fs/promises')).mkdir(config.paths.runDir, { recursive: true });
    await writeFile(config.paths.lockFile, JSON.stringify({
      pid: 2_000_000_000,
      instanceId: 'default',
      version: '0.1.0',
      startedAt: new Date().toISOString(),
      configFile: config.paths.configFile,
      dataDir: config.paths.dataDir
    }));
    const lock = await acquireInstanceLock(config);
    expect(lock.status.pid).toBe(process.pid);
    await lock.release();
  });
});

import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { EffectiveConfig } from '../config/schema.js';
import { ExitCode, JojoCliError } from '../errors.js';

export type RuntimeStatus = {
  pid: number;
  instanceId: string;
  version: string;
  startedAt: string;
  address?: string;
  configFile: string;
  dataDir: string;
};

export type InstanceLock = {
  status: RuntimeStatus;
  update(address: string): Promise<void>;
  release(): Promise<void>;
};

export async function acquireInstanceLock(config: EffectiveConfig): Promise<InstanceLock> {
  await mkdir(config.paths.runDir, { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(config.paths.lockFile, 'wx', 0o600);
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      const current = await readRuntimeStatus(config.paths.lockFile);
      if (current && isProcessAlive(current.pid)) {
        throw new JojoCliError(
          `Instance "${config.runtime.instanceId}" is already running with PID ${current.pid}.`,
          'INSTANCE_ALREADY_RUNNING',
          ExitCode.alreadyRunning,
          { pid: current.pid, instanceId: current.instanceId }
        );
      }
      await unlink(config.paths.lockFile).catch(() => undefined);
    }
  }
  if (!handle) {
    throw new JojoCliError('Could not acquire the instance lock.', 'INSTANCE_LOCK_FAILED', ExitCode.alreadyRunning);
  }

  let status: RuntimeStatus = {
    pid: process.pid,
    instanceId: config.runtime.instanceId,
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    configFile: config.paths.configFile,
    dataDir: config.paths.dataDir
  };
  await handle.writeFile(`${JSON.stringify(status)}\n`, 'utf8');
  await writeFile(config.paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  let released = false;
  return {
    get status() { return status; },
    async update(address: string) {
      status = { ...status, address };
      await writeJsonAtomic(config.paths.statusFile, status);
    },
    async release() {
      if (released) return;
      released = true;
      await handle!.close().catch(() => undefined);
      await Promise.all([
        removeIfOwned(config.paths.lockFile, process.pid),
        removePidIfOwned(config.paths.pidFile, process.pid),
        removeIfOwned(config.paths.statusFile, process.pid)
      ]);
    }
  };
}

export async function readRuntimeStatus(file: string): Promise<RuntimeStatus | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RuntimeStatus>;
    if (!Number.isInteger(parsed.pid) || !parsed.instanceId || !parsed.startedAt) return undefined;
    return parsed as RuntimeStatus;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function removeIfOwned(file: string, pid: number): Promise<void> {
  const status = await readRuntimeStatus(file);
  if (status?.pid === pid) await unlink(file).catch(() => undefined);
}

async function removePidIfOwned(file: string, pid: number): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')).trim() === String(pid)) await unlink(file);
  } catch {
    // Already absent or replaced by another instance.
  }
}

function isExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

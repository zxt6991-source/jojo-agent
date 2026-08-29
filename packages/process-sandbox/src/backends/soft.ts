import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signalChildProcess, type ProcessTreeController, defaultProcessTreeController } from '../process-tree.js';
import type { ProcessSandbox, SandboxExit, SandboxProcess, SandboxSpec } from '../types.js';

export class SoftProcessSandbox implements ProcessSandbox {
  constructor(private readonly processTree: ProcessTreeController = defaultProcessTreeController) {}

  async probe() { return { available: true, strength: 'soft' as const, reason: 'OS-level filesystem and network isolation is unavailable.' }; }

  async spawn(spec: SandboxSpec): Promise<SandboxProcess> {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'jojo-sandbox-'));
    const home = path.join(temporaryRoot, 'home');
    const temporary = path.join(temporaryRoot, 'tmp');
    const workingDirectory = path.join(temporaryRoot, 'workspace');
    await Promise.all([mkdir(home), mkdir(temporary), mkdir(workingDirectory)]);
    const cwd = spec.isolatedCwd ? workingDirectory : spec.cwd;
    const child = spawn(spec.command, spec.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: {
        ...spec.env,
        ...(spec.fakeHome ? { HOME: home } : {}),
        ...(spec.tmpfs ? { TMPDIR: temporary } : {}),
        PWD: cwd
      },
      stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe']
    });
    return sandboxProcess(child, 'soft', temporaryRoot, this.processTree);
  }
}

export function sandboxProcess(
  child: ChildProcess,
  strength: SandboxProcess['strength'],
  temporaryRoot?: string,
  processTree: ProcessTreeController = defaultProcessTreeController
): SandboxProcess {
  let completed: Promise<SandboxExit> | undefined;
  const wait = () => completed ??= new Promise<SandboxExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({
      exitCode,
      ...(signal ? { signal } : {})
    }));
  }).finally(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  });
  return {
    strength,
    ...(child.pid ? { pid: child.pid } : {}),
    stdout: child.stdout!,
    stderr: child.stderr!,
    ...(child.stdin ? { stdin: child.stdin } : {}),
    wait,
    terminate: () => signalChildProcess(child, 'terminate', processTree),
    kill: () => signalChildProcess(child, 'kill', processTree)
  };
}

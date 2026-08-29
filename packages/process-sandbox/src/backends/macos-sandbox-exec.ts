import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessSandbox, SandboxProbe, SandboxSpec } from '../types.js';
import { sandboxProcess } from './soft.js';

const SENSITIVE_HOST_PATHS = ['/Users', '/home', '/Volumes', '/private/tmp', '/tmp', '/private/var/folders'];

function sbplString(value: string): string { return JSON.stringify(value); }

export function macOSSandboxProfile(spec: SandboxSpec, temporaryRoot: string): string {
  if (spec.network.mode === 'allowlist') throw Object.assign(
    new Error('macOS Seatbelt does not implement host allowlists.'),
    { code: 'sandbox_network_denied' }
  );
  const rules = [
    '(version 1)',
    '(allow default)',
    ...SENSITIVE_HOST_PATHS.map((directory) => `(deny file-read* file-write* (subpath ${sbplString(directory)}))`),
    `(allow file-read* file-write* (subpath ${sbplString(temporaryRoot)}))`,
    ...spec.mounts.map((mount) => {
      if (mount.target && path.resolve(mount.target) !== path.resolve(mount.path)) {
        throw Object.assign(new Error('macOS Seatbelt cannot remap sandbox mount paths.'), { code: 'sandbox_mount_unsupported' });
      }
      const operations = mount.mode === 'rw' ? 'file-read* file-write*' : 'file-read*';
      return `(allow ${operations} (subpath ${sbplString(path.resolve(mount.path))}))`;
    }),
    ...(spec.network.mode === 'host' ? [] : ['(deny network*)'])
  ];
  return rules.join('\n');
}

export class MacOSSandboxExecSandbox implements ProcessSandbox {
  constructor(private readonly executable = '/usr/bin/sandbox-exec') {}

  async probe(): Promise<SandboxProbe> {
    if (process.platform !== 'darwin') return { available: false, strength: 'none', reason: 'macOS Seatbelt is only supported on macOS.' };
    return new Promise((resolve) => {
      const child = spawn(this.executable, ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore', shell: false });
      child.once('error', () => resolve({ available: false, strength: 'none', reason: 'macOS sandbox-exec is unavailable.' }));
      child.once('close', (code) => resolve(code === 0
        ? { available: true, strength: 'strong' }
        : { available: false, strength: 'none', reason: `macOS sandbox-exec probe exited with ${code}.` }));
    });
  }

  async spawn(spec: SandboxSpec) {
    const probe = await this.probe();
    if (!probe.available) throw Object.assign(new Error(probe.reason ?? 'Strong sandbox unavailable.'), { code: 'sandbox_unavailable' });
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'jojo-seatbelt-'));
    const home = path.join(temporaryRoot, 'home');
    const temporary = path.join(temporaryRoot, 'tmp');
    const workingDirectory = path.join(temporaryRoot, 'workspace');
    await Promise.all([mkdir(home), mkdir(temporary), mkdir(workingDirectory)]);
    const cwd = spec.isolatedCwd ? workingDirectory : spec.cwd;
    let profile: string;
    try {
      profile = macOSSandboxProfile(spec, temporaryRoot);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const child = spawn(this.executable, ['-p', profile, spec.command, ...spec.args], {
      cwd,
      shell: false,
      detached: true,
      env: {
        ...spec.env,
        ...(spec.fakeHome ? { HOME: home } : {}),
        ...(spec.tmpfs ? { TMPDIR: temporary } : {}),
        PWD: cwd
      },
      stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe']
    });
    return sandboxProcess(child, 'strong', temporaryRoot);
  }
}

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import type { ProcessSandbox, SandboxProbe, SandboxSpec } from '../types.js';
import { sandboxProcess } from './soft.js';
import path from 'node:path';

const SYSTEM_MOUNTS = ['/usr', '/bin', '/lib', '/lib64', '/etc/ssl/certs', '/etc/pki'];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function parentDirectories(target: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    directories.unshift(current);
    current = path.dirname(current);
  }
  return directories;
}

export class LinuxBubblewrapSandbox implements ProcessSandbox {
  constructor(private readonly executable = 'bwrap') {}

  async probe(): Promise<SandboxProbe> {
    if (process.platform !== 'linux') return { available: false, strength: 'none', reason: 'Bubblewrap is only supported on Linux.' };
    return new Promise((resolve) => {
      const child = spawn(this.executable, ['--version'], { stdio: 'ignore', shell: false });
      child.once('error', () => resolve({ available: false, strength: 'none', reason: 'Bubblewrap is not installed.' }));
      child.once('close', (code) => resolve(code === 0
        ? { available: true, strength: 'strong' }
        : { available: false, strength: 'none', reason: `Bubblewrap probe exited with ${code}.` }));
    });
  }

  async spawn(spec: SandboxSpec) {
    const probe = await this.probe();
    if (!probe.available) throw Object.assign(new Error(probe.reason ?? 'Strong sandbox unavailable.'), { code: 'sandbox_unavailable' });
    if (spec.network.mode === 'allowlist') {
      throw Object.assign(new Error('Bubblewrap does not implement host allowlists.'), { code: 'sandbox_network_denied' });
    }
    const args = [
      '--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      ...(spec.network.mode === 'none' ? ['--unshare-net'] : []),
      '--proc', '/proc', '--dev', '/dev',
      ...(spec.tmpfs ? ['--tmpfs', '/tmp'] : spec.isolatedCwd ? ['--dir', '/tmp'] : []),
      ...(spec.fakeHome ? ['--dir', '/home', '--dir', '/home/jojo', '--setenv', 'HOME', '/home/jojo'] : [])
    ];
    for (const mount of SYSTEM_MOUNTS) {
      if (await exists(mount)) {
        for (const directory of parentDirectories(mount)) args.push('--dir', directory);
        args.push('--ro-bind', mount, mount);
      }
    }
    for (const mount of spec.mounts) {
      const target = mount.target ?? mount.path;
      for (const directory of parentDirectories(target)) args.push('--dir', directory);
      args.push(mount.mode === 'rw' ? '--bind' : '--ro-bind', mount.path, target);
    }
    for (const [name, value] of Object.entries(spec.env)) args.push('--setenv', name, value);
    const cwd = spec.isolatedCwd ? '/tmp' : spec.cwd;
    args.push('--setenv', 'PWD', cwd, '--chdir', cwd, '--', spec.command, ...spec.args);
    const child = spawn(this.executable, args, {
      shell: false,
      detached: true,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe']
    });
    return sandboxProcess(child, 'strong');
  }
}

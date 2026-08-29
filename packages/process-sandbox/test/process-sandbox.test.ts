import { PassThrough } from 'node:stream';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DefaultProcessSandbox,
  DefaultStreamingSecretRedactor,
  MacOSSandboxExecSandbox,
  macOSSandboxProfile,
  SoftProcessSandbox,
  createSandboxEnvironment,
  type ProcessSandbox,
  type SandboxProcess,
  type SandboxSpec
} from '../src/index.js';

const spec = (command: string, args: string[]): SandboxSpec => ({
  id: 'test', cwd: process.cwd(), command, args,
  env: createSandboxEnvironment({ workingDirectory: process.cwd() }),
  mounts: [{ path: process.cwd(), mode: 'rw' }], network: { mode: 'none' },
  fakeHome: true, tmpfs: true, resources: { timeoutMs: 5_000, maxOutputBytes: 100_000 }
});

describe('process sandbox', () => {
  it('constructs an allowlisted environment without host credential capabilities', () => {
    const environment = createSandboxEnvironment({
      workingDirectory: '/workspace',
      source: { LANG: 'en_US.UTF-8', SSH_AUTH_SOCK: '/tmp/ssh.sock', AWS_SECRET_ACCESS_KEY: 'secret', NODE_OPTIONS: '--require x' }
    });
    expect(environment).toMatchObject({ HOME: '/home/jojo', TMPDIR: '/tmp', PWD: '/workspace', LANG: 'en_US.UTF-8' });
    expect(environment.PATH).toContain('/usr/bin');
    expect(environment).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('NODE_OPTIONS');
  });

  it('redacts known secrets and patterns across stream chunks', () => {
    const redactor = new DefaultStreamingSecretRedactor(['abc123xyz']);
    const output = redactor.push(Buffer.from('TOKEN=abc'))
      + redactor.push(Buffer.from('123xyz\nAuthorization: Bearer token.value'))
      + redactor.flush();
    expect(output).not.toContain('abc123xyz');
    expect(output).not.toContain('token.value');
    expect(output).toContain('TOKEN=[REDACTED]');
    expect(output).toContain('Bearer [REDACTED]');
  });

  it('runs soft fallback with a fake HOME and no inherited SSH agent', async () => {
    const sandbox = new SoftProcessSandbox();
    const processHandle = await sandbox.spawn(spec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({home:process.env.HOME,ssh:process.env.SSH_AUTH_SOCK}))']));
    let output = '';
    processHandle.stdout.on('data', (chunk) => { output += chunk.toString(); });
    await expect(processHandle.wait()).resolves.toMatchObject({ exitCode: 0 });
    const parsed = JSON.parse(output) as { home: string; ssh?: string };
    expect(parsed.home).toContain('jojo-sandbox-');
    expect(parsed.ssh).toBeUndefined();
  });

  it('allocates an isolated working directory instead of exposing the host temp root', async () => {
    const sandbox = new SoftProcessSandbox();
    const processHandle = await sandbox.spawn({
      ...spec(process.execPath, ['-e', 'process.stdout.write(process.cwd())']),
      cwd: os.tmpdir(), isolatedCwd: true, mounts: []
    });
    let output = '';
    processHandle.stdout.on('data', (chunk) => { output += chunk.toString(); });
    await expect(processHandle.wait()).resolves.toMatchObject({ exitCode: 0 });
    expect(output).toContain('jojo-sandbox-');
    expect(output).toContain('workspace');
    expect(output).not.toBe(os.tmpdir());
  });

  it('builds a macOS profile that denies network and only writes to explicit roots', () => {
    const profile = macOSSandboxProfile({
      ...spec('/usr/bin/true', []),
      mounts: [{ path: '/workspace/project', mode: 'rw' }], network: { mode: 'none' }
    }, '/private/tmp/seatbelt');
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny network*)');
    expect(profile).toContain('(deny file-read* file-write* (subpath "/Users"))');
    expect(profile).toContain('(allow file-read* file-write* (subpath "/workspace/project"))');
    expect(profile).toContain('(allow file-read* file-write* (subpath "/private/tmp/seatbelt"))');
    expect(profile).not.toContain(os.homedir());
  });

  it('rejects unsupported macOS path remapping and network allowlists', () => {
    expect(() => macOSSandboxProfile({
      ...spec('/usr/bin/true', []), mounts: [{ path: '/source', target: '/target', mode: 'ro' }]
    }, '/private/tmp/seatbelt')).toThrowError(expect.objectContaining({ code: 'sandbox_mount_unsupported' }));
    expect(() => macOSSandboxProfile({
      ...spec('/usr/bin/true', []), network: { mode: 'allowlist', hosts: ['example.com'] }
    }, '/private/tmp/seatbelt')).toThrowError(expect.objectContaining({ code: 'sandbox_network_denied' }));
  });

  it.runIf(process.platform === 'darwin' && process.env.JOJO_STRONG_SANDBOX_TEST === '1')(
    'runs Node inside the real macOS strong sandbox',
    async () => {
      const sandbox = new MacOSSandboxExecSandbox();
      const processHandle = await sandbox.spawn(spec(process.execPath, ['-e', 'process.stdout.write(process.version)']));
      let output = '';
      let error = '';
      processHandle.stdout.on('data', (chunk) => { output += chunk.toString(); });
      processHandle.stderr.on('data', (chunk) => { error += chunk.toString(); });
      const exit = await processHandle.wait();
      if (exit.exitCode !== 0) throw new Error(JSON.stringify({ ...exit, error, output }));
      expect(output).toBe(process.version);

      const homeProbe = await sandbox.spawn(spec(process.execPath, [
        '-e',
        `try{require('node:fs').readdirSync(${JSON.stringify(os.homedir())});process.stdout.write('VISIBLE')}catch(error){process.stdout.write(error.code)}`
      ]));
      let homeResult = '';
      homeProbe.stdout.on('data', (chunk) => { homeResult += chunk.toString(); });
      await expect(homeProbe.wait()).resolves.toMatchObject({ exitCode: 0 });
      expect(['EPERM', 'EACCES']).toContain(homeResult);

      const networkProbe = await sandbox.spawn(spec(process.execPath, [
        '-e',
        `const socket=require('node:net').connect(9,'127.0.0.1');socket.on('error',(error)=>process.stdout.write(error.code));`
      ]));
      let networkResult = '';
      networkProbe.stdout.on('data', (chunk) => { networkResult += chunk.toString(); });
      await expect(networkProbe.wait()).resolves.toMatchObject({ exitCode: 0 });
      expect(['EPERM', 'EACCES']).toContain(networkResult);
    }
  );

  it('does not silently use the soft backend in strict mode', async () => {
    const streams = () => ({ stdout: new PassThrough(), stderr: new PassThrough() });
    const unavailable: ProcessSandbox = {
      probe: async () => ({ available: false, strength: 'none', reason: 'missing' }),
      spawn: async () => { throw new Error('should not spawn'); }
    };
    const fallback: ProcessSandbox = {
      probe: async () => ({ available: true, strength: 'soft' }),
      spawn: async () => ({ strength: 'soft', ...streams(), wait: async () => ({ exitCode: 0 }), terminate: async () => undefined, kill: async () => undefined } satisfies SandboxProcess)
    };
    const sandbox = new DefaultProcessSandbox('strict', unavailable, fallback);
    await expect(sandbox.spawn(spec(process.execPath, []))).rejects.toMatchObject({ code: 'sandbox_unavailable' });
  });
});

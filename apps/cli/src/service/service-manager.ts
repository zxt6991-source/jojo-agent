import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { EffectiveConfig } from '../config/schema.js';
import { ExitCode, JojoCliError, errorMessage } from '../errors.js';

const execFile = promisify(execFileCallback);

export type ServiceStatus = {
  installed: boolean;
  running: boolean;
  detail?: string;
};

export type ServiceInstallOptions = {
  config: EffectiveConfig;
  executable?: string;
  script?: string;
};

export interface ServiceManager {
  readonly definitionPath: string;
  install(options: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  logs(options: { follow: boolean; lines: number }): Promise<void>;
}

export function createServiceManager(platform = process.platform, homeDirectory = os.homedir()): ServiceManager {
  if (platform === 'linux') return new SystemdServiceManager(homeDirectory);
  if (platform === 'darwin') return new LaunchdServiceManager(homeDirectory);
  throw serviceError(`OS service management is not supported on ${platform}.`, 'SERVICE_PLATFORM_UNSUPPORTED');
}

export function systemdUnit(input: ServiceInstallOptions): string {
  const command = serviceCommand(input);
  return `[Unit]
Description=Jojo Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${command} serve --config ${systemdQuote(input.config.paths.configFile)}
ExecStartPre=${command} serve --config ${systemdQuote(input.config.paths.configFile)} --check
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
Environment=NODE_ENV=production
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(input: ServiceInstallOptions): string {
  const args = serviceArguments(input);
  const config = input.config;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.jojo.agent</string>
  <key>ProgramArguments</key>
  <array>
${[...args, 'serve', '--config', config.paths.configFile].map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(config.paths.logDir, 'jojo-server.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(config.paths.logDir, 'jojo-server.error.log'))}</string>
</dict>
</plist>
`;
}

class SystemdServiceManager implements ServiceManager {
  readonly definitionPath: string;

  constructor(homeDirectory: string) {
    this.definitionPath = path.join(homeDirectory, '.config/systemd/user/jojo.service');
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(this.definitionPath), { recursive: true });
    await writeFile(this.definitionPath, systemdUnit(options), { mode: 0o600 });
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', 'jojo.service']);
  }

  async uninstall(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await run('systemctl', ['--user', 'disable', '--now', 'jojo.service']).catch(() => undefined);
    await unlink(this.definitionPath).catch(() => undefined);
    await run('systemctl', ['--user', 'daemon-reload']);
  }

  start(): Promise<void> { return run('systemctl', ['--user', 'start', 'jojo.service']); }
  stop(): Promise<void> { return run('systemctl', ['--user', 'stop', 'jojo.service']); }
  restart(): Promise<void> { return run('systemctl', ['--user', 'restart', 'jojo.service']); }
  async status(): Promise<ServiceStatus> {
    const installed = await exists(this.definitionPath);
    if (!installed) return { installed: false, running: false };
    try {
      const { stdout } = await execFile('systemctl', ['--user', 'is-active', 'jojo.service']);
      return { installed: true, running: stdout.trim() === 'active', detail: stdout.trim() };
    } catch (error) {
      return { installed: true, running: false, detail: errorMessage(error) };
    }
  }
  logs(options: { follow: boolean; lines: number }): Promise<void> {
    return inherit('journalctl', ['--user', '-u', 'jojo.service', '-n', String(options.lines), ...(options.follow ? ['-f'] : [])]);
  }
}

class LaunchdServiceManager implements ServiceManager {
  readonly definitionPath: string;
  private readonly domain = `gui/${process.getuid?.() ?? 0}`;

  constructor(private readonly homeDirectory: string) {
    this.definitionPath = path.join(homeDirectory, 'Library/LaunchAgents/dev.jojo.agent.plist');
  }

  async install(options: ServiceInstallOptions): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.dirname(this.definitionPath), { recursive: true });
    await mkdir(options.config.paths.logDir, { recursive: true, mode: 0o700 });
    await writeFile(this.definitionPath, launchdPlist(options), { mode: 0o600 });
  }
  async uninstall(): Promise<void> {
    const { unlink } = await import('node:fs/promises');
    await run('launchctl', ['bootout', this.domain, this.definitionPath]).catch(() => undefined);
    await unlink(this.definitionPath).catch(() => undefined);
  }
  start(): Promise<void> { return run('launchctl', ['bootstrap', this.domain, this.definitionPath]); }
  stop(): Promise<void> { return run('launchctl', ['bootout', this.domain, this.definitionPath]); }
  async restart(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.start();
  }
  async status(): Promise<ServiceStatus> {
    const installed = await exists(this.definitionPath);
    if (!installed) return { installed: false, running: false };
    try {
      const { stdout } = await execFile('launchctl', ['print', `${this.domain}/dev.jojo.agent`]);
      const detail = stdout.split('\n')[0]?.trim();
      return { installed: true, running: true, ...(detail ? { detail } : {}) };
    } catch (error) {
      return { installed: true, running: false, detail: errorMessage(error) };
    }
  }
  logs(options: { follow: boolean; lines: number }): Promise<void> {
    const log = path.join(this.homeDirectory, '.jojo/logs/jojo-server.log');
    return inherit('tail', [...(options.follow ? ['-f'] : []), '-n', String(options.lines), log]);
  }
}

function serviceArguments(input: ServiceInstallOptions): string[] {
  return input.script ? [input.executable ?? process.execPath, input.script] : [input.executable ?? process.argv[1] ?? 'jojo'];
}

function serviceCommand(input: ServiceInstallOptions): string {
  return serviceArguments(input).map(systemdQuote).join(' ');
}

function systemdQuote(value: string): string {
  return `"${value.replace(/[\\"$`]/gu, '\\$&')}"`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

async function exists(file: string): Promise<boolean> {
  try { await (await import('node:fs/promises')).access(file); return true; } catch { return false; }
}

async function run(command: string, args: string[]): Promise<void> {
  try { await execFile(command, args); }
  catch (error) { throw serviceError(`${command} failed: ${errorMessage(error)}`, 'SERVICE_COMMAND_FAILED', error); }
}

async function inherit(command: string, args: string[]): Promise<void> {
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

function serviceError(message: string, code: string, cause?: unknown): JojoCliError {
  return new JojoCliError(message, code, ExitCode.serviceFailure, undefined, cause === undefined ? undefined : { cause });
}

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/loader.js';
import { launchdPlist, systemdUnit } from './service-manager.js';

describe('service definitions', () => {
  it('renders a hardened systemd user service with a preflight check', async () => {
    const config = await loadConfig({ homeDirectory: '/tmp/jojo service', environment: {} });
    const unit = systemdUnit({ config, executable: '/usr/bin/node', script: '/opt/jojo/bin.js' });
    expect(unit).toContain('ExecStartPre="/usr/bin/node" "/opt/jojo/bin.js" serve --config');
    expect(unit).toContain('--check');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('NoNewPrivileges=true');
  });

  it('escapes launchd arguments and redirects logs', async () => {
    const config = await loadConfig({ homeDirectory: '/tmp/jojo&home', environment: {} });
    const plist = launchdPlist({ config, executable: '/usr/bin/node', script: '/opt/jojo/bin.js' });
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('/tmp/jojo&amp;home/.jojo/config.yml');
    expect(plist).toContain('<key>StandardOutPath</key>');
  });
});

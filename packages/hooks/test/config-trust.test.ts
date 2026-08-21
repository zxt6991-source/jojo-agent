import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileHookTrustStore,
  hookConfigFingerprint,
  loadHookRuntime,
  parseHookConfig,
  parseHookDuration
} from '../src/index.js';

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), 'jojo-hooks-')));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('hook configuration and project trust', () => {
  it('validates timeouts, matchers, async events and approval sources', () => {
    expect(parseHookDuration('5s')).toBe(5_000);
    expect(() => parseHookDuration('31s')).toThrow('hook_invalid_timeout');
    expect(() => parseHookConfig(`version: 1\nhooks:\n  Stop:\n    - id: bad\n      command: echo ok\n      matcher: x\n`, 'user')).toThrow('hook_matcher_not_supported');
    expect(() => parseHookConfig(`version: 1\nhooks:\n  PostToolUse:\n    - id: bad\n      command: echo ok\n      async: true\n`, 'user')).toThrow('hook_async_not_supported');
    expect(() => parseHookConfig(`version: 1\nhooks:\n  PreToolUse:\n    - id: bad\n      command: echo ok\n      canApprove: true\n`, 'project')).toThrow('hook_approval_not_allowed');
  });

  it('disables project hooks until the exact file fingerprint is trusted', async () => {
    const root = await temporaryDirectory();
    const jojo = path.join(root, '.jojo');
    const projectConfig = path.join(jojo, 'hooks.yml');
    const userConfig = path.join(root, 'missing-user.yml');
    const trust = new FileHookTrustStore(path.join(root, 'trust.json'));
    const first = `version: 1\nhooks:\n  Stop:\n    - id: audit\n      command: echo ok\n`;
    await mkdir(jojo, { recursive: true });
    await writeFile(projectConfig, first);

    expect((await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust })).statuses)
      .toContainEqual(expect.objectContaining({ source: 'project', state: 'untrusted' }));

    await trust.trust(projectConfig, hookConfigFingerprint(first));
    const trusted = await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust });
    expect(trusted.statuses).toContainEqual(expect.objectContaining({ source: 'project', state: 'loaded' }));
    expect(trusted.runtime.configured('Stop')).toBe(true);

    await writeFile(projectConfig, `${first}\n# changed\n`);
    expect((await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust })).statuses)
      .toContainEqual(expect.objectContaining({ source: 'project', state: 'untrusted' }));
  });

  it('persists disabled project hooks across fingerprint changes until they are trusted again', async () => {
    const root = await temporaryDirectory();
    const jojo = path.join(root, '.jojo');
    const projectConfig = path.join(jojo, 'hooks.yml');
    const userConfig = path.join(root, 'missing-user.yml');
    const trust = new FileHookTrustStore(path.join(root, 'trust.json'));
    const first = `version: 1\nhooks:\n  Stop:\n    - id: audit\n      command: echo ok\n`;
    await mkdir(jojo, { recursive: true });
    await writeFile(projectConfig, first);
    await trust.disable(projectConfig);

    const disabled = await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust });
    expect(disabled.statuses).toContainEqual(expect.objectContaining({ source: 'project', state: 'disabled' }));
    expect(disabled.runtime.configured('Stop')).toBe(false);

    await writeFile(projectConfig, `${first}\n# changed\n`);
    expect((await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust })).statuses)
      .toContainEqual(expect.objectContaining({ source: 'project', state: 'disabled' }));

    await trust.trust(projectConfig, hookConfigFingerprint(`${first}\n# changed\n`));
    const trusted = await loadHookRuntime({ workingDirectory: root, userConfigPath: userConfig, trustStore: trust });
    expect(trusted.statuses).toContainEqual(expect.objectContaining({ source: 'project', state: 'loaded' }));
    expect(trusted.runtime.configured('Stop')).toBe(true);
  });

  it('can inspect user hooks without treating the home directory as a project', async () => {
    const root = await temporaryDirectory();
    const userConfig = path.join(root, 'user-hooks.yml');
    await writeFile(userConfig, `version: 1\nhooks:\n  Stop:\n    - id: audit\n      command: echo ok\n`);
    const loaded = await loadHookRuntime({
      workingDirectory: root,
      userConfigPath: userConfig,
      includeProject: false,
      trustStore: new FileHookTrustStore(path.join(root, 'trust.json'))
    });
    expect(loaded.statuses).toEqual([expect.objectContaining({ source: 'user', state: 'loaded' })]);
  });
});

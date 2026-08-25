import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateBrowserRecording, type BrowserRecordingDocument } from '@desktop-agent/contracts';
import {
  BrowserRecordingRegistry,
  BrowserRecordingStore,
  FileBrowserRecordingTrustStore,
  finalizeBrowserRecording,
  stringifyBrowserRecording
} from '../src';

function recording(input: {
  id: string;
  name: string;
  scope: 'user' | 'project';
  action?: 'click' | 'wait';
}): BrowserRecordingDocument {
  const migrated = migrateBrowserRecording({
    version: 1,
    id: input.id,
    name: input.name,
    createdAt: '2026-08-25T00:00:00.000Z',
    steps: input.action === 'wait'
      ? [{ action: 'wait', selector: '#ready', state: 'visible' }]
      : [{ action: 'click', selector: '#save', fingerprint: { tag: 'button', name: 'Save' } }]
  });
  return finalizeBrowserRecording({ ...migrated, scope: input.scope });
}

async function fixture(builtins: BrowserRecordingDocument[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jojo-recording-registry-'));
  const userDirectory = path.join(root, 'user');
  const workspace = path.join(root, 'workspace');
  const projectDirectory = path.join(workspace, '.jojo', 'browser-recordings');
  const trustStore = new FileBrowserRecordingTrustStore(path.join(root, 'trust.json'));
  const registry = new BrowserRecordingRegistry({ userDirectory, trustStore, builtins });
  return {
    root, workspace, projectDirectory, registry,
    userStore: new BrowserRecordingStore(userDirectory),
    projectStore: new BrowserRecordingStore(projectDirectory)
  };
}

describe('BrowserRecordingRegistry', () => {
  it('overlays project recordings over user recordings and reveals the user version after deletion', async () => {
    const value = await fixture([recording({ id: 'report', name: 'Builtin Report', scope: 'user' })]);
    try {
      await value.userStore.save(recording({ id: 'report', name: 'User Report', scope: 'user' }));
      await value.projectStore.save(recording({ id: 'report', name: 'Project Report', scope: 'project' }));

      const effective = await value.registry.get('report', value.workspace);
      expect(effective).toMatchObject({
        source: 'project', trust: 'untrusted', overriddenSources: ['builtin', 'user'],
        recording: { name: 'Project Report' }
      });
      await expect(value.registry.getExecutable('report', value.workspace))
        .rejects.toMatchObject({ code: 'browser_recording_untrusted' });

      await value.registry.delete('report', value.workspace);
      await expect(value.registry.get('report', value.workspace)).resolves.toMatchObject({
        source: 'user', recording: { name: 'User Report' }
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('trusts the exact project content hash and invalidates trust after a file edit', async () => {
    const value = await fixture();
    try {
      const saved = await value.projectStore.save(recording({ id: 'publish', name: 'Publish', scope: 'project' }));
      await value.registry.trustProject('publish', value.workspace);
      await expect(value.registry.getExecutable('publish', value.workspace)).resolves.toMatchObject({ trust: 'trusted' });

      await value.projectStore.save({ ...saved, description: 'changed' }, {
        expectedRevision: saved.revision,
        expectedHash: saved.contentHash
      });
      await expect(value.registry.getExecutable('publish', value.workspace))
        .rejects.toMatchObject({ code: 'browser_recording_untrusted' });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it('allows metadata-only project automations without trust and isolates symlinked files', async () => {
    const value = await fixture();
    try {
      await value.projectStore.save(recording({ id: 'wait-ready', name: 'Wait', scope: 'project', action: 'wait' }));
      await expect(value.registry.getExecutable('wait-ready', value.workspace)).resolves.toMatchObject({
        trust: 'untrusted', effectSummary: { highRisk: false }
      });

      const outside = path.join(value.root, 'outside.yaml');
      await writeFile(outside, stringifyBrowserRecording(recording({ id: 'linked', name: 'Linked', scope: 'project' })), 'utf8');
      await symlink(outside, path.join(value.projectDirectory, 'linked.yaml'));
      expect((await value.registry.list(value.workspace)).map((entry) => entry.recording.id)).not.toContain('linked');
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});

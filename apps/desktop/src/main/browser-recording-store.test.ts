import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateBrowserRecording } from '@desktop-agent/contracts';
import { BrowserRecordingStore, parseBrowserRecordingYaml, stringifyBrowserRecording } from './browser-recording-store';
import { applyRecordingParams, browserSecretEnvName, listedRecordingParams, secretEnvValues } from './browser-recording-params';

const legacyDocument = {
  version: 1 as const,
  id: 'github-search',
  name: 'GitHub Search',
  createdAt: '2026-08-15T00:00:00.000Z',
  params: [{ name: 'keyword', type: 'string' as const, secret: false }],
  steps: [
    { action: 'open' as const, url: 'https://github.com' },
    { action: 'type' as const, selector: 'input[name="q"]', text: '{{keyword}}', fingerprint: { tag: 'input', fieldName: 'q' } },
    { action: 'press' as const, key: 'Enter' }
  ]
};

const document = migrateBrowserRecording(legacyDocument);

describe('browser recording store', () => {
  it('writes V2 YAML with a canonical hash and persists across store instances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-recordings-'));
    const store = new BrowserRecordingStore(directory);
    const saved = await store.save(document);
    const yaml = await readFile(path.join(directory, 'github-search.yaml'), 'utf8');
    expect(yaml).toContain('version: 2');
    expect(yaml).toContain('contentHash: sha256:');
    expect(parseBrowserRecordingYaml(yaml).steps).toHaveLength(3);
    expect(stringifyBrowserRecording(saved)).toContain('selector: input[name="q"]');
    await expect(new BrowserRecordingStore(directory).get('github-search')).resolves.toMatchObject({
      id: 'github-search', name: 'GitHub Search', revision: 1
    });
    expect((await new BrowserRecordingStore(directory).get('github-search')).steps.map((step) => step.action))
      .toEqual(['navigate', 'type', 'press']);
    expect(await store.allocateId('GitHub Search')).toBe('github-search-2');
    await store.delete('github-search');
    await expect(store.list()).resolves.toEqual([]);
  });

  it('migrates V1 YAML and rejects unknown versions', () => {
    const yaml = stringifyBrowserRecording(document);
    expect(parseBrowserRecordingYaml(yaml)).toMatchObject({ version: 2, revision: 1 });
    expect(parseBrowserRecordingYaml('id: x\nname: X\ncreatedAt: "2026-08-15T00:00:00.000Z"\nsteps: []\n'))
      .toMatchObject({ version: 2, id: 'x' });
    expect(() => parseBrowserRecordingYaml('version: 9\nid: x\nname: X\ncreatedAt: "2026-08-15T00:00:00.000Z"\nsteps: []\n'))
      .toThrow(/Unsupported browser recording version/u);
  });

  it('rejects stale revision writes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-recordings-'));
    const store = new BrowserRecordingStore(directory);
    const saved = await store.save(document);
    const updated = await store.save({ ...saved, description: 'updated' }, {
      expectedRevision: saved.revision,
      expectedHash: saved.contentHash
    });
    expect(updated.revision).toBe(2);
    await expect(store.save(saved, { expectedRevision: saved.revision, expectedHash: saved.contentHash }))
      .rejects.toMatchObject({ code: 'browser_recording_revision_conflict' });
  });

  it('detects persisted content tampering', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-recordings-'));
    const store = new BrowserRecordingStore(directory);
    await store.save(document);
    const file = path.join(directory, 'github-search.yaml');
    const yaml = await readFile(file, 'utf8');
    await writeFile(file, yaml.replace('name: GitHub Search', 'name: Tampered'), 'utf8');
    await expect(store.get('github-search')).rejects.toMatchObject({ code: 'browser_recording_invalid' });
  });
});

describe('browser recording params', () => {
  it('substitutes declared params and keeps secrets out of model args', () => {
    const passwordStep = migrateBrowserRecording({
      ...legacyDocument,
      id: 'with-secret',
      params: [
        { name: 'keyword', type: 'string', secret: false },
        { name: 'password', type: 'string', secret: true }
      ],
      steps: [...legacyDocument.steps, { action: 'type', selector: '#pw', text: '{{password}}' }]
    });
    expect(listedRecordingParams(passwordStep.steps, passwordStep.params).map((param) => param.name))
      .toEqual(['keyword', 'password']);
    expect(applyRecordingParams(document.steps[1]!, document, { keyword: 'jojo-agent' }, {}).value)
      .toBe('jojo-agent');
    expect(() => applyRecordingParams(passwordStep.steps[3]!, passwordStep, { keyword: 'x', password: 'secret' }, {}))
      .toThrow(/cannot be supplied by the model/u);
    expect(applyRecordingParams(passwordStep.steps[3]!, passwordStep, { keyword: 'x' }, { password: 'from-env' }).value)
      .toBe('from-env');
    expect(browserSecretEnvName('password')).toBe('JOJO_BROWSER_SECRET_PASSWORD');
    expect(secretEnvValues(passwordStep.params, { JOJO_BROWSER_SECRET_PASSWORD: 'env-secret' }))
      .toEqual({ password: 'env-secret' });
  });
});

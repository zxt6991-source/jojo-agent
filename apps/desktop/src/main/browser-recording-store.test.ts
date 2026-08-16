import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserRecordingStore, parseBrowserRecordingYaml, stringifyBrowserRecording } from './browser-recording-store';
import { applyRecordingParams, browserSecretEnvName, listedRecordingParams, secretEnvValues } from './browser-recording-params';

const document = {
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

describe('browser recording store', () => {
  it('round-trips YAML and persists across store instances', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'jojo-recordings-'));
    const store = new BrowserRecordingStore(directory);
    const saved = await store.save(document);
    const yaml = await readFile(path.join(directory, 'github-search.yaml'), 'utf8');
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('id: github-search');
    expect(parseBrowserRecordingYaml(yaml).steps).toHaveLength(3);
    expect(stringifyBrowserRecording(saved)).toContain('selector: input[name="q"]');
    await expect(new BrowserRecordingStore(directory).get('github-search')).resolves.toMatchObject({
      id: 'github-search', name: 'GitHub Search'
    });
    expect((await new BrowserRecordingStore(directory).get('github-search')).steps.map((step) => step.action))
      .toEqual(['open', 'type', 'press']);
    expect(await store.allocateId('GitHub Search')).toBe('github-search-2');
    await store.delete('github-search');
    await expect(store.list()).resolves.toEqual([]);
  });

  it('rejects unknown versions and duplicate params', () => {
    expect(() => parseBrowserRecordingYaml('version: 9\nid: x\nname: X\ncreatedAt: "2026-08-15T00:00:00.000Z"\nsteps: []\n'))
      .toThrow(/Unsupported browser recording version/u);
  });
});

describe('browser recording params', () => {
  it('substitutes declared params and infers missing template names', () => {
    const withSecret = {
      ...document,
      params: [
        { name: 'keyword', type: 'string' as const, secret: false },
        { name: 'password', type: 'string' as const, secret: true }
      ],
      steps: [...document.steps, { action: 'type' as const, selector: '#pw', text: '{{password}}' }]
    };
    expect(listedRecordingParams(withSecret.steps, withSecret.params).map((param) => param.name))
      .toEqual(['keyword', 'password']);
    expect(applyRecordingParams(document.steps[1]!, document, { keyword: 'jojo-agent' }, {}).text)
      .toBe('jojo-agent');
    expect(() => applyRecordingParams(withSecret.steps[3]!, withSecret, { keyword: 'x', password: 'secret' }, {}))
      .toThrow(/cannot be supplied by the model/u);
    expect(applyRecordingParams(withSecret.steps[3]!, withSecret, { keyword: 'x' }, { password: 'from-env' }).text)
      .toBe('from-env');
    expect(browserSecretEnvName('password')).toBe('JOJO_BROWSER_SECRET_PASSWORD');
    expect(secretEnvValues(withSecret.params, { JOJO_BROWSER_SECRET_PASSWORD: 'env-secret' }))
      .toEqual({ password: 'env-secret' });
  });
});

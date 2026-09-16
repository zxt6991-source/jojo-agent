import { expect, it } from 'vitest';
import type { ArtifactContentInfoV2 } from '@desktop-agent/contracts';
import { ArtifactRequestGeneration, artifactContentReducer as reduce, canSaveArtifact, initialArtifactState, loadArtifactValue } from './artifact-content-state';
const hash = 'a'.repeat(64);
const info: ArtifactContentInfoV2 = { schemaVersion: 2, sessionId: 's', artifactId: 'a', name: 'a.txt', mimeType: 'text/plain', storageType: 'workspace', recordedVersion: 1, currentRevision: hash, etag: `"${hash}"`, size: 1, checkedAt: new Date().toISOString(), recordedState: 'recorded-revision-unknown' };
const loaded = loadArtifactValue({ info, delivery: 'content', data: 'QQ==' }, undefined, false)!;
it('ignores late successes and errors from previous reads', () => {
  const a = reduce(initialArtifactState, { type: 'read', requestId: 1 });
  const b = reduce(a, { type: 'read', requestId: 2 });
  expect(reduce(b, { type: 'loaded', requestId: 1, loaded })).toBe(b);
  expect(reduce(b, { type: 'failure', requestId: 1, error: 'IO_ERROR' })).toBe(b);
  expect(canSaveArtifact(b)).toBe(false);
});
it('refresh retains the preview, updates only info for not-modified, and marks failures stale', () => {
  const ready = reduce(reduce(initialArtifactState, { type: 'read', requestId: 1 }), { type: 'loaded', requestId: 1, loaded });
  expect(canSaveArtifact(ready)).toBe(true);
  const refreshing = reduce(ready, { type: 'read', requestId: 2 });
  expect(canSaveArtifact(refreshing)).toBe(false);
  expect(refreshing).toMatchObject({ loaded, refreshing: true });
  const next = loadArtifactValue({ info: { ...info, checkedAt: '2026-09-16T01:00:00.000Z' }, delivery: 'not-modified' }, loaded, false)!;
  expect(next.text).toBe(loaded.text); expect(next.info.checkedAt).not.toBe(info.checkedAt);
  const stale = reduce(refreshing, { type: 'failure', requestId: 2, error: 'CONTENT_MISSING' });
  expect(stale).toMatchObject({ phase: 'stale', loaded }); expect(canSaveArtifact(stale)).toBe(false);
  expect(reduce(reduce(stale, { type: 'read', requestId: 3 }), { type: 'loaded', requestId: 3, loaded: next })).toMatchObject({ phase: 'ready', loaded: next });
});
it('requires a matching session, artifact and revision cache for not-modified', () => {
  expect(loadArtifactValue({ info, delivery: 'not-modified' }, undefined, false)).toBeUndefined();
  for (const changed of [{ sessionId: 'other' }, { artifactId: 'other' }, { currentRevision: 'b'.repeat(64) }]) {
    expect(loadArtifactValue({ info: { ...info, ...changed }, delivery: 'not-modified' }, loaded, false)).toBeUndefined();
  }
});
it('invalidates all outstanding callbacks on close or session switch', () => {
  const generation = new ArtifactRequestGeneration(); const first = generation.next();
  generation.invalidate(); expect(generation.isCurrent(first)).toBe(false);
  const second = generation.next(); expect(generation.isCurrent(second)).toBe(true);
});
it('blocks duplicate save and refresh while saving and preserves the preview after conflicts', () => {
  const ready = reduce(reduce(initialArtifactState, { type: 'read', requestId: 1 }), { type: 'loaded', requestId: 1, loaded });
  const saving = reduce(ready, { type: 'saving', requestId: 1 });
  expect(canSaveArtifact(saving)).toBe(false);
  expect(reduce(saving, { type: 'saving', requestId: 1 })).toBe(saving);
  expect(reduce(saving, { type: 'read', requestId: 2 })).toBe(saving);
  expect(reduce(saving, { type: 'saved', requestId: 1, notice: '', error: 'REVISION_MISMATCH' })).toMatchObject({ phase: 'stale', loaded, saving: false });
});

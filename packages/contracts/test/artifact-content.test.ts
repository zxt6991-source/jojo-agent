import { expect, it } from 'vitest';
import { ArtifactContentInfoV2Schema, ArtifactReadRequestV2Schema, ArtifactReadResponseV2Schema, ArtifactSaveRequestV2Schema, MAX_ARTIFACT_BYTES } from '../src';

const revision = 'a'.repeat(64);
const target = { schemaVersion: 2, sessionId: 's', artifactId: 'a' };
const info = { ...target, name: 'a.txt', mimeType: 'text/plain', storageType: 'workspace', recordedVersion: 1,
  currentRevision: revision, etag: `"${revision}"`, size: 1, checkedAt: new Date().toISOString(), recordedState: 'recorded-revision-unknown' };
it('requires strict V2 targets, strong revisions and consistent metadata', () => {
  expect(ArtifactSaveRequestV2Schema.safeParse(target).success).toBe(false);
  for (const expectedRevision of ['x', revision.toUpperCase(), `"${revision}"`]) expect(ArtifactSaveRequestV2Schema.safeParse({ ...target, expectedRevision }).success).toBe(false);
  expect(ArtifactSaveRequestV2Schema.safeParse({ ...target, expectedRevision: revision, path: '/tmp/a' }).success).toBe(false);
  expect(ArtifactReadRequestV2Schema.safeParse({ ...target, representation: 'metadata' }).success).toBe(true);
  expect(ArtifactContentInfoV2Schema.safeParse(info).success).toBe(true);
  for (const etag of [`W/"${revision}"`, revision, `"${'b'.repeat(64)}"`]) expect(ArtifactContentInfoV2Schema.safeParse({ ...info, etag }).success).toBe(false);
  expect(ArtifactContentInfoV2Schema.safeParse({ ...info, recordedState: 'matches-recorded' }).success).toBe(false);
});
it('bounds actual bytes and Base64, including empty content', () => {
  const response = (data: string, size: number) => ({ ok: true, value: { delivery: 'content', info: { ...info, size }, data } });
  expect(ArtifactReadResponseV2Schema.safeParse(response('', 0)).success).toBe(true);
  expect(ArtifactReadResponseV2Schema.safeParse(response('YQ==', 1)).success).toBe(true);
  for (const data of ['YQ=', 'Y===', '!!!!', '=AAA']) expect(ArtifactReadResponseV2Schema.safeParse(response(data, 1)).success).toBe(false);
  expect(ArtifactReadResponseV2Schema.safeParse(response('YQ==', 2)).success).toBe(false);
  expect(ArtifactReadResponseV2Schema.safeParse(response(Buffer.alloc(MAX_ARTIFACT_BYTES).toString('base64'), MAX_ARTIFACT_BYTES)).success).toBe(true);
  expect(ArtifactReadResponseV2Schema.safeParse(response(Buffer.alloc(MAX_ARTIFACT_BYTES + 1).toString('base64'), MAX_ARTIFACT_BYTES)).success).toBe(false);
});

import { z } from 'zod';
import { MAX_ARTIFACT_BYTES } from './artifact';

export const ArtifactRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const ArtifactETagSchema = z.string().regex(/^"[a-f0-9]{64}"$/u);
export type Revision = z.infer<typeof ArtifactRevisionSchema>;
export const ArtifactTargetV2Schema = z.object({
  schemaVersion: z.literal(2), sessionId: z.string().min(1).max(256), artifactId: z.string().min(1).max(4096)
}).strict();
export const ArtifactReadRequestV2Schema = ArtifactTargetV2Schema.extend({
  representation: z.enum(['content', 'metadata']), knownRevision: ArtifactRevisionSchema.optional()
}).strict();
export const ArtifactSaveRequestV2Schema = ArtifactTargetV2Schema.extend({ expectedRevision: ArtifactRevisionSchema }).strict();
export const ArtifactContentInfoV2Schema = ArtifactTargetV2Schema.extend({
  name: z.string().min(1).max(255), mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/u),
  storageType: z.enum(['workspace', 'conversation']), recordedVersion: z.number().int().positive(),
  recordedRevision: ArtifactRevisionSchema.optional(), currentRevision: ArtifactRevisionSchema,
  etag: ArtifactETagSchema, size: z.number().int().min(0).max(MAX_ARTIFACT_BYTES), checkedAt: z.string().datetime(),
  recordedState: z.enum(['matches-recorded', 'changed-since-recorded', 'recorded-revision-unknown'])
}).strict().refine((info) => info.etag === `"${info.currentRevision}"` && info.recordedState === (
  !info.recordedRevision ? 'recorded-revision-unknown' : info.recordedRevision === info.currentRevision ? 'matches-recorded' : 'changed-since-recorded'
), 'Inconsistent content identity');
export const ArtifactErrorCodeSchema = z.enum([
  'INVALID_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONTENT_MISSING', 'CONTENT_TOO_LARGE',
  'CONTENT_UNSTABLE', 'REVISION_MISMATCH', 'EXPORT_BUSY', 'EXPORT_TARGET_IS_SOURCE', 'WRITE_FAILED', 'IO_ERROR'
]);
export const ArtifactFailureV2Schema = z.object({ ok: z.literal(false), error: z.object({
  code: ArtifactErrorCodeSchema, retryable: z.boolean(), currentRevision: ArtifactRevisionSchema.optional()
}).strict() }).strict();
export const MAX_ARTIFACT_BASE64_LENGTH = 4 * Math.ceil(MAX_ARTIFACT_BYTES / 3);
const base64 = z.string().max(MAX_ARTIFACT_BASE64_LENGTH).refine((data) => {
  if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(data)) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if (data.slice(0, data.length - padding).includes('=')) return false;
  return data.length / 4 * 3 - padding <= MAX_ARTIFACT_BYTES;
}, 'Invalid or oversized Base64');
export const ArtifactReadValueV2Schema = z.discriminatedUnion('delivery', [
  z.object({ info: ArtifactContentInfoV2Schema, delivery: z.literal('content'), data: base64 }).strict().refine(
    ({ info, data }) => info.size === data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0), 'Incorrect byte size'),
  z.object({ info: ArtifactContentInfoV2Schema, delivery: z.literal('metadata') }).strict(),
  z.object({ info: ArtifactContentInfoV2Schema, delivery: z.literal('not-modified') }).strict()
]);
export const ArtifactReadResponseV2Schema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: ArtifactReadValueV2Schema }).strict(), ArtifactFailureV2Schema
]);
export const ArtifactSaveResponseV2Schema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.discriminatedUnion('canceled', [
    z.object({ canceled: z.literal(true) }).strict(),
    z.object({ canceled: z.literal(false), path: z.string().min(1), savedRevision: ArtifactRevisionSchema,
      size: z.number().int().min(0).max(MAX_ARTIFACT_BYTES) }).strict()
  ]) }).strict(), ArtifactFailureV2Schema
]);
export type ArtifactTargetV2 = z.infer<typeof ArtifactTargetV2Schema>;
export type ArtifactReadRequestV2 = z.infer<typeof ArtifactReadRequestV2Schema>;
export type ArtifactSaveRequestV2 = z.infer<typeof ArtifactSaveRequestV2Schema>;
export type ArtifactContentInfoV2 = z.infer<typeof ArtifactContentInfoV2Schema>;
export type ArtifactReadValueV2 = z.infer<typeof ArtifactReadValueV2Schema>;
export type ArtifactErrorCode = z.infer<typeof ArtifactErrorCodeSchema>;
export type ArtifactFailureV2 = z.infer<typeof ArtifactFailureV2Schema>;
export type ArtifactReadResponseV2 = z.infer<typeof ArtifactReadResponseV2Schema>;
export type ArtifactSaveResponseV2 = z.infer<typeof ArtifactSaveResponseV2Schema>;

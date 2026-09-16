import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { artifactsFromMessages, classifyArtifact, MAX_ARTIFACT_BYTES, ArtifactDescriptorSchema, type ArtifactDescriptor, type Message, ArtifactRevisionSchema, ArtifactETagSchema, type ArtifactContentInfoV2, type ArtifactErrorCode, type ArtifactFailureV2, type ArtifactReadRequestV2, type ArtifactReadValueV2 } from '@desktop-agent/contracts';
import { resolveWorkspacePath } from './workspace-paths.js';

/** Both the producer and content reader revalidate canonical paths and bound actual reads. */
async function readWorkspaceArtifact(root: string, requested: string): Promise<{ target: string; bytes: Buffer; dev: number; ino: number; root: string }> {
  const resolved = await resolveWorkspacePath(root, requested);
  if (!resolved.inside) throw new ArtifactContentError('FORBIDDEN', 'Artifact is outside the session workspace.');
  const file = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ArtifactContentError('FORBIDDEN', 'Artifact must be a regular file.');
    if (info.size > MAX_ARTIFACT_BYTES) throw new ArtifactContentError('CONTENT_TOO_LARGE', 'Artifact exceeds the 20 MiB limit.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_ARTIFACT_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const current = await resolveWorkspacePath(root, requested);
    if (!current.inside || current.root !== resolved.root || current.target !== resolved.target) throw new ArtifactContentError('CONTENT_UNSTABLE', 'Artifact path changed during reading.');
    const currentInfo = await stat(current.target);
    const finalInfo = await file.stat();
    if (length !== info.size || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino
      || currentInfo.size !== info.size || currentInfo.mtimeMs !== info.mtimeMs || currentInfo.ctimeMs !== info.ctimeMs
      || finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs || finalInfo.ctimeMs !== info.ctimeMs) {
      throw new ArtifactContentError('CONTENT_UNSTABLE', 'Artifact changed during reading. Try again.');
    }
    return { target: resolved.target, root: resolved.root, dev: info.dev, ino: info.ino, bytes: bytes.subarray(0, length) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new ArtifactContentError('CONTENT_UNSTABLE', 'Artifact disappeared during reading.', { cause: error });
    }
    throw error;
  } finally { await file.close(); }
}
export const artifactRevision = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function produceWorkspaceArtifact(root: string, requested: string, source: ArtifactDescriptor['source'], title?: string): Promise<ArtifactDescriptor> {
  const { target, bytes } = await readWorkspaceArtifact(root, requested);
  const name = path.basename(target);
  return ArtifactDescriptorSchema.parse({
    id: `artifact_${createHash('sha256').update(target).digest('hex')}`, name, ...classifyArtifact(name), source,
    storage: { type: 'workspace', path: target }, size: bytes.length, version: 1,
    metadata: { revision: artifactRevision(bytes), ...(title ? { title } : {}) },
    security: { originalTrusted: false, previewSanitized: false }
  });
}
export async function readSessionArtifact(messages: readonly Message[], root: string, artifactId: string): Promise<{ artifact: ArtifactDescriptor; bytes: Buffer; etag: string }> {
  const artifact = artifactsFromMessages(messages).find((item) => item.id === artifactId);
  if (!artifact) throw new Error('Artifact not found in this session.');
  const bytes = artifact.storage.type === 'conversation' ? Buffer.from(artifact.storage.content, 'utf8')
    : (await readWorkspaceArtifact(root, artifact.storage.path)).bytes;
  return { artifact, bytes, etag: `"${artifactRevision(bytes)}"` };
}

export class ArtifactContentError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string = code, options?: ErrorOptions, readonly currentRevision?: string) {
    super(message, options); this.name = 'ArtifactContentError';
  }
}
export function artifactFailure(error: unknown): ArtifactFailureV2 {
  const typed = error instanceof ArtifactContentError ? error : new ArtifactContentError('IO_ERROR', 'Artifact I/O failed.', { cause: error });
  return { ok: false, error: { code: typed.code,
    retryable: ['CONTENT_UNSTABLE', 'REVISION_MISMATCH', 'EXPORT_BUSY', 'WRITE_FAILED', 'IO_ERROR'].includes(typed.code),
    ...(typed.currentRevision ? { currentRevision: typed.currentRevision } : {}) } };
}
export function requireArtifact(messages: readonly Message[], artifactId: string): ArtifactDescriptor {
  const artifact = artifactsFromMessages(messages).find((item) => item.id === artifactId);
  if (!artifact) throw new ArtifactContentError('NOT_FOUND');
  return artifact;
}
export function assertArtifactRevision(currentRevision: string, expectedRevision: string): void {
  if (currentRevision !== expectedRevision) throw new ArtifactContentError('REVISION_MISMATCH', 'Artifact revision changed.', undefined, currentRevision);
}
/** Deliberately accepts exactly one SHA-256 strong ETag, not general HTTP match lists. */
export function parseArtifactIfMatch(value: unknown): string {
  const parsed = ArtifactETagSchema.safeParse(value);
  if (!parsed.success) throw new ArtifactContentError('INVALID_REQUEST');
  return parsed.data.slice(1, -1);
}
export interface ArtifactContentRead {
  descriptor: ArtifactDescriptor;
  info: ArtifactContentInfoV2;
  bytes: Buffer;
  source?: { target: string; root: string; dev: number; ino: number };
}
// Bound simultaneous Buffers without retaining an unbounded queue of pending requests.
let activeContentReads = 0;
export async function readSessionArtifactV2(messages: readonly Message[], root: string | undefined, sessionId: string, artifactId: string): Promise<ArtifactContentRead> {
  const descriptor = requireArtifact(messages, artifactId);
  if (descriptor.storage.type === 'workspace' && !root) throw new ArtifactContentError('FORBIDDEN');
  if (activeContentReads >= 4) throw new ArtifactContentError('CONTENT_UNSTABLE');
  activeContentReads++;
  try {
    let bytes: Buffer;
    let source: ArtifactContentRead['source'];
    if (descriptor.storage.type === 'conversation') {
      bytes = Buffer.from(descriptor.storage.content, 'utf8');
    } else {
      const read = await readWorkspaceArtifact(root!, descriptor.storage.path);
      bytes = read.bytes;
      source = { target: read.target, root: read.root, dev: read.dev, ino: read.ino };
    }
    if (bytes.length > MAX_ARTIFACT_BYTES) throw new ArtifactContentError('CONTENT_TOO_LARGE');
    const currentRevision = artifactRevision(bytes);
    const recorded = ArtifactRevisionSchema.safeParse(descriptor.metadata?.revision);
    const recordedRevision = descriptor.storage.type === 'conversation' ? currentRevision : recorded.success ? recorded.data : undefined;
    const info: ArtifactContentInfoV2 = {
      schemaVersion: 2, sessionId, artifactId, name: descriptor.name, mimeType: descriptor.mimeType,
      storageType: descriptor.storage.type, recordedVersion: descriptor.version,
      ...(recordedRevision ? { recordedRevision } : {}), currentRevision, etag: `"${currentRevision}"`,
      size: bytes.length, checkedAt: new Date().toISOString(), recordedState: !recordedRevision ? 'recorded-revision-unknown'
        : recordedRevision === currentRevision ? 'matches-recorded' : 'changed-since-recorded'
    };
    return { descriptor, info, bytes, ...(source ? { source } : {}) };
  } catch (error) {
    if (error instanceof ArtifactContentError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new ArtifactContentError(code === 'ENOENT' ? 'CONTENT_MISSING'
      : ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(code ?? '') ? 'FORBIDDEN' : 'IO_ERROR', undefined, { cause: error });
  } finally { activeContentReads--; }
}
export function artifactReadValue(result: ArtifactContentRead, request: ArtifactReadRequestV2): ArtifactReadValueV2 {
  if (request.knownRevision === result.info.currentRevision) return { info: result.info, delivery: 'not-modified' };
  return request.representation === 'metadata' ? { info: result.info, delivery: 'metadata' }
    : { info: result.info, delivery: 'content', data: result.bytes.toString('base64') };
}

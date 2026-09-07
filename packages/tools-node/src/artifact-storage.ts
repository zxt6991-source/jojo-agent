import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { artifactsFromMessages, classifyArtifact, MAX_ARTIFACT_BYTES, ArtifactDescriptorSchema, type ArtifactDescriptor, type Message } from '@desktop-agent/contracts';
import { resolveWorkspacePath } from './workspace-paths.js';

/** Both the producer and content reader revalidate canonical paths and bound actual reads. */
async function readWorkspaceArtifact(root: string, requested: string): Promise<{ target: string; bytes: Buffer }> {
  const resolved = await resolveWorkspacePath(root, requested);
  if (!resolved.inside) throw new Error('Artifact is outside the session workspace.');
  const file = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Artifact must be a regular file.');
    if (info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 20 MiB limit.');
    const bytes = Buffer.alloc(Math.min(info.size + 1, MAX_ARTIFACT_BYTES + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const current = await resolveWorkspacePath(root, requested);
    if (!current.inside || current.target !== resolved.target) throw new Error('Artifact path changed during reading.');
    const currentInfo = await stat(current.target);
    const finalInfo = await file.stat();
    if (length !== info.size || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino
      || finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs || finalInfo.ctimeMs !== info.ctimeMs) {
      throw new Error('Artifact changed during reading. Try again.');
    }
    return { target: resolved.target, bytes: bytes.subarray(0, length) };
  } finally { await file.close(); }
}
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function produceWorkspaceArtifact(root: string, requested: string, source: ArtifactDescriptor['source'], title?: string): Promise<ArtifactDescriptor> {
  const { target, bytes } = await readWorkspaceArtifact(root, requested);
  const name = path.basename(target);
  return ArtifactDescriptorSchema.parse({
    id: `artifact_${createHash('sha256').update(target).digest('hex')}`, name, ...classifyArtifact(name), source,
    storage: { type: 'workspace', path: target }, size: bytes.length, version: 1,
    metadata: { revision: revision(bytes), ...(title ? { title } : {}) },
    security: { originalTrusted: false, previewSanitized: false }
  });
}
export async function readSessionArtifact(messages: readonly Message[], root: string, artifactId: string): Promise<{ artifact: ArtifactDescriptor; bytes: Buffer; etag: string }> {
  const artifact = artifactsFromMessages(messages).find((item) => item.id === artifactId);
  if (!artifact) throw new Error('Artifact not found in this session.');
  const bytes = artifact.storage.type === 'conversation' ? Buffer.from(artifact.storage.content, 'utf8')
    : (await readWorkspaceArtifact(root, artifact.storage.path)).bytes;
  return { artifact, bytes, etag: `"${revision(bytes)}"` };
}

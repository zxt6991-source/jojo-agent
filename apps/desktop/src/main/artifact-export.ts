import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactSaveRequestV2, ArtifactSaveResponseV2, ArtifactTargetV2, Message } from '@desktop-agent/contracts';
import { ArtifactContentError, artifactFailure, assertArtifactRevision, readSessionArtifactV2, requireArtifact, type ArtifactContentRead } from '@desktop-agent/tools-node';

type Authorization = { messages: readonly Message[]; workingDirectory?: string };
export interface ArtifactExportDependencies {
  authorize(target: ArtifactTargetV2): Promise<Authorization>;
  select(name: string): Promise<{ canceled: boolean; filePath?: string }>;
  write(destination: string, bytes: Buffer): Promise<void>;
}
async function rejectSourceTarget(destination: string, result: ArtifactContentRead): Promise<void> {
  if (!result.source) return;
  if (path.resolve(destination) === result.source.target) throw new ArtifactContentError('EXPORT_TARGET_IS_SOURCE');
  try {
    const canonical = await realpath(destination);
    const info = await stat(destination);
    if (canonical === result.source.target || (info.dev === result.source.dev && info.ino === result.source.ino)) {
      throw new ArtifactContentError('EXPORT_TARGET_IS_SOURCE');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    // A deleted source selected through a symlinked parent is still the source path.
    const parent = await realpath(path.dirname(destination));
    if (path.join(parent, path.basename(destination)) === result.source.target) throw new ArtifactContentError('EXPORT_TARGET_IS_SOURCE');
  }
}
/** One export per window. The successful revision check fixes the bytes before the dialog. */
export function createArtifactExporter(deps: ArtifactExportDependencies) {
  const busy = new Set<number>();
  return async (windowId: number, request: ArtifactSaveRequestV2): Promise<ArtifactSaveResponseV2> => {
    if (busy.has(windowId)) return artifactFailure(new ArtifactContentError('EXPORT_BUSY'));
    busy.add(windowId);
    try {
      const authorization = await deps.authorize(request);
      const result = await readSessionArtifactV2(authorization.messages, authorization.workingDirectory, request.sessionId, request.artifactId);
      assertArtifactRevision(result.info.currentRevision, request.expectedRevision);
      const selected = await deps.select(result.info.name);
      if (selected.canceled || !selected.filePath) return { ok: true, value: { canceled: true } };
      const current = await deps.authorize(request);
      const descriptor = requireArtifact(current.messages, request.artifactId);
      if (JSON.stringify(descriptor.storage) !== JSON.stringify(result.descriptor.storage)
        || (result.source && current.workingDirectory !== authorization.workingDirectory)) throw new ArtifactContentError('FORBIDDEN');
      if (result.source && await realpath(current.workingDirectory!) !== result.source.root) throw new ArtifactContentError('FORBIDDEN');
      await rejectSourceTarget(selected.filePath, result);
      try { await deps.write(selected.filePath, result.bytes); }
      catch (error) { throw new ArtifactContentError('WRITE_FAILED', undefined, { cause: error }); }
      return { ok: true, value: { canceled: false, path: selected.filePath, savedRevision: result.info.currentRevision, size: result.bytes.length } };
    } catch (error) { return artifactFailure(error); }
    finally { busy.delete(windowId); }
  };
}

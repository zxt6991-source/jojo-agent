import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AttachmentStore } from '@desktop-agent/attachments';
import type { FileAttachmentRef } from '@desktop-agent/contracts';
import type { AttachmentAccess, AttachmentAccessContext, AttachmentAccessResolver } from './index';

const execute = promisify(execFile);
export type ContainerCommand = (args: string[], signal?: AbortSignal) => Promise<string>;
export interface ContainerAttachmentOptions {
  containerId: string;
  /** Allows an embedding host to use its own Docker connection; default is local Docker CLI. */
  command?: ContainerCommand;
}
const unavailable = (): AttachmentAccess => ({ kind: 'unavailable', reason: 'ATTACHMENT_PROJECTION_FAILED' });
function within(base: string, target: string, posix = false): boolean {
  const relative = (posix ? path.posix : path).relative(base, target);
  return relative === '' || (!relative.startsWith('..' + (posix ? '/' : path.sep)) && relative !== '..' && !(posix ? path.posix : path).isAbsolute(relative));
}

/** Uses an existing read-only bind mount; never creates a mount or copies into a running container. */
export class ContainerAttachmentAccessResolver implements AttachmentAccessResolver {
  private readonly command: ContainerCommand;
  constructor(private readonly store: AttachmentStore, private readonly options: ContainerAttachmentOptions) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(options.containerId)) throw new Error('Invalid container ID');
    this.command = options.command ?? (async (args, signal) => {
      const result = await execute('docker', args, { timeout: 15_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
      return result.stdout;
    });
  }

  async resolve(ref: FileAttachmentRef, context: AttachmentAccessContext): Promise<AttachmentAccess> {
    context.signal?.throwIfAborted();
    try {
      const stored = await this.store.getPath(ref.attachmentId);
      if (!stored) return { kind: 'unavailable', reason: 'ATTACHMENT_NOT_FOUND' };
      const original = await realpath(stored);
      const inspected: unknown = JSON.parse(await this.command(['inspect', '--type', 'container', this.options.containerId], context.signal));
      if (!Array.isArray(inspected) || inspected.length !== 1) return unavailable();
      const container = inspected[0] as { State?: { Running?: boolean }; Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> };
      if (container.State?.Running !== true || !Array.isArray(container.Mounts)) return unavailable();
      const mounts = container.Mounts;
      for (const mount of mounts) {
        context.signal?.throwIfAborted();
        if (mount.Type !== 'bind' || mount.RW !== false || !mount.Source || !mount.Destination
          || !path.isAbsolute(mount.Source) || !path.posix.isAbsolute(mount.Destination)) continue;
        const source = await realpath(mount.Source);
        if (!within(source, original)) continue;
        const projected = path.posix.join(mount.Destination, path.relative(source, original).split(path.sep).join('/'));
        // Nested mounts can shadow this file with unrelated bytes, even if test -r succeeds.
        if (mounts.some((other) => other !== mount && other.Destination && within(mount.Destination!, other.Destination, true)
          && within(other.Destination, projected, true))) continue;
        await this.command(['exec', this.options.containerId, 'test', '-f', projected], context.signal);
        await this.command(['exec', this.options.containerId, 'test', '-r', projected], context.signal);
        const verified = await this.store.verify(ref.attachmentId, context.signal);
        const remoteHash = await this.command(['exec', this.options.containerId, 'sha256sum', '--', projected], context.signal);
        if (remoteHash.trim().split(/\s+/u)[0] !== verified.digest.slice(7)) return unavailable();
        context.signal?.throwIfAborted();
        return { kind: 'path', path: projected, readonly: true };
      }
      return unavailable();
    } catch {
      context.signal?.throwIfAborted();
      return unavailable();
    }
  }
}

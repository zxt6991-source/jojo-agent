import { LocalAttachmentStore, type AttachmentStore } from '@desktop-agent/attachments';
import type { FileAttachmentRef } from '@desktop-agent/contracts';
import type { AttachmentAccess, AttachmentAccessContext, AttachmentAccessResolver } from './index';

/** Explicit host wiring: never infer a local path in a provider or remote runtime. */
export class LocalAttachmentAccessResolver implements AttachmentAccessResolver {
  constructor(private readonly store: AttachmentStore = new LocalAttachmentStore()) {}

  async resolve(ref: FileAttachmentRef, context: AttachmentAccessContext): Promise<AttachmentAccess> {
    context.signal?.throwIfAborted();
    try {
      const path = await this.store.getPath(ref.attachmentId);
      context.signal?.throwIfAborted();
      return path
        ? { kind: 'path', path, readonly: true }
        : { kind: 'unavailable', reason: 'ATTACHMENT_NOT_FOUND' };
    } catch {
      context.signal?.throwIfAborted();
      return { kind: 'unavailable', reason: 'ATTACHMENT_ACCESS_UNAVAILABLE' };
    }
  }
}

import { randomUUID } from 'node:crypto';
import { LocalAttachmentStore, type AttachmentStore } from '@desktop-agent/attachments';
import { createDefaultAttachmentExtractorRegistry } from '@desktop-agent/attachment-extractors';
import type { FileAttachmentRef } from '@desktop-agent/contracts';
import type { AttachmentUploadReceipt, StartRunInput } from '@desktop-agent/server-protocol';
import { ProtocolFailure } from './errors';

export type UploadStreamInput = { name: string; stream: AsyncIterable<Uint8Array>; signal: AbortSignal; expectedBytes?: number };
export class AttachmentUploads {
  private readonly staged = new Map<string, { principal: string; session: string; ref: FileAttachmentRef; expiresAt: number }>();
  private active = 0;
  constructor(private readonly store: AttachmentStore = new LocalAttachmentStore(), private readonly now = () => Date.now()) {}
  private prune() {
    for (const [token, entry] of this.staged) if (entry.expiresAt <= this.now()) this.staged.delete(token);
  }
  async upload(principal: string, session: string, input: UploadStreamInput): Promise<AttachmentUploadReceipt> {
    this.prune();
    if (this.active >= 4 || this.staged.size + this.active >= 1000) throw new ProtocolFailure({ code: 'invalid_request', message: 'Attachment upload capacity exceeded; retry later.' });
    this.active++;
    try {
      const ref = await this.store.saveStream(input);
      let previewWarning: string | undefined;
      try {
        const preview = await createDefaultAttachmentExtractorRegistry().extract({ metadata: ref, openStream: () => this.store.openFile(ref.attachmentId), signal: input.signal });
        if (preview) ref.preview = preview;
      } catch {
        input.signal.throwIfAborted();
        previewWarning = 'Preview unavailable; original attachment saved.';
      }
      input.signal.throwIfAborted();
      const receipt = randomUUID();
      const expiresAt = this.now() + 60 * 60 * 1000;
      this.staged.set(receipt, { principal, session, ref: structuredClone(ref), expiresAt });
      return { receipt, attachment: ref, expiresAt: new Date(expiresAt).toISOString(), ...(previewWarning ? { previewWarning } : {}) };
    } catch (cause) {
      if (cause instanceof ProtocolFailure) throw cause;
      throw new ProtocolFailure({ code: 'invalid_request', message: input.signal.aborted ? 'Attachment upload cancelled.' : 'Attachment upload failed or exceeded size limits.' });
    } finally { this.active--; }
  }
  async resolve(principal: string, session: string, input: StartRunInput): Promise<StartRunInput> {
    this.prune();
    const content = [];
    for (const block of input.input.content) {
      if (block.type !== 'file') { content.push(block); continue; }
      const token = input.attachmentReceipts?.[block.attachment.attachmentId];
      const entry = token ? this.staged.get(token) : undefined;
      if (!entry || entry.principal !== principal || entry.session !== session || entry.ref.attachmentId !== block.attachment.attachmentId) {
        throw new ProtocolFailure({ code: 'invalid_request', message: 'Missing, expired, or mismatched attachment upload receipt.' });
      }
      if (!await this.store.exists(entry.ref.attachmentId)) throw new ProtocolFailure({ code: 'invalid_request', message: 'Uploaded attachment is no longer available.' });
      content.push({ type: 'file' as const, attachment: structuredClone(entry.ref) });
    }
    const request = { ...input };
    delete request.attachmentReceipts;
    return { ...request, input: { content } };
  }
}

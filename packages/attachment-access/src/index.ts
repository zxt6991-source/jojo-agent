import type { FileAttachmentRef, Message, ModelAttachmentDescriptor } from '@desktop-agent/contracts';

export interface AttachmentAccessContext {
  sessionId: string;
  workingDirectory?: string;
  executionId?: string;
  signal?: AbortSignal;
}

export type AttachmentAccess =
  | { kind: 'path'; path: string; readonly: boolean }
  | { kind: 'stream'; open(): Promise<NodeJS.ReadableStream> }
  | { kind: 'unavailable'; reason: string };

export interface AttachmentAccessResolver {
  resolve(ref: FileAttachmentRef, context: AttachmentAccessContext): Promise<AttachmentAccess>;
}

/** Request-scoped projection only. Never write execution paths into session messages. */
export async function resolveModelAttachments(
  messages: Message[],
  resolver: AttachmentAccessResolver | undefined,
  context: AttachmentAccessContext
): Promise<ModelAttachmentDescriptor[]> {
  const descriptors = new Map<string, ModelAttachmentDescriptor>();
  for (const message of messages) {
    for (const block of message.content) {
      context.signal?.throwIfAborted();
      if (block.type !== 'file' || descriptors.has(block.attachment.attachmentId)) continue;
      const ref = block.attachment;
      let access: AttachmentAccess = { kind: 'unavailable', reason: 'ATTACHMENT_ACCESS_UNAVAILABLE' };
      if (resolver) {
        try {
          // A resolver cannot mutate the durable message through its input reference.
          access = await resolver.resolve(structuredClone(ref), context);
        } catch {
          context.signal?.throwIfAborted();
          access = { kind: 'unavailable', reason: 'ATTACHMENT_PROJECTION_FAILED' };
        }
      }
      context.signal?.throwIfAborted();
      descriptors.set(ref.attachmentId, {
        attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes,
        ...(ref.preview ? { preview: { ...ref.preview } } : {}),
        access: access.kind === 'stream'
          ? { kind: 'unavailable', reason: 'ATTACHMENT_STREAM_REQUIRES_BRIDGE' }
          : access
      });
    }
  }
  return [...descriptors.values()];
}

import type { AttachmentId, AttachmentPreview } from '@desktop-agent/contracts';

export interface AttachmentMetadata {
  attachmentId: AttachmentId;
  name: string;
  bytes: number;
  extension?: string | undefined;
  mimeType?: string | undefined;
}

export interface AttachmentExtractInput {
  metadata: AttachmentMetadata;
  openStream(): Promise<NodeJS.ReadableStream>;
  getPath?(): Promise<string | undefined>;
  signal?: AbortSignal;
}

export interface AttachmentExtractor {
  id: string;
  priority?: number;
  supports(metadata: AttachmentMetadata): boolean;
  extract(input: AttachmentExtractInput): Promise<AttachmentPreview | undefined>;
}

export type AttachmentExtractionErrorCode =
  | 'ATTACHMENT_EXTRACT_FAILED'
  | 'ATTACHMENT_EXTRACT_TIMEOUT'
  | 'ATTACHMENT_CANCELLED';

export class AttachmentExtractionError extends Error {
  constructor(readonly code: AttachmentExtractionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AttachmentExtractionError';
  }
}

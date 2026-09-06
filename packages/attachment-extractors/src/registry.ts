import { AttachmentPreviewSchema, MAX_ATTACHMENT_PREVIEW_BYTES, MAX_ATTACHMENT_PREVIEW_TEXT, type AttachmentPreview } from '@desktop-agent/contracts';
import { AttachmentExtractionError, type AttachmentExtractInput, type AttachmentExtractor, type AttachmentMetadata } from './types';

/** Errors describe preview failure only; the registry never modifies the stored resource. */
export class AttachmentExtractorRegistry {
  private readonly extractors: AttachmentExtractor[] = [];

  constructor(private readonly timeoutMs = 30_000) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid extraction timeout');
  }

  register(extractor: AttachmentExtractor): void {
    if (!extractor.id || this.extractors.some((entry) => entry.id === extractor.id)) throw new Error(`Duplicate or empty extractor ID: ${extractor.id}`);
    if (!Number.isFinite(extractor.priority ?? 0)) throw new RangeError('Invalid extractor priority');
    this.extractors.push(extractor);
    // Stable sort preserves registration order for equal priorities.
    this.extractors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  find(metadata: AttachmentMetadata): AttachmentExtractor | undefined {
    return this.extractors.find((extractor) => extractor.supports(metadata));
  }

  async extract(input: AttachmentExtractInput): Promise<AttachmentPreview | undefined> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new AttachmentExtractionError('ATTACHMENT_CANCELLED', '附件预览已取消'));
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const extractor = this.find(input.metadata);
      if (!extractor || input.metadata.bytes > MAX_ATTACHMENT_PREVIEW_BYTES) return undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(new AttachmentExtractionError('ATTACHMENT_EXTRACT_TIMEOUT', '附件预览超时')), this.timeoutMs);
      });
      const preview = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return extractor.extract({ ...input, signal: controller.signal });
        }),
        interrupted
      ]);
      controller.signal.throwIfAborted();
      if (!preview) return undefined;
      const bounded = AttachmentPreviewSchema.parse({
        ...preview, extractor: extractor.id,
        text: preview.text.slice(0, MAX_ATTACHMENT_PREVIEW_TEXT),
        truncated: preview.truncated || preview.text.length > MAX_ATTACHMENT_PREVIEW_TEXT
      });
      return bounded.text.trim() ? bounded : undefined;
    } catch (cause) {
      if (cause instanceof AttachmentExtractionError) throw cause;
      throw new AttachmentExtractionError('ATTACHMENT_EXTRACT_FAILED', cause instanceof Error ? cause.message : String(cause), { cause });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', cancel);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    }
  }
}

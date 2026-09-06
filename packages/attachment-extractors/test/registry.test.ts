import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_PREVIEW_BYTES, MAX_ATTACHMENT_PREVIEW_TEXT } from '@desktop-agent/contracts';
import { AttachmentExtractorRegistry, createDefaultAttachmentExtractorRegistry, type AttachmentExtractInput, type AttachmentExtractor } from '../src';

const preview = { type: 'text' as const, extractor: 'test', text: 'hello', truncated: false };
function input(data = Buffer.from('hello'), extension = 'txt'): AttachmentExtractInput {
  return { metadata: { attachmentId: 'att_test', name: `test.${extension}`, extension, bytes: data.length }, openStream: async () => Readable.from([data]) };
}
function extractor(id: string, priority = 0): AttachmentExtractor {
  return { id, priority, supports: () => true, extract: async () => preview };
}

describe('attachment extractor registry', () => {
  it('selects highest priority, preserving registration order for ties', async () => {
    const registry = new AttachmentExtractorRegistry();
    registry.register(extractor('low'));
    registry.register(extractor('first', 10));
    registry.register(extractor('second', 10));
    expect(registry.find(input().metadata)?.id).toBe('first');
    expect((await registry.extract(input()))?.extractor).toBe('first');
    expect(() => registry.register(extractor('first'))).toThrow(/Duplicate/);
  });

  it('does not open unsupported or oversized resources', async () => {
    const registry = createDefaultAttachmentExtractorRegistry();
    const openStream = vi.fn(input().openStream);
    expect(await registry.extract({ ...input(Buffer.from('bin'), 'bin'), openStream })).toBeUndefined();
    expect(await registry.extract({ ...input(), metadata: { ...input().metadata, bytes: MAX_ATTACHMENT_PREVIEW_BYTES + 1 }, openStream })).toBeUndefined();
    expect(openStream).not.toHaveBeenCalled();
  });

  it('wraps extractor and selection errors with a stable preview error code', async () => {
    const registry = new AttachmentExtractorRegistry();
    const cause = new Error('broken parser');
    registry.register({ ...extractor('broken'), extract: async () => { throw cause; } });
    await expect(registry.extract(input())).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED', cause });
    const selection = new AttachmentExtractorRegistry();
    selection.register({ ...extractor('broken'), supports: () => { throw cause; } });
    await expect(selection.extract(input())).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
  });

  it('bounds plugin output and skips empty previews', async () => {
    const registry = new AttachmentExtractorRegistry();
    registry.register({ ...extractor('long'), extract: async () => ({ ...preview, text: 'x'.repeat(MAX_ATTACHMENT_PREVIEW_TEXT + 1) }) });
    const result = await registry.extract(input());
    expect(result?.text).toHaveLength(MAX_ATTACHMENT_PREVIEW_TEXT);
    expect(result?.truncated).toBe(true);
    expect(await createDefaultAttachmentExtractorRegistry().extract(input(Buffer.alloc(0)))).toBeUndefined();
  });

  it('rejects pre-cancellation without invoking the parser', async () => {
    const registry = new AttachmentExtractorRegistry();
    const extract = vi.fn(async () => preview);
    registry.register({ ...extractor('test'), extract });
    await expect(registry.extract({ ...input(), signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('cancels a stalled stream and destroys it', async () => {
    const controller = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => { opened = resolve; });
    const stream = new Readable({ read() { opened(); } });
    const result = createDefaultAttachmentExtractorRegistry().extract({ ...input(), signal: controller.signal, openStream: async () => stream });
    const rejection = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
    await ready;
    controller.abort();
    await rejection;
    expect(stream.destroyed).toBe(true);
  });

  it('times out stalled parsers and propagates cancellation to them', async () => {
    const registry = new AttachmentExtractorRegistry(10);
    let signal: AbortSignal | undefined;
    registry.register({ ...extractor('stalled'), extract: async (request) => {
      signal = request.signal;
      return new Promise(() => {});
    } });
    await expect(registry.extract(input())).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });

  it('cleans up a stream that opens after cancellation', async () => {
    const controller = new AbortController();
    let release!: (stream: Readable) => void;
    const pending = new Promise<Readable>((resolve) => { release = resolve; });
    const openStream = vi.fn(() => pending);
    const result = createDefaultAttachmentExtractorRegistry().extract({ ...input(), signal: controller.signal, openStream });
    const rejection = expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_CANCELLED' });
    await vi.waitFor(() => expect(openStream).toHaveBeenCalled());
    controller.abort();
    await rejection;
    const stream = Readable.from([Buffer.from('late')]);
    release(stream);
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
  });

  it('enforces actual byte limits even when metadata understates the size', async () => {
    const stream = Readable.from([Buffer.alloc(MAX_ATTACHMENT_PREVIEW_BYTES), Buffer.from('x')]);
    await expect(createDefaultAttachmentExtractorRegistry().extract({ ...input(), openStream: async () => stream })).rejects.toMatchObject({ code: 'ATTACHMENT_EXTRACT_FAILED' });
    expect(stream.destroyed).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import { BrowserRecordingDocumentSchema, type BrowserRecordingDocument } from '@desktop-agent/contracts';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== 'contentHash')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

export function browserRecordingContentHash(document: BrowserRecordingDocument): string {
  const canonical = JSON.stringify(canonicalize(document));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function finalizeBrowserRecording(document: BrowserRecordingDocument): BrowserRecordingDocument {
  const parsed = BrowserRecordingDocumentSchema.parse(document);
  return BrowserRecordingDocumentSchema.parse({ ...parsed, contentHash: browserRecordingContentHash(parsed) });
}

export function hasValidBrowserRecordingHash(document: BrowserRecordingDocument): boolean {
  return document.contentHash === browserRecordingContentHash(document);
}

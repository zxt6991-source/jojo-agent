import { createHash } from 'node:crypto';
import { MessageSchema, type Message } from '@desktop-agent/contracts';

export const LEGACY_TRANSCRIPT_CUTOVER = 'legacy-jsonl-main-cutover-v1';
export const LEGACY_TRANSCRIPT_MIGRATION = 'legacy-jsonl-main-v1';
export type LegacyTranscriptMigration = {
  migrationId: string;
  sessionId: string;
  sourceHash: string;
  importedHash: string;
  sourceCount: number;
  importedCount: number;
  retainedCount: number;
  completedAt: number;
};
export type LegacyTranscriptImportResult = {
  status: 'imported' | 'unchanged' | 'busy';
  importedCount: number;
  retainedCount: number;
  sourceHash: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function transcriptHash(messages: readonly Message[]): string {
  return createHash('sha256').update(canonical(messages)).digest('hex');
}
export function validateLegacyTranscript(messages: readonly Message[]): Message[] {
  const ids = new Map<string, Message>();
  for (const value of messages) {
    const message = MessageSchema.parse(value);
    const previous = ids.get(message.id);
    if (previous && transcriptHash([previous]) !== transcriptHash([message])) {
      throw new Error(`legacy_message_conflict: ${message.id}`);
    }
    // Identical repeated JSONL records are safe to collapse while preserving order.
    if (!previous) ids.set(message.id, message);
  }
  return [...ids.values()];
}

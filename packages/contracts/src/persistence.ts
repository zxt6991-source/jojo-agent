import { z } from 'zod';
import { MessageSchema } from './messages';

export const DEFAULT_SESSION_TITLE = '新会话';
export const SESSION_TITLE_MAX_LENGTH = 120;

export function projectNameFromDirectory(workingDirectory: string): string {
  return workingDirectory.split(/[\\/]/).filter(Boolean).pop() ?? workingDirectory;
}

export function isPlaceholderSessionTitle(title: string, workingDirectory: string): boolean {
  return title === DEFAULT_SESSION_TITLE || title === projectNameFromDirectory(workingDirectory);
}

export function sessionTitleFromPrompt(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ');
  let title = '';
  for (const character of normalized) {
    if (title.length + character.length > SESSION_TITLE_MAX_LENGTH) break;
    title += character;
  }
  return title;
}

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(SESSION_TITLE_MAX_LENGTH),
  workingDirectory: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const SessionRecordSchema = z.discriminatedUnion('type', [
  z.object({ schemaVersion: z.literal(1), type: z.literal('meta'), session: SessionMetaSchema }),
  z.object({ schemaVersion: z.literal(1), type: z.literal('message'), message: MessageSchema }),
  z.object({ schemaVersion: z.literal(1), type: z.literal('title'), title: z.string() })
]);
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const ProviderSettingsSchema = z.object({
  baseUrl: z.string().url().default('https://api.openai.com/v1'),
  model: z.string().min(1).default('gpt-5-mini'),
  models: z.array(z.string().trim().min(1)).min(1).default(['gpt-5-mini']),
  hasApiKey: z.boolean().default(false)
});
export type ProviderSettings = z.infer<typeof ProviderSettingsSchema>;

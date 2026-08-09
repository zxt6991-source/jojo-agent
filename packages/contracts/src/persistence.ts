import { z } from 'zod';
import { MessageSchema } from './messages';

export const SessionMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
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

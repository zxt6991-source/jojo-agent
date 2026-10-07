import { z } from 'zod';
import { DEFAULT_SESSION_TITLE, SESSION_TITLE_MAX_LENGTH, SessionMetaSchema } from '../persistence.js';

const sessionId = z.string().min(1).max(256);
const title = z.string().trim().min(1).max(SESSION_TITLE_MAX_LENGTH);
const workingDirectory = z.string().min(1).max(4096);
export const SessionMetadataOperationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('get'), sessionId }).strict(),
  z.object({ action: z.literal('create'), title: title.default(DEFAULT_SESSION_TITLE), workingDirectory: workingDirectory.optional() }).strict(),
  z.object({ action: z.literal('rename'), sessionId, title }).strict(),
  z.object({ action: z.literal('bindProject'), sessionId, workingDirectory }).strict(),
  z.object({ action: z.literal('delete'), sessionId }).strict()
]);
export type SessionMetadataOperation = z.infer<typeof SessionMetadataOperationSchema>;
export const SessionMetadataResultSchema = z.union([SessionMetaSchema, z.array(SessionMetaSchema), z.null()]);
export type SessionMetadataResult = z.infer<typeof SessionMetadataResultSchema>;

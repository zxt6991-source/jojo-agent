import { z } from 'zod';

// Documents live in conversation history until the user explicitly exports them.
export const GeneratedDocumentSchema = z.object({
  name: z.string().min(1).max(180).regex(/^[^/\\]+\.html?$/i)
    .refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32), 'Filename must not contain control characters'),
  content: z.string().min(1).max(2_000_000)
}).strict();

export type GeneratedDocument = z.infer<typeof GeneratedDocumentSchema>;

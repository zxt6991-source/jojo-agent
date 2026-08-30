import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown()
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string().regex(/^image\//u),
    altText: z.string().optional()
  })
]);
export type ToolResultContentBlock = z.infer<typeof ToolResultContentBlockSchema>;

export const ToolResultSchema = z.object({
  callId: z.string().min(1),
  ok: z.boolean(),
  content: z.string(),
  structuredResult: z.unknown().optional(),
  contentBlocks: z.array(ToolResultContentBlockSchema).optional(),
  truncated: z.boolean().optional(),
  code: z.string().optional()
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ImageContentBlockSchema = z.object({
  type: z.literal('image'),
  data: z.string().min(1).max(14_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  mimeType: z.string().regex(/^image\/(?:png|jpeg|webp|gif)$/u),
  name: z.string().trim().min(1).max(255).optional(),
  altText: z.string().max(2_000).optional()
});
export type ImageContentBlock = z.infer<typeof ImageContentBlockSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  ImageContentBlockSchema,
  z.object({ type: z.literal('tool_call'), call: ToolCallSchema }),
  z.object({ type: z.literal('tool_result'), result: ToolResultSchema })
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.array(ContentBlockSchema),
  createdAt: z.string().datetime(),
  metadata: z.object({
    internal: z.boolean().optional(),
    iteration: z.number().int().positive().optional(),
    finalResponseOnly: z.boolean().optional(),
    source: z.literal('scheduler').optional(),
    automation: z.object({
      scheduleId: z.string().min(1).max(256),
      scheduleRunId: z.string().min(1).max(256),
      name: z.string().min(1).max(256),
      triggeredAt: z.string().datetime()
    }).strict().optional()
  }).optional()
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationMessageCreatedEventSchema = z.object({
  sessionId: z.string().min(1).max(256),
  messageId: z.string().min(1).max(256),
  scheduleId: z.string().min(1).max(256),
  scheduleRunId: z.string().min(1).max(256)
}).strict();
export type ConversationMessageCreatedEvent = z.infer<typeof ConversationMessageCreatedEventSchema>;

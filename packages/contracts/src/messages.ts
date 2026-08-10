import { z } from 'zod';

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown()
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolResultSchema = z.object({
  callId: z.string().min(1),
  ok: z.boolean(),
  content: z.string(),
  truncated: z.boolean().optional(),
  code: z.string().optional()
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), call: ToolCallSchema }),
  z.object({ type: z.literal('tool_result'), result: ToolResultSchema })
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.array(ContentBlockSchema),
  createdAt: z.string().datetime(),
  metadata: z.object({ internal: z.boolean().optional() }).optional()
});
export type Message = z.infer<typeof MessageSchema>;

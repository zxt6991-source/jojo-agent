import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '@desktop-agent/contracts';
export const ResultReadInput = z.object({
  callId: z.string().min(1).max(256), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(12000).default(6000)
}).strict();
export class ResultReadTool implements Tool {
  readonly risk = 'read' as const;
  readonly replay = 'safe' as const;
  readonly definition = {
    name: 'result_read',
    description: 'Read a bounded character window from the original durable tool output in this session branch, including outputs reclaimed or compacted out of context. Use the callId in the reclaimed reference. Offsets are zero-based UTF-16 characters. No cross-session access.',
    inputSchema: { type: 'object', properties: { callId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 12000 } }, required: ['callId'], additionalProperties: false }
  };
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const parsed = ResultReadInput.parse(input);
    const result = await context.readToolResult?.(parsed.callId);
    if (!result) return { callId: '', ok: false, code: 'result_not_found', content: 'Result is unavailable in the current session branch.' };
    const end = Math.min(result.content.length, parsed.offset + parsed.limit);
    return { callId: '', ok: true, content: result.content.slice(parsed.offset, end),
      structuredResult: { sourceCallId: parsed.callId, offset: parsed.offset, end, totalCharacters: result.content.length, ...(end < result.content.length ? { nextOffset: end } : {}) } };
  }
}

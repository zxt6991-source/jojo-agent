import { z } from 'zod';
import type { ToolResult } from './messages';

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown())
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export type ToolContext = {
  sessionId: string;
  workingDirectory: string;
  signal: AbortSignal;
  approved: boolean;
  onProgress: (text: string) => void;
};

export interface Tool {
  definition: ToolDefinition;
  /**
   * Controls automatic recovery after the runtime stops while this tool may
   * already have produced an external effect. Missing metadata is treated as
   * `never`, the conservative default.
   */
  replay?: 'safe' | 'never';
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

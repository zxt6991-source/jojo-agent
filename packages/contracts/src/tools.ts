import { z } from 'zod';
import type { ToolResult } from './messages';
import type { ExecutionScope } from './execution-scope.js';

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  repeatPolicy: z.enum(['normal', 'bounded', 'polling', 'idempotent-observation']).optional(),
  polling: z.object({
    maxPollsPerInput: z.number().int().positive().optional(),
    maxDurationMs: z.number().int().positive().optional(),
    minIntervalMs: z.number().int().nonnegative().optional()
  }).optional()
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export type ToolContext = {
  sessionId: string;
  workingDirectory: string;
  /** Phase-A runtime scope; workingDirectory remains available for compatibility. */
  executionScope?: ExecutionScope;
  signal: AbortSignal;
  approved: boolean;
  onProgress: (text: string) => void;
};

export type ToolRepeatPolicy = 'normal' | 'bounded' | 'polling' | 'idempotent-observation';

export type ToolPollingPolicy = {
  /** Maximum polls with the same canonical input in one operation. */
  maxPollsPerInput?: number;
  /** Maximum elapsed time for polls with the same canonical input. */
  maxDurationMs?: number;
  /** Optional minimum interval. Calls made sooner are rejected, never delayed. */
  minIntervalMs?: number;
};

export const ToolRiskSchema = z.enum(['read', 'write', 'external_side_effect']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export interface Tool {
  definition: ToolDefinition;
  /**
   * Controls automatic recovery after the runtime stops while this tool may
   * already have produced an external effect. Missing metadata is treated as
   * `never`, the conservative default.
   */
  replay?: 'safe' | 'never';
  /**
   * Controls duplicate-call protection within one agent operation. Polling
   * tools may legitimately use identical input while waiting for background
   * work to change state; all other tools keep the bounded default.
   */
  repeatPolicy?: ToolRepeatPolicy;
  /** Additional bounded policy for tools explicitly marked as polling. */
  polling?: ToolPollingPolicy;
  /** Runtime/permission metadata; never exposed as part of the model-facing definition. */
  risk?: ToolRisk;
  /** Semantic effects consumed by runtime capabilities, for example `memory.write`. */
  effects?: string[];
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

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
  toolCallId?: string;
  workingDirectory: string;
  /** Phase-A runtime scope; workingDirectory remains available for compatibility. */
  executionScope?: ExecutionScope;
  signal: AbortSignal;
  approved: boolean;
  /** Trusted Host provenance; never part of a model tool input. */
  mutationProvenance?: { runId: string; operationId: string; actor: import('./hooks.js').HookEnvelope['agent'] };
  /** Scoped by the host to the current session and branch, including pre-compaction history. */
  runVerificationChecks?: (input: { batchId: string; checkIds?: string[] }) => Promise<ToolResult[]>;
  readVerificationBatch?: (id: string) => Promise<import('./verification.js').VerificationBatch | undefined>;
  isVerificationCurrent?: (callId: string) => Promise<boolean>;
  readToolResult?: (callId: string) => Promise<ToolResult | undefined>;
  searchSessionHistory?: (query: import('./session-history.js').SessionSearchQuery) => Promise<import('./session-history.js').SessionSearchHit[]>;
  readSessionHistoryWindow?: (query: import('./session-history.js').SessionReadWindowQuery) => Promise<import('./session-history.js').SessionReadWindow>;
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
  /** Trusted Host read-only evidence port; never exposed in a tool schema. */
  captureWorkspaceRevision?: import('./verification.js').WorkspaceRevisionCapture;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

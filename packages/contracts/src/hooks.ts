import { z } from 'zod';
import { ToolResultSchema, type ToolResult } from './messages.js';

export const HookEventNameSchema = z.enum([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact'
]);
export type HookEventName = z.infer<typeof HookEventNameSchema>;

export const InjectingHookEventSchema = z.enum(['SessionStart', 'UserPromptSubmit', 'PostToolUse']);
export type InjectingHookEvent = z.infer<typeof InjectingHookEventSchema>;
export const SideEffectHookEventSchema = z.enum(['Stop', 'SubagentStop', 'PreCompact']);
export type SideEffectHookEvent = z.infer<typeof SideEffectHookEventSchema>;
export type HookTransport = 'desktop' | 'cli' | 'server' | 'im' | 'unknown';
export type HookSource = 'builtin' | 'user' | 'project';

export const HookEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  event: HookEventNameSchema,
  timestamp: z.string().datetime(),
  sessionId: z.string().min(1),
  operationId: z.string().min(1),
  lane: z.string().min(1),
  agent: z.object({
    kind: z.enum(['main', 'subagent', 'workflow']),
    id: z.string().optional(),
    profile: z.string().optional()
  }),
  workflow: z.object({ runId: z.string(), stepId: z.string().optional() }).optional(),
  workingDirectory: z.string().min(1),
  provider: z.object({ id: z.string().min(1), model: z.string().min(1) }),
  transport: z.enum(['desktop', 'cli', 'server', 'im', 'unknown'])
});
export type HookEnvelope = z.infer<typeof HookEnvelopeSchema>;

export const SessionStartPayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('SessionStart'),
  source: z.enum(['startup', 'resume', 'new'])
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const UserPromptSubmitPayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('UserPromptSubmit'),
  userInput: z.string()
});
export type UserPromptSubmitPayload = z.infer<typeof UserPromptSubmitPayloadSchema>;

export const PreToolUsePayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('PreToolUse'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.unknown()
});
export type PreToolUsePayload = z.infer<typeof PreToolUsePayloadSchema>;

export const PostToolUsePayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('PostToolUse'),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.unknown(),
  toolResult: ToolResultSchema
});
export type PostToolUsePayload = z.infer<typeof PostToolUsePayloadSchema>;

export const StopPayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('Stop'),
  stopReason: z.string(),
  finalText: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  toolsUsed: z.array(z.string())
});
export type StopPayload = z.infer<typeof StopPayloadSchema>;

export const SubagentStopPayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('SubagentStop'),
  subagentId: z.string().min(1),
  profile: z.string().min(1),
  state: z.enum(['completed', 'failed', 'cancelled']),
  result: z.string().optional()
});
export type SubagentStopPayload = z.infer<typeof SubagentStopPayloadSchema>;

export const PreCompactPayloadSchema = HookEnvelopeSchema.extend({
  event: z.literal('PreCompact'),
  estimatedTokens: z.number().nonnegative(),
  messageCount: z.number().int().nonnegative()
});
export type PreCompactPayload = z.infer<typeof PreCompactPayloadSchema>;

export type HookPayloadMap = {
  SessionStart: SessionStartPayload;
  UserPromptSubmit: UserPromptSubmitPayload;
  PreToolUse: PreToolUsePayload;
  PostToolUse: PostToolUsePayload;
  Stop: StopPayload;
  SubagentStop: SubagentStopPayload;
  PreCompact: PreCompactPayload;
};

export const HookInjectionResultSchema = z.object({
  additionalContext: z.string().default(''),
  hookIds: z.array(z.string()).optional()
});
export type HookInjectionResult = z.infer<typeof HookInjectionResultSchema>;

export const PreToolUseHookResultSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('neutral') }),
  z.object({ decision: z.literal('approve'), reason: z.string().optional(), canSkipApproval: z.boolean().optional() }),
  z.object({ decision: z.literal('block'), reason: z.string().min(1) })
]);
export type PreToolUseHookResult = z.infer<typeof PreToolUseHookResultSchema>;

export const HookSpecSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/u),
  command: z.string().trim().min(1),
  matcher: z.string().optional(),
  timeout: z.string().default('5s'),
  async: z.boolean().default(false),
  onError: z.enum(['continue', 'block']).default('continue'),
  canApprove: z.boolean().default(false),
  env: z.record(z.string(), z.string()).optional()
});
export type HookSpec = z.infer<typeof HookSpecSchema>;

export const HookFileConfigSchema = z.object({
  version: z.literal(1),
  hooks: z.partialRecord(HookEventNameSchema, z.array(HookSpecSchema)).default({})
});
export type HookFileConfig = z.infer<typeof HookFileConfigSchema>;

export const HookCommandSummarySchema = z.object({
  event: HookEventNameSchema,
  id: z.string(),
  command: z.string(),
  canApprove: z.boolean()
});
export type HookCommandSummary = z.infer<typeof HookCommandSummarySchema>;

export const HookConfigStatusSchema = z.object({
  source: z.enum(['user', 'project']),
  path: z.string(),
  state: z.enum(['missing', 'loaded', 'untrusted', 'invalid', 'disabled']),
  fingerprint: z.string().optional(),
  commands: z.array(HookCommandSummarySchema).optional(),
  error: z.string().optional()
});
export type HookConfigStatus = z.infer<typeof HookConfigStatusSchema>;

export const HookSettingsSnapshotSchema = z.object({
  user: HookConfigStatusSchema,
  project: HookConfigStatusSchema.optional()
});
export type HookSettingsSnapshot = z.infer<typeof HookSettingsSnapshotSchema>;

export const HookErrorCodeSchema = z.enum([
  'hook_timeout', 'hook_spawn_failed', 'hook_exit_nonzero',
  'hook_invalid_output', 'hook_output_too_large', 'hook_config_invalid',
  'hook_untrusted', 'hook_cancelled', 'hook_internal_error'
]);
export type HookErrorCode = z.infer<typeof HookErrorCodeSchema>;

export type HookFailure = { code: HookErrorCode; message: string };
export type HookInvocationRecord = {
  id: string;
  eventId: string;
  hookId: string;
  event: HookEventName;
  sessionId: string;
  operationId: string;
  subjectId: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  payload?: unknown;
  error?: HookFailure;
};

export interface HookInvocationStore {
  getInvocation(id: string): Promise<HookInvocationRecord | undefined>;
  beginInvocation(record: HookInvocationRecord): Promise<'created' | 'exists'>;
  completeInvocation(id: string, result: unknown): Promise<void>;
  failInvocation(id: string, error: HookFailure): Promise<void>;
  listIncomplete?(): Promise<HookInvocationRecord[]>;
}

export interface HookRuntime {
  configured(event: HookEventName): boolean;
  inject<E extends InjectingHookEvent>(event: E, payload: HookPayloadMap[E]): Promise<HookInjectionResult>;
  preToolUse(payload: PreToolUsePayload): Promise<PreToolUseHookResult>;
  dispatch<E extends SideEffectHookEvent>(event: E, payload: HookPayloadMap[E]): Promise<void>;
}

export class NoopHookRuntime implements HookRuntime {
  static readonly instance = new NoopHookRuntime();
  configured(): boolean { return false; }
  async inject(): Promise<HookInjectionResult> { return { additionalContext: '' }; }
  async preToolUse(): Promise<PreToolUseHookResult> { return { decision: 'neutral' }; }
  async dispatch(): Promise<void> { /* no-op */ }
}

export type HookHandlerResult<E extends HookEventName> =
  E extends PreToolUsePayload['event'] ? PreToolUseHookResult
    : E extends InjectingHookEvent ? HookInjectionResult
      : void;
export type HookHandler<E extends HookEventName> = (
  payload: HookPayloadMap[E],
  context: HookContext
) => Promise<HookHandlerResult<E>> | HookHandlerResult<E>;

export type HookContext = {
  sessionId: string;
  operationId: string;
  lane: string;
  workingDirectory: string;
  providerId: string;
  model: string;
  signal: AbortSignal;
  agent: HookEnvelope['agent'];
  logger: HookLogger;
};

export interface HookLogger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export type { ToolResult };
